import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { makeApp } from "../../src/composition/api.ts";
import { IdempotencyRecoveryBody, IdempotencyStatusQuery } from "../../src/http/idempotency/schema.ts";
import { type DB, migrate, migrationMentioning, openMemory } from "../../src/platform/persistence/database.ts";
import {
  idempotency,
  idempotencyCaller,
  operatorIdempotencyStatus,
  recoverIdempotency,
} from "../../src/http/idempotency/store.ts";
import { jsonBody, queryParams } from "../../src/http/validate.ts";
import * as fx from "../support/factories.ts";
import { testContext } from "../support/test-context.ts";

const jsonHeaders = { "content-type": "application/json" };
const WriteResponse = z.object({ write: z.number() });

async function request(app: Hono, key?: string, token?: string, body = "{}"): Promise<Response> {
  return await Promise.resolve(
    app.request("/write", {
      method: "POST",
      headers: {
        ...jsonHeaders,
        ...(key ? { "idempotency-key": key } : {}),
        ...(token ? { "x-orch-token": token } : {}),
      },
      body,
    }),
  );
}

function withRecoveryRoutes(app: Hono, db: DB): void {
  app.use("*", idempotency(db));
  app.get("/api/v1/idempotency/status", queryParams(IdempotencyStatusQuery), (c) =>
    operatorIdempotencyStatus(db, c.req.valid("query")),
  );
  app.post("/api/v1/idempotency/recover", ...jsonBody(IdempotencyRecoveryBody), (c) =>
    recoverIdempotency(db, c.req.valid("json")),
  );
}

async function recoveryStatus(app: Hono, caller: string, route: string, key: string): Promise<Response> {
  const query = new URLSearchParams({ caller, route, key });
  return await Promise.resolve(app.request(`/api/v1/idempotency/status?${query}`));
}

async function recover(
  app: Hono,
  input: { caller: string; route: string; key: string; status: number; body: unknown },
): Promise<Response> {
  return await Promise.resolve(
    app.request("/api/v1/idempotency/recover", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify(input),
    }),
  );
}

function count(db: DB): number {
  return db.query<{ count: number }, []>("SELECT count(*) AS count FROM idempotency_request").get()!.count;
}

test("keys are mandatory, while callers own independent key spaces", async () => {
  const db = openMemory();
  try {
    const app = new Hono();
    let writes = 0;
    withRecoveryRoutes(app, db);
    app.post("/write", (c) => c.json({ write: ++writes }));

    const missing = await request(app);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ code: "missing_idempotency_key" });

    expect(WriteResponse.parse(await (await request(app, "shared", "agent-one")).json()).write).toBe(1);
    expect(WriteResponse.parse(await (await request(app, "shared", "agent-two")).json()).write).toBe(2);
    expect(WriteResponse.parse(await (await request(app, "shared", "agent-one")).json()).write).toBe(1);
    expect(count(db)).toBe(2);

    const oversized = await request(app, "x".repeat(129));
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toMatchObject({ code: "invalid_idempotency_key" });
  } finally {
    db.close();
  }
});

test("an in-progress request blocks its duplicate, then becomes replayable", async () => {
  const db = openMemory();
  try {
    const app = new Hono();
    let writes = 0;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    withRecoveryRoutes(app, db);
    app.post("/write", async (c) => {
      writes += 1;
      entered();
      await held;
      return c.json({ write: writes });
    });

    const first = request(app, "concurrent");
    await started;
    const duplicate = await request(app, "concurrent");
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({
      code: "idempotency_in_progress",
      details: {
        caller: "boss",
        recovery_url: "/api/v1/idempotency/status?caller=boss&route=%2Fwrite&key=concurrent",
      },
    });
    expect(duplicate.headers.get("idempotency-key")).toBe("concurrent");
    expect((await recoveryStatus(app, "boss", "/write", "concurrent")).status).toBe(200);
    expect(
      (await recover(app, { caller: "boss", route: "/write", key: "concurrent", status: 200, body: { write: 99 } }))
        .status,
    ).toBe(409);
    release();
    expect(WriteResponse.parse(await (await first).json()).write).toBe(1);

    const replay = await request(app, "concurrent");
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(WriteResponse.parse(await replay.json()).write).toBe(1);
    expect(writes).toBe(1);
  } finally {
    db.close();
  }
});

