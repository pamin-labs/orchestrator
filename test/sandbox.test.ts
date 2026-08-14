import { expect, test } from "bun:test";
import { open } from "../src/db.ts";
import { lineSplitter, specFor } from "../src/mech/sandbox.ts";
import { httpsRemote } from "../src/mech/checkout.ts";
import type { Ctx } from "../src/api.ts";

/**
 * The boundary's own checks.
 *
 * The live half — a real container, a real clone, a real mailbox round trip —
 * needs a running opensandbox-server, so it lives in test/sandbox-live.test.ts
 * and skips loudly without one. What is checked here is everything that can be
 * wrong without a server: the spec a group gets, the line reassembly the turn
 * stream depends on, and the remote a sandbox is asked to clone.
 */

function ctx(config: Partial<NonNullable<Ctx["config"]>> = {}): Ctx {
  const db = open(":memory:");
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  return {
    db,
    config: { language: "中文", workRoot: "/var/tmp/x", ...config },
  } as unknown as Ctx;
}

const BASE = {
  server: "127.0.0.1:8080",
  apiKey: "",
  image: "img:1",
  cpu: "",
  memory: "8Gi",
  ttlSeconds: 3600,
  denyDomains: [],
};

test("cpu defaults to a quarter of the host rather than the SDK's one core", () => {
  // The SDK default of "1" made this repo's typecheck 3.7x slower than the host
  // (docs/decisions/005), and the failure mode is "gates are slow", which nobody
  // traces back to a resource limit.
  const spec = specFor(ctx({ sandbox: BASE }), 1);
  expect(Number(spec.cpu)).toBeGreaterThanOrEqual(2);
  expect(Number(spec.cpu)).toBeLessThanOrEqual(navigator.hardwareConcurrency || 64);
});

test("a project overrides the defaults one key at a time", () => {
  const c = ctx({ sandbox: { ...BASE, image: "default:1", memory: "8Gi" } });
  c.db.run(
    `UPDATE project SET config_json = '{"sandbox":{"image":"rust:1","denyDomains":["evil.example"]}}' WHERE id = 1`,
  );
  const spec = specFor(c, 1);
  expect(spec.image).toBe("rust:1");
  expect(spec.denyDomains).toEqual(["evil.example"]);
  // Untouched keys still come from config, or an override would mean rewriting
  // the whole block to change one thing.
  expect(spec.memory).toBe("8Gi");
  expect(spec.ttlSeconds).toBe(3600);
});

test("a malformed project config falls back instead of failing the group", () => {
  const c = ctx({ sandbox: BASE });
  c.db.run(`UPDATE project SET config_json = 'not json' WHERE id = 1`);
  expect(specFor(c, 1).image).toBe("img:1");
});

test("stdout lines survive chunks that split mid-object", () => {
  // SSE frames do not respect line boundaries, and both CLIs emit NDJSON: a
  // chunk that lands mid-object must be held, not parsed.
  const s = lineSplitter();
  const whole = '{"type":"a"}\n{"type":"b"}\n{"type":"c"}';
  expect(s.push(whole.slice(0, 17))).toEqual(['{"type":"a"}']);
  expect(s.push(whole.slice(17))).toEqual(['{"type":"b"}']);
  // The last object has no trailing newline; it is only complete at the end.
  expect(s.rest()).toBe('{"type":"c"}');
});

test("blank lines never reach the parser", () => {
  const s = lineSplitter();
  expect(s.push("\n\n{\"a\":1}\n\n")).toEqual(['{"a":1}']);
  expect(s.rest()).toBe("");
});

test("an SSH remote is rewritten, because a sandbox has no key and should not", () => {
  // An SSH key cannot be injected by the credential vault — injection works on
  // HTTP headers — so a sandbox given an SSH remote can only fail. Over HTTPS a
  // read-only token is bound at the sidecar and the container holds nothing.
  expect(httpsRemote("git@github.com:owner/repo.git")).toBe("https://github.com/owner/repo.git");
  expect(httpsRemote("ssh://git@github.com/owner/repo.git")).toBe("https://github.com/owner/repo.git");
  expect(httpsRemote("git@gitlab.example.com:group/sub/repo")).toBe("https://gitlab.example.com/group/sub/repo.git");
  // Already fine, or not ours to guess at.
  expect(httpsRemote("https://github.com/owner/repo.git")).toBe("https://github.com/owner/repo.git");
  expect(httpsRemote("/srv/mirrors/repo.git")).toBe("/srv/mirrors/repo.git");
});
