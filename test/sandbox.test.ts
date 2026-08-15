import { expect, test } from "bun:test";
import { open } from "../src/db.ts";
import { keyInConfig, lineSplitter, skillMounts, specFor } from "../src/mech/sandbox/sandbox.ts";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { httpsRemote } from "../src/mech/git/checkout.ts";
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
    config: { language: "中文", ...config },
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
  cacheDirs: {},
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

test("a carriage return ends a line, so a clone is not one line until it finishes", () => {
  // `git clone --progress` rewrites a single line with `\r`. Splitting on `\n`
  // alone held all of it in the buffer, so the two longest commands in a group's
  // life — the clone and the install — printed nothing until they were over,
  // which is exactly the "is it stuck" the log exists to answer.
  const s = lineSplitter();
  expect(s.push("Receiving objects:  1%\rReceiving objects: 42%\r")).toEqual([
    "Receiving objects:  1%",
    "Receiving objects: 42%",
  ]);
  // A CRLF stream still yields one line per line, not one plus an empty.
  expect(lineSplitter().push("a\r\nb\r\n")).toEqual(["a", "b"]);
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

test("a project can share a package cache, and gets none unless it asks", () => {
  // Off by default on purpose. This repo's worst outage was every worktree
  // sharing one node_modules through a symlink: two gates installed at once and
  // a group read `Failed to link jiti: EEXIST` as its own build being broken. A
  // package cache is not that — bun's is content-addressed and built for
  // concurrent readers — but it is close enough to be a deliberate choice.
  expect(specFor(ctx({ sandbox: BASE }), 1).cacheDirs).toEqual({});

  const c = ctx({ sandbox: BASE });
  c.db.run(
    `UPDATE project SET config_json = '{"sandbox":{"cacheDirs":{"/root/.bun/install/cache":"/var/tmp/orch-cache"}}}' WHERE id = 1`,
  );
  expect(specFor(c, 1).cacheDirs).toEqual({ "/root/.bun/install/cache": "/var/tmp/orch-cache" });
});

test("the sandbox key is read from the server's own config, not invented here", () => {
  // A key generated in the panel is one the server has never heard of, and the
  // panel cannot restart the server to teach it — so every container request
  // 401s with "Authentication credentials are invalid", which reads as a model
  // problem. The server owns the value; this reads it.
  const dir = mkdtempSync(join(tmpdir(), "orch-sbkey-"));
  const f = join(dir, "sandbox.toml");
  writeFileSync(f, '[server]\nhost = "127.0.0.1"\napi_key = "spike-local-key"\n');
  expect(keyInConfig(f)).toBe("spike-local-key");
  expect(keyInConfig(join(dir, "nope.toml"))).toBeNull();
});

test("a commented-out key is not a key", () => {
  // The example config ships that line commented out; taking it would store a
  // value the server is not using and lock the fleet out just as thoroughly.
  const dir = mkdtempSync(join(tmpdir(), "orch-sbkey-"));
  const f = join(dir, "sandbox.toml");
  writeFileSync(f, '[server]\n# api_key = "example"\napi_key = ""\n');
  expect(keyInConfig(f)).toBeNull();
});

test("staged skills mount read-only, on an absolute path, at both CLIs' paths", () => {
  // Relative is the trap: the sandbox server resolves this against its own
  // filesystem and rejects anything that does not start with `/`, which fails
  // container creation for every group at once. Read-only is the other half —
  // one group editing the set every other group mounts is not a thing to allow.
  const dir = mkdtempSync(join(tmpdir(), "orch-sk-mount-"));
  mkdirSync(join(dir, "skills", "alpha"), { recursive: true });
  const mounts = skillMounts(ctx({ skillsDir: relative(process.cwd(), join(dir, "skills")) }));

  expect(mounts.map((m) => m.mountPath)).toEqual(["/root/.claude/skills", "/root/.codex/skills"]);
  for (const m of mounts) {
    expect(m.readOnly).toBe(true);
    expect(m.host?.path).toBe(join(dir, "skills"));
  }
  // Nothing ticked: no mount rather than a mount of a directory that is not there.
  expect(skillMounts(ctx({ skillsDir: join(dir, "nope") }))).toEqual([]);
});