test("unknown outcomes require an explicit reconciled result and never execute again", async () => {
  const db = openMemory();
  try {
    const body = JSON.stringify({ value: 1 });
    const hash = new Bun.CryptoHasher("sha256").update(body).digest("hex");
    fx.idempotencyRequest.insert(db, {
      key: "stale",
      payload_hash: hash,
      updated_at: Date.now() - 11 * 60 * 1_000,
    });

    const staleApp = new Hono();
    let staleWrites = 0;
    withRecoveryRoutes(staleApp, db);
    staleApp.post("/write", (c) => c.json({ write: ++staleWrites }));
    const stale = await request(staleApp, "stale", undefined, body);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "idempotency_in_progress" });
    expect(staleWrites).toBe(0);
    expect(await (await recoveryStatus(staleApp, "boss", "/write", "stale")).json()).toMatchObject({
      caller: "boss",
      key: "stale",
      route: "/write",
      state: "in_progress",
      replayable: false,
    });
    const recoveredStale = await recover(staleApp, {
      caller: "boss",
      route: "/write",
      key: "stale",
      status: 200,
      body: { write: 7 },
    });
    expect(recoveredStale.status).toBe(200);
    expect(recoveredStale.headers.get("idempotency-recovered")).toBe("true");
    expect(await recoveredStale.json()).toEqual({ write: 7 });
    expect(WriteResponse.parse(await (await request(staleApp, "stale", undefined, body)).json()).write).toBe(7);
    expect(staleWrites).toBe(0);

    const failureApp = new Hono();
    let attempts = 0;
    withRecoveryRoutes(failureApp, db);
    failureApp.post("/write", (c) => {
      attempts += 1;
      return attempts === 1 ? c.json({ attempt: attempts }, 503) : c.json({ attempt: attempts });
    });
    expect((await request(failureApp, "retry-503")).status).toBe(503);
    const replayedFailure = await request(failureApp, "retry-503");
    expect(replayedFailure.status).toBe(503);
    expect(replayedFailure.headers.get("idempotency-replayed")).toBe("true");
    expect(await replayedFailure.json()).toEqual({ attempt: 1 });
    expect(attempts).toBe(1);

    const thrownApp = new Hono();
    let throws = 0;
    withRecoveryRoutes(thrownApp, db);
    thrownApp.onError(() => new Response("failed", { status: 500 }));
    thrownApp.post("/write", (c) => {
      throws += 1;
      throw new Error("boom");
    });
    expect((await request(thrownApp, "retry-throw")).status).toBe(500);
    const unknown = await request(thrownApp, "retry-throw");
    expect(unknown.status).toBe(409);
    expect(await unknown.json()).toMatchObject({ code: "idempotency_failed" });
    expect(
      (
        await recover(thrownApp, {
          caller: "agent:000000000000000000000000",
          route: "/write",
          key: "retry-throw",
          status: 200,
          body: { error: "wrong caller" },
        })
      ).status,
    ).toBe(404);

    db.run("UPDATE idempotency_request SET updated_at = 0 WHERE caller = 'boss' AND key = 'retry-throw'");
    const cleanupApp = new Hono();
    withRecoveryRoutes(cleanupApp, db);
    cleanupApp.post("/write", (c) => c.json({ write: 1 }));
    expect((await request(cleanupApp, "cleanup-trigger")).status).toBe(200);
    expect(
      db
        .query<{ state: string }, []>(
          "SELECT state FROM idempotency_request WHERE caller = 'boss' AND route = '/write' AND key = 'retry-throw'",
        )
        .get(),
    ).toEqual({ state: "failed" });

    const contentless = await recover(thrownApp, {
      caller: "boss",
      route: "/write",
      key: "retry-throw",
      status: 204,
      body: { error: "a contentless status cannot carry this outcome" },
    });
    expect(contentless.status).toBe(400);
    expect(await contentless.json()).toMatchObject({ code: "invalid_recovery_status" });
    expect(
      db
        .query<{ state: string }, []>(
          "SELECT state FROM idempotency_request WHERE caller = 'boss' AND route = '/write' AND key = 'retry-throw'",
        )
        .get(),
    ).toEqual({ state: "failed" });

    const resolvedFailure = await recover(thrownApp, {
      caller: "boss",
      route: "/write",
      key: "retry-throw",
      status: 503,
      body: { error: "operator confirmed the upstream outcome" },
    });
    expect(resolvedFailure.status).toBe(503);
    expect(resolvedFailure.headers.get("idempotency-recovered")).toBe("true");
    const replayedResolution = await request(thrownApp, "retry-throw");
    expect(replayedResolution.status).toBe(503);
    expect(await replayedResolution.json()).toEqual({ error: "operator confirmed the upstream outcome" });
    expect(throws).toBe(1);
  } finally {
    db.close();
  }
});

