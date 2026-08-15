import { expect, test } from "bun:test";
import { openMemory } from "../src/db.ts";
import { saveAuth } from "../src/mech/auth.ts";
import { preflight } from "../src/mech/preflight.ts";


test("a ChatGPT login with no codex on this host is called out before it goes stale", async () => {
  // The one credential that needs a binary on this machine permanently. Renewal
  // is deliberately done by running the real `codex` rather than posting the
  // refresh token ourselves with the CLI's client id — so no codex, no renewal,
  // and the failure is silent and hours late: the nudge throws, `renew` returns
  // null, the stored token is kept, and every codex turn 401s looking like an
  // expired account.
  const db = openMemory();
  saveAuth(db, {
    runtime: "codex",
    mode: "chatgpt",
    secret: JSON.stringify({ tokens: { refresh_token: "r" } }),
  });
  const run = (hasCodex: boolean) =>
    preflight({
      db,
      sandbox: { server: "http://127.0.0.1:1", apiKey: "", image: "x" },
      probe: (bin) => (bin === "codex" ? hasCodex : true),
      verify: async () => ({ ok: true, detail: "ok" }),
    });

  const without = (await run(false)).find((c) => c.name === "codex-refresher")!;
  expect(without.ok).toBe(false);
  expect(without.fix).toContain("API key");
  expect((await run(true)).find((c) => c.name === "codex-refresher")!.ok).toBe(true);
});

test("the other credential modes need nothing on this host", async () => {
  // A pasted `sk-ant-oat01-` is good for a year and an API key does not expire,
  // so neither has anything to renew. Only the ChatGPT pair does.
  const db = openMemory();
  saveAuth(db, { runtime: "codex", mode: "api_key", secret: "sk-x" });
  const checks = await preflight({
    db,
    sandbox: { server: "http://127.0.0.1:1", apiKey: "", image: "x" },
    probe: () => false,
    verify: async () => ({ ok: true, detail: "ok" }),
  });
  expect(checks.find((c) => c.name === "codex-refresher")).toBeUndefined();
});
