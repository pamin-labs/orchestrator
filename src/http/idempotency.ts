import type { Context, Next } from "hono";
import { createMiddleware } from "hono/factory";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  IdempotencyIdentitySchema,
  type IdempotencyIdentity,
  type IdempotencyRecordState,
  type IdempotencyRecordStatus,
  type IdempotencyRecovery,
  type IdempotencyStatus,
  type IdempotencyUnresolvedList,
  isIdempotencyRecoveryStatus,
} from "../contracts/idempotency.ts";
import { JsonValue, type Json } from "../contracts/json.ts";
import type { ErrorResponse } from "../contracts/protocol.ts";
import type { DB } from "../db.ts";
import { failure, json, type JsonResponse } from "./respond.ts";

type Stored = {
  payload_hash: string;
  state: IdempotencyRecordState;
  status: number | null;
  body: string | null;
  content_type: string | null;
  updated_at: number;
};

export type MissingRecoveryResponse = JsonResponse<ErrorResponse, 404>;
export type IdempotencyStatusResponse = JsonResponse<IdempotencyRecordStatus> | MissingRecoveryResponse;
export type OperatorIdempotencyStatusResponse = IdempotencyStatusResponse | JsonResponse<IdempotencyUnresolvedList>;
export type RecoveredJsonResponse = JsonResponse<Json, ContentfulStatusCode>;
export type IdempotencyRecoveryResponse =
  | RecoveredJsonResponse
  | MissingRecoveryResponse
  | JsonResponse<ErrorResponse, 400 | 409 | 500>;

const MUTATION = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const RECOVERY_DELAY_MS = 5 * 60 * 1_000;
const RECOVER_PATH = "/api/v1/idempotency/recover";
export const JSON_BODY_LIMIT = 1024 * 1024;

function sha256(value: string | ArrayBuffer): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export function idempotencyCaller(req: Request): string {
  const token = req.headers.get("x-orch-token");
  return token ? `agent:${sha256(token).slice(0, 24)}` : "boss";
}

function replay(row: Stored, key: string): Response {
  return new Response(row.body ?? "", {
    status: row.status ?? 200,
    headers: {
      ...(row.content_type ? { "content-type": row.content_type } : {}),
      "Idempotency-Key": key,
      "Idempotency-Replayed": "true",
    },
  });
}

function replayRecoveredJson(row: Stored, key: string): RecoveredJsonResponse | JsonResponse<ErrorResponse, 500> {
  if (row.status === null || !isIdempotencyRecoveryStatus(row.status)) {
    return failure("stored idempotency response has an unsupported status", 500, "invalid_idempotency_response");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(row.body ?? "");
  } catch {
    return failure("stored idempotency response is not valid JSON", 500, "invalid_idempotency_response");
  }
  const parsed = JsonValue.safeParse(decoded);
  if (!parsed.success) {
    return failure("stored idempotency response is not valid JSON", 500, "invalid_idempotency_response");
  }
  const response = json(parsed.data, row.status);
  response.headers.set("Idempotency-Key", key);
  response.headers.set("Idempotency-Replayed", "true");
  return response;
}

function lookup(db: DB, who: string, route: string, key: string): Stored | null {
  return (
    db
      .query<Stored, [string, string, string]>(
        `SELECT payload_hash, state, status, body, content_type, updated_at
         FROM idempotency_request WHERE caller = ? AND route = ? AND key = ?`,
      )
      .get(who, route, key) ?? null
  );
}

function recoveryUrl(caller: string, route: string, key: string): string {
  return `/api/v1/idempotency/status?${new URLSearchParams({ caller, route, key })}`;
}

type Claim = {
  who: string;
  route: string;
  key: string;
  payloadHash: string;
  now: number;
};

function reserve(db: DB, claim: Claim): Stored | null {
  const inserted = db.run(
    `INSERT OR IGNORE INTO idempotency_request
       (caller, route, key, payload_hash, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'in_progress', ?, ?)`,
    [claim.who, claim.route, claim.key, claim.payloadHash, claim.now, claim.now],
  );
  if (inserted.changes === 1) return null;
  return db
    .query<Stored, [string, string, string]>(
      `SELECT payload_hash, state, status, body, content_type, updated_at
       FROM idempotency_request WHERE caller = ? AND route = ? AND key = ?`,
    )
    .get(claim.who, claim.route, claim.key)!;
}

