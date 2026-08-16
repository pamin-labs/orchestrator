import { expect, test } from "bun:test";
import { Hono } from "hono";
import fc from "fast-check";
import { loadConfig, contextWindowFor, MAX_CONTEXT, MIN_CONTEXT } from "../src/config.ts";
import { openMemory } from "../src/db.ts";
import { outsideOwns } from "../src/mech/flow/ownership.ts";
import { reconcile } from "../src/mech/flow/reconcile.ts";
import { normalise } from "../src/mech/sandbox/mailbox.ts";
import { idempotency } from "../src/http/idempotency.ts";

const positiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const runs = positiveInt(process.env.FC_NUM_RUNS, 100);
const seed = Number(process.env.FC_SEED);
const propertyOptions = {
  numRuns: runs,
  ...(Number.isSafeInteger(seed) ? { seed } : {}),
  ...(process.env.FC_PATH ? { path: process.env.FC_PATH } : {}),
};
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
        const app = new Hono();
        let writes = 0;
        app.use("*", idempotency(db));
        app.post("/write", async (c) => c.json({ write: ++writes, value: await c.req.json() }));
        const send = (body: unknown) =>
          app.request("/write", {
            method: "POST",
            headers: { "content-type": "application/json", "idempotency-key": key },
            body: JSON.stringify(body),
          });

        const first: unknown = await (await send(value)).json();
        const replay = await send(value);
        expect(await replay.json()).toEqual(first);
        expect(replay.headers.get("idempotency-replayed")).toBe("true");
        expect(writes).toBe(1);
        expect((await send({ changed: true, value })).status).toBe(409);
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
