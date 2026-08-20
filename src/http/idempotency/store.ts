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
} from "./schema.ts";
import { JsonValue, type Json } from "../../contracts/json.ts";
import type { ErrorResponse } from "../../contracts/protocol.ts";
import type { DB } from "../../platform/persistence/database.ts";
import { idempotency_request } from "../../platform/persistence/schema.ts";
import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import { failure, json, type JsonResponse } from "../respond.ts";

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
/**
 * Span ingest, which is idempotent in the table rather than in this record.
 *
 * `span` is keyed on `(trace_id, span_id)` and written `ON CONFLICT DO NOTHING`,
 * so the same export arriving twice writes the same rows and there is no second
 * side effect for a record to protect. Requiring a key here would only break the
 * caller: an OTLP client sends no `Idempotency-Key` and cannot be made to send a
 * fresh one per batch, so every export would be rejected with 400.
 */
const TRACES_PATH = "/api/v1/traces";
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

/**
 * The stored state, narrowed on the way out of a plain `text` column.
 *
 * A row written by an older build can hold a word this build has never heard of,
 * and the one thing that must not happen to it is being mistaken for absent: a
 * missing record makes the key claimable again and runs the side effect twice.
 * `failed` is the honest reading — outcome unknown, recovery decides.
 */
const RECORD_STATES = ["in_progress", "completed", "failed"] as const;
const recordState = (raw: string): IdempotencyRecordState => RECORD_STATES.find((s) => s === raw) ?? "failed";

const storedColumns = {
  payload_hash: idempotency_request.payload_hash,
  state: idempotency_request.state,
  status: idempotency_request.status,
  body: idempotency_request.body,
  content_type: idempotency_request.content_type,
  updated_at: idempotency_request.updated_at,
};

const identity = (who: string, route: string, key: string) =>
  and(eq(idempotency_request.caller, who), eq(idempotency_request.route, route), eq(idempotency_request.key, key));

