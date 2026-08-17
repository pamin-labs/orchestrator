import { expect, test } from "bun:test";
import { Hono } from "hono";
import fc from "fast-check";
import { loadConfig, contextWindowFor, MAX_CONTEXT, MIN_CONTEXT } from "../../src/platform/config/load.ts";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { outsideOwns } from "../../src/mech/flow/ownership.ts";
import { reconcile } from "../../src/mech/flow/reconcile.ts";
import { normalise } from "../../src/mech/sandbox/mailbox.ts";
import { idempotency } from "../../src/http/idempotency/store.ts";
import { JsonValue, type Json } from "../../src/contracts/json.ts";
import { json } from "../../src/http/respond.ts";

const positiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const readPropertyOptions = (env: Readonly<Record<string, string | undefined>>) => {
  const seed = env.FC_SEED === undefined ? undefined : Number(env.FC_SEED);
  if (seed !== undefined && !Number.isSafeInteger(seed)) throw new Error("FC_SEED must be a safe integer");
  if (env.FC_PATH && seed === undefined) throw new Error("FC_PATH requires FC_SEED from the same fast-check failure");
  return {
    numRuns: positiveInt(env.FC_NUM_RUNS, 100),
    ...(seed === undefined ? {} : { seed }),
    ...(env.FC_PATH ? { path: env.FC_PATH } : {}),
  };
};
const propertyOptions = readPropertyOptions(process.env);
const part = fc.stringMatching(/^[a-z][a-z0-9-]{0,12}$/);

test("mailbox normalization never escapes the versioned agent boundary", () => {
  fc.assert(
    fc.property(
      fc.array(fc.oneof(part, fc.constantFrom(".", "..", "%2e", "%2e%2e")), { maxLength: 8 }),
      fc.option(fc.string({ maxLength: 40 }), { nil: undefined }),
      (parts, query) => {
        const result = normalise("http://127.0.0.1:9417", `/orch/v1/${parts.join("/")}${query ? `?q=${query}` : ""}`);
        if (result === null) return;
        const url = new URL(result);
        expect(url.origin).toBe("http://127.0.0.1:9417");
        expect(url.pathname.startsWith("/orch/v1/")).toBe(true);
      },
    ),
    propertyOptions,
  );
});

test("ownership globs admit descendants and reject a sibling tree", () => {
  fc.assert(
    fc.property(part, part, part, (root, directory, file) => {
      const inside = `${root}/${directory}/${file}.ts`;
      const outside = `${root}-sibling/${directory}/${file}.ts`;
      expect(outsideOwns([inside, outside], [`${root}/**`])).toEqual([outside]);
    }),
    propertyOptions,
  );
});

test("reconcile accepts normalized suffix claims without hiding unrelated files", () => {
  fc.assert(
    fc.property(part, part, (directory, file) => {
      const claimed = `${directory}/${file}.ts`;
      const changed = `packages/app/${claimed}`;
      const result = reconcile({
        claims: [{ files: [`./${claimed}`], summary: "observable behavior changed" }],
        changedFiles: [changed, "test/regression.test.ts"],
      });
      expect(result.pass).toBe(true);
      expect(result.phantom).toEqual([]);
      expect(result.unclaimed).toEqual(["test/regression.test.ts"]);
    }),
    propertyOptions,
  );
});

test("idempotency replays every JSON payload and conflicts on changed payloads", async () => {
  await fc.assert(
    fc.asyncProperty(fc.uuid(), fc.jsonValue(), async (key, value) => {
      const db = openMemory();
      try {
        const payload = JsonValue.parse(value);
        const app = new Hono();
        let writes = 0;
        app.use("*", idempotency(db));
        app.post("/write", async (c) => json({ write: ++writes, value: JsonValue.parse(await c.req.json()) }));
        const send = (body: Json) =>
          app.request("/write", {
            method: "POST",
            headers: { "content-type": "application/json", "idempotency-key": key },
            body: JSON.stringify(body),
          });

        const first = JsonValue.parse(await (await send(payload)).json());
        const replay = await send(payload);
        expect(JsonValue.parse(await replay.json())).toEqual(first);
        expect(replay.headers.get("idempotency-replayed")).toBe("true");
        expect(writes).toBe(1);
        expect((await send({ changed: true, value: payload })).status).toBe(409);
      } finally {
        db.close();
      }
    }),
    propertyOptions,
  );
}, 30_000);

test("reported context windows are always clamped to usable bounds", () => {
  const config = loadConfig();
  fc.assert(
    fc.property(fc.integer({ min: 1, max: MAX_CONTEXT * 4 }), (reported) => {
      const result = contextWindowFor(config, "property-model", reported);
      expect(result).toBe(Math.min(MAX_CONTEXT, Math.max(MIN_CONTEXT, reported)));
    }),
    propertyOptions,
  );
});

test("fast-check replay paths require their original seed", () => {
  expect(() => readPropertyOptions({ FC_PATH: "0:1" })).toThrow("FC_PATH requires FC_SEED");
  expect(readPropertyOptions({ FC_NUM_RUNS: "50", FC_SEED: "42", FC_PATH: "0:1" })).toEqual({
    numRuns: 50,
    seed: 42,
    path: "0:1",
  });
});