function claimedResponse(row: Stored, claim: Claim): Response {
  if (row.payload_hash !== claim.payloadHash) {
    return failure("Idempotency-Key was already used with a different payload", 409, "idempotency_conflict");
  }
  if (row.state === "completed") return replay(row, claim.key);
  const statusUrl = recoveryUrl(claim.who, claim.route, claim.key);
  const response =
    row.state === "failed"
      ? failure("the previous request failed before its outcome was known", 409, "idempotency_failed", {
          caller: claim.who,
          recovery_url: statusUrl,
        })
      : failure("an identical request is still in progress", 409, "idempotency_in_progress", {
          caller: claim.who,
          recovery_url: statusUrl,
        });
  response.headers.set("Idempotency-Key", claim.key);
  return response;
}

function finish(db: DB, claim: Claim, response: Response, body: string): void {
  db.run(
    `UPDATE idempotency_request
     SET state = 'completed', status = ?, body = ?, content_type = ?, updated_at = ?
     WHERE caller = ? AND route = ? AND key = ? AND state = 'in_progress'`,
    [response.status, body, response.headers.get("content-type"), Date.now(), claim.who, claim.route, claim.key],
  );
}

function failUnknown(db: DB, claim: Claim): void {
  db.run(
    `UPDATE idempotency_request SET state = 'failed', updated_at = ?
     WHERE caller = ? AND route = ? AND key = ? AND state = 'in_progress'`,
    [Date.now(), claim.who, claim.route, claim.key],
  );
}

function cleanup(db: DB, now: number): void {
  // Unknown outcomes are recovery work, not history. Dropping one makes the same
  // key executable again and can duplicate a side effect that actually committed.
  db.run("DELETE FROM idempotency_request WHERE state = 'completed' AND updated_at < ?", [now - MAX_AGE_MS]);
  db.run(
    `DELETE FROM idempotency_request WHERE rowid IN (
       SELECT rowid FROM idempotency_request WHERE state = 'completed'
       ORDER BY updated_at DESC LIMIT -1 OFFSET 10000
     )`,
  );
}

function missingRecovery(): MissingRecoveryResponse {
  return failure("no idempotency record for this caller, route, and key", 404, "idempotency_not_found");
}

export function idempotencyStatus(db: DB, identity: IdempotencyIdentity): IdempotencyStatusResponse {
  const { caller: who, route, key } = identity;
  const row = lookup(db, who, route, key);
  if (!row) return missingRecovery();
  const response = json<IdempotencyRecordStatus>({
    caller: who,
    key,
    route,
    state: row.state,
    updated_at: row.updated_at,
    replayable: row.state === "completed",
  });
  response.headers.set("Idempotency-Key", key);
  return response;
}

export function operatorIdempotencyStatus(db: DB, query: IdempotencyStatus): OperatorIdempotencyStatusResponse {
  const identity = IdempotencyIdentitySchema.safeParse(query);
  if (identity.success) return idempotencyStatus(db, identity.data);
  const now = Date.now();
  const records = db
    .query<Pick<Stored, "state" | "updated_at"> & { caller: string; route: string; key: string }, []>(
      `SELECT caller, route, key, state, updated_at
       FROM idempotency_request
       WHERE state IN ('failed', 'in_progress')
       ORDER BY updated_at ASC
       LIMIT 100`,
    )
    .all()
    .map((record) => ({
      caller: record.caller,
      route: record.route,
      key: record.key,
      state: record.state,
      updated_at: record.updated_at,
      recoverable: record.state === "failed" || now - record.updated_at >= RECOVERY_DELAY_MS,
    }));
  return json<IdempotencyUnresolvedList>({ records });
}