async function lookup(db: DB, who: string, route: string, key: string): Promise<Stored | null> {
  const [row] = await db
    .select(storedColumns)
    .from(idempotency_request)
    .where(identity(who, route, key));
  return row ? { ...row, state: recordState(row.state) } : null;
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

/**
 * Claim the key, or report who holds it. `null` means this request owns it.
 *
 * The conflict target is the primary key, spelled out: `ON CONFLICT` naming the
 * wrong columns raises instead of yielding, and the caller's retry path then runs
 * the side effect a second time — which is the one thing this table exists to
 * prevent. `RETURNING` is how many rows were inserted; there is no `changes`.
 */
async function reserve(db: DB, claim: Claim): Promise<Stored | null> {
  const inserted = await db
    .insert(idempotency_request)
    .values({
      caller: claim.who,
      route: claim.route,
      key: claim.key,
      payload_hash: claim.payloadHash,
      state: "in_progress",
      created_at: claim.now,
      updated_at: claim.now,
    })
    .onConflictDoNothing({
      target: [idempotency_request.caller, idempotency_request.route, idempotency_request.key],
    })
    .returning({ key: idempotency_request.key });
  if (inserted.length === 1) return null;
  // It conflicted, so a row was there. If `cleanup` has since dropped an expired
  // one, the claim is unowned and this request takes it — which is what an
  // expired record means.
  return await lookup(db, claim.who, claim.route, claim.key);
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

async function finish(db: DB, claim: Claim, response: Response, body: string): Promise<void> {
  await db
    .update(idempotency_request)
    .set({
      state: "completed",
      status: response.status,
      body,
      content_type: response.headers.get("content-type"),
      updated_at: Date.now(),
    })
    .where(and(identity(claim.who, claim.route, claim.key), eq(idempotency_request.state, "in_progress")));
}

async function failUnknown(db: DB, claim: Claim): Promise<void> {
  await db
    .update(idempotency_request)
    .set({ state: "failed", updated_at: Date.now() })
    .where(and(identity(claim.who, claim.route, claim.key), eq(idempotency_request.state, "in_progress")));
}

/** How many completed records are kept once the age cut has run. */
const KEEP_COMPLETED = 10_000;

async function cleanup(db: DB, now: number): Promise<void> {
  // Unknown outcomes are recovery work, not history. Dropping one makes the same
  // key executable again and can duplicate a side effect that actually committed.
  const completed = eq(idempotency_request.state, "completed");
  await db.delete(idempotency_request).where(and(completed, lt(idempotency_request.updated_at, now - MAX_AGE_MS)));
  // The count cap, as the timestamp of the newest row past it. SQLite deleted by
  // `rowid` and Postgres has none; a tie on the millisecond leaves a few extra
  // rows, which is a cap doing its job rather than an off-by-one.
  const [cut] = await db
    .select({ at: idempotency_request.updated_at })
    .from(idempotency_request)
    .where(completed)
    .orderBy(desc(idempotency_request.updated_at))
    .limit(1)
    .offset(KEEP_COMPLETED);
  if (cut) await db.delete(idempotency_request).where(and(completed, lt(idempotency_request.updated_at, cut.at)));
}

function missingRecovery(): MissingRecoveryResponse {
  return failure("no idempotency record for this caller, route, and key", 404, "idempotency_not_found");
}

export async function idempotencyStatus(db: DB, id: IdempotencyIdentity): Promise<IdempotencyStatusResponse> {
  const { caller: who, route, key } = id;
  const row = await lookup(db, who, route, key);
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

export async function operatorIdempotencyStatus(
  db: DB,
  query: IdempotencyStatus,
): Promise<OperatorIdempotencyStatusResponse> {
  const id = IdempotencyIdentitySchema.safeParse(query);
  if (id.success) return await idempotencyStatus(db, id.data);
  const now = Date.now();
  const rows = await db
    .select({
      caller: idempotency_request.caller,
      route: idempotency_request.route,
      key: idempotency_request.key,
      state: idempotency_request.state,
      updated_at: idempotency_request.updated_at,
    })
    .from(idempotency_request)
    .where(inArray(idempotency_request.state, ["failed", "in_progress"]))
    // `rowid` was the tiebreak; the key is what Postgres has that is as stable.
    .orderBy(
      asc(idempotency_request.updated_at),
      asc(idempotency_request.caller),
      asc(idempotency_request.route),
      asc(idempotency_request.key),
    )
    .limit(100);
  const records = rows.map((record) => ({
    caller: record.caller,
    route: record.route,
    key: record.key,
    state: recordState(record.state),
    updated_at: record.updated_at,
    recoverable: record.state === "failed" || now - record.updated_at >= RECOVERY_DELAY_MS,
  }));
  return json<IdempotencyUnresolvedList>({ records });
}

export async function recoverIdempotency(db: DB, input: IdempotencyRecovery): Promise<IdempotencyRecoveryResponse> {
  const { caller: who, route, key, status: responseStatus, body } = input;
  if (!isIdempotencyRecoveryStatus(responseStatus)) {
    return failure("recovery status must allow a JSON response body", 400, "invalid_recovery_status");
  }
  const row = await lookup(db, who, route, key);
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
  // `updated_at` in the predicate is the optimistic lock: it is the row this
  // caller inspected, not merely one with the same key.
  const updated = await db
    .update(idempotency_request)
    .set({
      state: "completed",
      status: responseStatus,
      body: encoded,
      content_type: "application/json",
      updated_at: Date.now(),
    })
    .where(
      and(
        identity(who, route, key),
        inArray(idempotency_request.state, ["failed", "in_progress"]),
        eq(idempotency_request.updated_at, row.updated_at),
      ),
    )
    .returning({ key: idempotency_request.key });
  const resolved = await lookup(db, who, route, key);
  if (!resolved) return missingRecovery();
  if (updated.length !== 1 && resolved.state !== "completed") {
    return failure("the idempotency record changed; inspect it again before resolving", 409, "idempotency_changed", {
      caller: who,
      recovery_url: recoveryUrl(who, route, key),
    });
  }
  const response = replayRecoveredJson(resolved, key);
  if (updated.length === 1) response.headers.set("Idempotency-Recovered", "true");
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

type Clean = (now: number) => Promise<void>;

async function execute(db: DB, c: Context, next: Next, claim: Claim, clean: Clean): Promise<void> {
  try {
    await next();
    if (c.error) {
      await failUnknown(db, claim);
      c.header("Idempotency-Key", claim.key);
      return;
    }
    const response = c.res.clone();
    await finish(db, claim, response, await response.text());
    c.header("Idempotency-Key", claim.key);
  } catch (error) {
    await failUnknown(db, claim);
    throw error;
  }
  await clean(claim.now);
}

async function mutation(db: DB, c: Context, next: Next, clean: Clean): Promise<Response | void> {
  const claim = await requestClaim(c, Date.now());
  if (claim instanceof Response) return claim;
  const row = await reserve(db, claim);
  if (row) return existing(row, claim);
  return await execute(db, c, next, claim, clean);
}

async function dispatch(db: DB, c: Context, next: Next, clean: Clean): Promise<Response | void> {
  // Recovery records the externally reconciled outcome. It must not create a
  // second idempotency record whose own crash would require recursive recovery.
  if (c.req.method === "POST" && (c.req.path === RECOVER_PATH || c.req.path === TRACES_PATH)) return await next();
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
  const clean = async (now: number): Promise<void> => {
    if (now < cleanupAt) return;
    cleanupAt = now + 60_000;
    await cleanup(db, now);
  };
  return createMiddleware((c, next) => dispatch(db, c, next, clean));
}