test("the panel resolves an agent caller while the agent can only inspect its own record", async () => {
  const ctx = testContext();
  const token = "tok-idempotency-agent";
  const caller = idempotencyCaller(new Request("http://x", { headers: { "x-orch-token": token } }));
  const p = fx.project.insert(ctx.db, { name: "p" });
  const g = fx.runningGrp.insert(ctx.db, { project_id: p.id, name: "g" });
  fx.agent.insert(ctx.db, { project_id: p.id, grp_id: g.id, token });
  fx.idempotencyRequest.insert(ctx.db, {
    caller,
    route: "/orch/v1/status",
    key: "agent-unknown",
    state: "failed",
  });
  const app = makeApp(ctx);
  const identity = new URLSearchParams({ caller, route: "/orch/v1/status", key: "agent-unknown" });
  const ownIdentity = new URLSearchParams({ route: "/orch/v1/status", key: "agent-unknown" });
  const body = JSON.stringify({
    caller,
    route: "/orch/v1/status",
    key: "agent-unknown",
    status: 202,
    body: { reconciled: true },
  });

  try {
    const unresolved = await app(new Request("http://127.0.0.1/api/v1/idempotency/status"));
    expect(await unresolved.json()).toMatchObject({
      records: [{ caller, route: "/orch/v1/status", key: "agent-unknown", state: "failed", recoverable: true }],
    });

    const own = await app(
      new Request(`http://127.0.0.1/orch/v1/idempotency/status?${ownIdentity}`, {
        headers: { "x-orch-token": token },
      }),
    );
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({ caller, state: "failed" });

    const selected = await app(new Request(`http://127.0.0.1/api/v1/idempotency/status?${identity}`));
    expect(selected.status).toBe(200);
    expect(await selected.json()).toMatchObject({ caller, state: "failed" });

    const crossSite = await app(
      new Request("http://127.0.0.1/api/v1/idempotency/recover", {
        method: "POST",
        headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
        body,
      }),
    );
    expect(crossSite.status).toBe(403);

    const resolved = await app(
      new Request("http://127.0.0.1/api/v1/idempotency/recover", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://127.0.0.1",
          "sec-fetch-site": "same-origin",
        },
        body,
      }),
    );
    expect(resolved.status).toBe(202);
    expect(resolved.headers.get("idempotency-recovered")).toBe("true");
    expect(await resolved.json()).toEqual({ reconciled: true });

    const after = await app(
      new Request(`http://127.0.0.1/orch/v1/idempotency/status?${ownIdentity}`, {
        headers: { "x-orch-token": token },
      }),
    );
    expect(await after.json()).toMatchObject({ caller, state: "completed", replayable: true });

    const selfResolve = await app(
      new Request("http://127.0.0.1/orch/v1/idempotency/recover", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "cannot-self-resolve",
          "x-orch-token": token,
        },
        body,
      }),
    );
    expect(selfResolve.status).toBe(404);
  } finally {
    ctx.db.close();
  }
});

test("attachment uploads replay the stored result without writing another file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-idempotency-attach-"));
  const ctx = testContext();
  ctx.config.dataDir = dir;
  try {
    const form = new FormData();
    form.append("file", new File(["same bytes"], "proof.txt", { type: "text/plain" }), "proof.txt");
    const encoded = new Request("http://x", { method: "POST", body: form });
    const contentType = encoded.headers.get("content-type")!;
    const body = await encoded.arrayBuffer();
    const app = makeApp(ctx);
    const upload = () =>
      app(
        new Request("http://x/api/v1/attach", {
          method: "POST",
          headers: { "content-type": contentType, "idempotency-key": "attachment-replay" },
          body,
        }),
      );

    const first = await upload();
    expect(first.status).toBe(200);
    const firstBody: unknown = await first.json();
    const replay = await upload();
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(await replay.json()).toEqual(firstBody);
    expect(readdirSync(join(dir, "attachments"))).toHaveLength(1);
  } finally {
    ctx.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration 041 upgrades N-1 atomically and is replay-safe", () => {
  const db = openMemory();
  try {
    const migration = migrationMentioning("idempotency_request");
    fx.project.insert(db, { name: "kept", repo_path: "acme/kept" });
    db.run("DELETE FROM migration WHERE n = ?", [migration]);
    db.run("DROP INDEX idempotency_request_age");
    db.run("DROP TABLE idempotency_request");

    migrate(db);
    migrate(db);
    expect(db.query<{ name: string }, []>("SELECT name FROM project").get()!.name).toBe("kept");
    expect(
      db.query<{ count: number }, [number]>("SELECT count(*) AS count FROM migration WHERE n = ?").get(migration)!
        .count,
    ).toBe(1);
    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'idempotency_request'",
        )
        .get()!.name,
    ).toBe("idempotency_request");
  } finally {
    db.close();
  }
});

test("a failed migration does not stamp a version or replace existing data", () => {
  const db = openMemory();
  try {
    const migration = migrationMentioning("idempotency_request");
    db.run("DELETE FROM migration WHERE n = ?", [migration]);
    db.run("DROP INDEX idempotency_request_age");
    db.run("DROP TABLE idempotency_request");
    db.run("CREATE TABLE idempotency_request (marker TEXT NOT NULL)");
    db.run("INSERT INTO idempotency_request VALUES ('keep')");

    expect(() => migrate(db)).toThrow();
    expect(
      db.query<{ count: number }, [number]>("SELECT count(*) AS count FROM migration WHERE n = ?").get(migration)!
        .count,
    ).toBe(0);
    expect(db.query<{ marker: string }, []>("SELECT marker FROM idempotency_request").get()!.marker).toBe("keep");
  } finally {
    db.close();
  }
});
