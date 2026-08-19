import { expect, test } from "bun:test";
import { Bus } from "../../src/platform/persistence/event-bus.ts";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { saveAuth } from "../../src/mech/sandbox/auth.ts";
import { forgetSecrets, scrub } from "../../src/platform/observability/redaction.ts";

// The *shape* of what `claude setup-token` prints on the line after "Store this
// token securely" — the line the login streamed to the panel in full. Synthetic:
// this file used to carry a real minted token, copied here verbatim while
// diagnosing that very leak, and a repository is the one place a credential must
// never be. What the test needs is the prefix and the length, not a live secret.
const MINTED = `sk-ant-oat01-${"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-".repeat(2).slice(0, 95)}`;

test("a token that was printed but not yet stored is still masked", () => {
  forgetSecrets();
  // The window the value pass cannot cover: the CLI prints it, and only the line
  // after that does anything store it.
  const out = scrub(`Store this token securely. You won't be able to see it again.\n${MINTED}`);
  expect(out).not.toContain("sk-ant-oat01");
  expect(out).toContain("Store this token securely");
});

test("a stored credential is masked by value, whatever shape it has", () => {
  forgetSecrets();
  const db = openMemory();
  const refresh = "rt-9d1c250a-e61b-44d9-88ed-5944d1962f5e-and-then-some";
  saveAuth(db, { runtime: "codex", mode: "chatgpt", secret: `{"tokens":{"refresh_token":"${refresh}"}}` });
  // Registered whole and in parts: the sidecar injects one token out of the file,
  // so the file never travels but that token does.
  expect(scrub(`refreshing with ${refresh}`)).not.toContain(refresh);
});

test("an event is scrubbed before it is written, not on the way out", () => {
  forgetSecrets();
  const db = openMemory();
  const bus = new Bus(db);
  // The failure path put the last 300 characters of CLI output in `detail`, and
  // `event` is append-only: what lands here cannot be taken back.
  bus.emit({ author: "orchestrator", kind: "state_change", body: `claude 登录没成：${MINTED}` });
  const row = db.query<{ body: string }, []>("SELECT body FROM event ORDER BY seq DESC LIMIT 1").get()!;
  expect(row.body).not.toContain("sk-ant");
  expect(row.body).toContain("claude 登录没成");
});

test("ordinary output is left alone", () => {
  forgetSecrets();
  // A mask on ordinary text is worse than none: it teaches the boss that the
  // panel eats words, and then a real mask reads as noise.
  const line = "bun test — 475 pass, 0 fail (sk is not a token)";
  expect(scrub(line)).toBe(line);
});