export function recoverIdempotency(db: DB, input: IdempotencyRecovery): IdempotencyRecoveryResponse {
  const { caller: who, route, key, status: responseStatus, body } = input;
  if (!isIdempotencyRecoveryStatus(responseStatus)) {
    return failure("recovery status must allow a JSON response body", 400, "invalid_recovery_status");
  }
  const row = lookup(db, who, route, key);
  if (!row) return missingRecovery();
  if (row.state === "completed") return replayRecoveredJson(row, key);
  if (row.state === "in_progress" && Date.now() - row.updated_at < RECOVERY_DELAY_MS) {
    const response = failure(
      "the original request is still active; inspect it again before resolving its outcome",
      409,
      "idempotency_recovery_not_ready",
      { caller: who, recovery_url: recoveryUrl(who, route, key) },
    );
    response.headers.set("Idempotency-Key", key);
    return response;
  }

  const encoded = JSON.stringify(body);
  const updated = db.run(
    `UPDATE idempotency_request
     SET state = 'completed', status = ?, body = ?, content_type = 'application/json', updated_at = ?
     WHERE caller = ? AND route = ? AND key = ? AND state IN ('failed', 'in_progress') AND updated_at = ?`,
    [responseStatus, encoded, Date.now(), who, route, key, row.updated_at],
  );
  const resolved = lookup(db, who, route, key);
  if (!resolved) return missingRecovery();
  if (updated.changes !== 1 && resolved.state !== "completed") {
    return failure("the idempotency record changed; inspect it again before resolving", 409, "idempotency_changed", {
      caller: who,
      recovery_url: recoveryUrl(who, route, key),
    });
  }
  const response = replayRecoveredJson(resolved, key);
  if (updated.changes === 1) response.headers.set("Idempotency-Recovered", "true");
  return response;
}

async function requestClaim(c: Context, now: number): Promise<Claim | Response> {
  const key = c.req.header("idempotency-key")?.trim();
  if (!key) return failure("Idempotency-Key is required", 400, "missing_idempotency_key");
  if (key.length > 128) return failure("Idempotency-Key is too long", 400, "invalid_idempotency_key");
  return {
    who: idempotencyCaller(c.req.raw),
    route: c.req.path,
    key,
    payloadHash: sha256(await c.req.raw.clone().arrayBuffer()),
    now,
  };
}

function existing(row: Stored, claim: Claim): Response {
  const response = claimedResponse(row, claim);
  if (row.state !== "completed" && row.payload_hash === claim.payloadHash) {
    response.headers.set("Idempotency-Recovery", recoveryUrl(claim.who, claim.route, claim.key));
  }
  return response;
}

async function execute(db: DB, c: Context, next: Next, claim: Claim, clean: (now: number) => void): Promise<void> {
  try {
    await next();
    if (c.error) {
      failUnknown(db, claim);
      c.header("Idempotency-Key", claim.key);
      return;
    }
    const response = c.res.clone();
    finish(db, claim, response, await response.text());
    c.header("Idempotency-Key", claim.key);
  } catch (error) {
    failUnknown(db, claim);
    throw error;
  }
  clean(claim.now);
}

async function mutation(db: DB, c: Context, next: Next, clean: (now: number) => void): Promise<Response | void> {
  const claim = await requestClaim(c, Date.now());
  if (claim instanceof Response) return claim;
  const row = reserve(db, claim);
  if (row) return existing(row, claim);
  return await execute(db, c, next, claim, clean);
}

async function dispatch(db: DB, c: Context, next: Next, clean: (now: number) => void): Promise<Response | void> {
  // Recovery records the externally reconciled outcome. It must not create a
  // second idempotency record whose own crash would require recursive recovery.
  if (c.req.method === "POST" && c.req.path === RECOVER_PATH) return await next();
  return MUTATION.has(c.req.method) ? await mutation(db, c, next, clean) : await next();
}

/**
 * One durable owner for HTTP retry semantics.
 *
 * Every mutation supplies its own key so a lost-response retry can recover the
 * first result instead of silently creating a second side effect.
 */
export function idempotency(db: DB) {
  let cleanupAt = 0;
  const clean = (now: number): void => {
    if (now >= cleanupAt) {
      cleanupAt = now + 60_000;
      cleanup(db, now);
    }
  };
  return createMiddleware((c, next) => dispatch(db, c, next, clean));
}
