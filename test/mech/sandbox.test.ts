import { expect, test } from "bun:test";
import { open, openMemory } from "../../src/platform/persistence/database.ts";
import {
  allowedImage,
  hostPathForDaemon,
  keyInConfig,
  lineSplitter,
  skillMounts,
  SKILL_LINE,
  SKILL_SYNC,
  specFor,
  STAGED_SKILLS,
} from "../../src/mech/sandbox/sandbox.ts";
import { CODEX_HOME } from "../../src/mech/sandbox/auth.ts";
import { setDefaultImage } from "../../src/mech/sandbox/images.ts";
import { cacheProjectSkills, projectSkills } from "../../src/mech/skills.ts";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { httpsRemote } from "../../src/mech/git/checkout.ts";
import type { Ctx } from "../../src/mech/ctx.ts";
import { loadConfig } from "../../src/platform/config/load.ts";
import { testContext } from "../support/test-context.ts";

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
  const ctx = testContext({ db });
  ctx.config = { ...ctx.config, ...config };
  return ctx;
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
  // (docs/adr/005), and the failure mode is "gates are slow", which nobody
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

test("malformed sandbox overrides never escape with asserted types", () => {
  const c = ctx({ sandbox: { ...BASE, cpu: "4" } });
  for (const sandbox of [{ image: 7 }, { denyDomains: "evil.example.com" }, { cacheDirs: [] }, { extra: true }]) {
    c.db.run("UPDATE project SET config_json = ? WHERE id = 1", [JSON.stringify({ sandbox })]);
    expect(specFor(c, 1)).toEqual({
      image: "img:1",
      cpu: "4",
      memory: "8Gi",
      ttlSeconds: 3600,
      denyDomains: [],
      cacheDirs: {},
    });
  }
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
  expect(s.push('\n\n{"a":1}\n\n')).toEqual(['{"a":1}']);
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

test("staged skills mount read-only, on an absolute path, at neither CLI's own path", () => {
  // Relative is the trap: the sandbox server resolves this against its own
  // filesystem and rejects anything that does not start with `/`, which fails
  // container creation for every group at once. Read-only is the other half —
  // one group editing the set every other group mounts is not a thing to allow.
  //
  // And it lands on a staging path, not on `/root/.claude/skills`. Mounting it
  // straight onto the CLI's own directory is what made a repository's own skills
  // undeliverable: a read-only mount is not a directory anything can add to, so
  // the one attempt at linking them in got EROFS, swallowed, and reported
  // success. `SKILL_SYNC` builds both directories out of symlinks into this.
  const dir = mkdtempSync(join(tmpdir(), "orch-sk-mount-"));
  mkdirSync(join(dir, "skills", "alpha"), { recursive: true });
  const mounts = skillMounts(ctx({ skillsDir: relative(process.cwd(), join(dir, "skills")) }));

  expect(mounts.map((m) => m.mountPath)).toEqual([STAGED_SKILLS]);
  for (const m of mounts) {
    expect(m.readOnly).toBe(true);
    expect(m.host?.path).toBe(join(dir, "skills"));
  }
  // Nothing ticked: no mount rather than a mount of a directory that is not there.
  expect(skillMounts(ctx({ skillsDir: join(dir, "nope") }))).toEqual([]);
});

test("the sync script links both CLIs' directories and lists what a repo ships", () => {
  // Three claims the script has to keep, each measured against the binaries in
  // `orch/agent:1` and each one the reason a convention reached nobody:
  //
  //   claude reads .claude/skills (93 hits) and neither of the other two
  //   codex reads $CODEX_HOME/skills only — no project directory at all
  //
  // so a repo's `.codex/skills` and `.agents/skills` reached neither CLI, and
  // its `.claude/skills` reached one of two.
  for (const cli of ["/root/.claude/skills", `${CODEX_HOME}/skills`]) {
    expect(SKILL_SYNC).toContain(cli);
  }
  // Every repository convention is linked into codex's directory, because codex
  // has nowhere else to find one.
  expect(SKILL_SYNC).toContain("for base in .claude .codex .agents");
  // ...but `.claude/skills` is not linked into claude's own, because claude
  // already reads it from the checkout and a second entry bills the same name
  // and description twice on every turn of the session.
  expect(SKILL_SYNC).toContain('[ "$base" = ".claude" ] ||');
  // It rides on the checkout probe, so it must not be able to fail that command.
  expect(SKILL_SYNC.trimEnd().endsWith("} 2>/dev/null")).toBe(true);
});

test("the inventory survives the trip back out of the container", () => {
  // The container is the only thing that can see a repository's skills, so the
  // listing the settings page and `/name` need has to travel as text on stdout.
  const db = open(":memory:");
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', 'o/r', 0)");
  const head = Buffer.from("---\nname: tidy\ndescription: |\n  keeps it neat\n---\nbody").toString("base64");
  const out = `some git noise\n${SKILL_LINE} .agents/skills/tidy/SKILL.md ${head}\nmore noise\nyes\n`;

  expect(cacheProjectSkills(db, 1, out)).toEqual([
    {
      name: "tidy",
      file: "/work/.agents/skills/tidy/SKILL.md",
      rel: ".agents/skills/tidy/SKILL.md",
      // A block scalar, which a one-line `sed` in the shell would have returned
      // as "|" — which is why the head travels and `frontmatterDescription`
      // reads it here.
      description: "keeps it neat",
      scope: "project",
    },
  ]);
  expect(projectSkills(db, 1).map((s) => s.name)).toEqual(["tidy"]);

  // A repository that dropped its last skill must stop listing it. Treating an
  // empty inventory as "leave the cache alone" is how a removed skill stays
  // nameable forever.
  expect(cacheProjectSkills(db, 1, "yes\n")).toEqual([]);
  expect(projectSkills(db, 1)).toEqual([]);
});

test("a group's container is only ever built from an image we published or you built", () => {
  // The image is where an agent runs, and an agent runs with your code in front
  // of it. Pointing the fleet at somebody else's image hands over the whole
  // boundary — and does it invisibly, because a container from a hostile image
  // behaves exactly like one that is not. Everything else in sandbox.ts assumes
  // the image is ours; this is what makes that assumption true.
  for (const ok of [
    "ghcr.io/pamin-labs/orch-agent:latest",
    "ghcr.io/pamin-labs/orch-agent:0.2.0",
    // Mixed case on purpose: the org renamed to lowercase and GitHub logins are
    // case-insensitive, so an image reference written either way is the same one.
    "ghcr.io/Pamin-Labs/orch-agent:1",
    // No registry in front of it: a tag that exists because it was built here,
    // which is what local development and debugging use.
    "orch/agent:1",
    "orch-agent",
  ]) {
    expect({ image: ok, allowed: allowedImage(ok) }).toEqual({ image: ok, allowed: true });
  }

  for (const no of [
    "docker.io/library/ubuntu:24.04",
    "evil.example.com/orch/agent:1",
    "localhost:5000/orch/agent:1",
    // The near-miss that matters: a different GHCR namespace is not ours.
    "ghcr.io/someone-else/orch-agent:latest",
    "",
  ]) {
    expect({ image: no, allowed: allowedImage(no) }).toEqual({ image: no, allowed: false });
  }
});

test("a project that names a disallowed image gets the default, not that image", () => {
  // Enforced where the container is actually built rather than only at the API.
  // `patchProjectConfig` merges arbitrary keys into `config_json`, so a check
  // that lives only in the route is one a request can walk around — and the
  // failure would be silent, which is the shape this codebase keeps paying for.
  const c = ctx({ sandbox: { ...BASE, image: "ghcr.io/pamin-labs/orch-agent:latest" } });
  c.db.run(`UPDATE project SET config_json = '{"sandbox":{"image":"evil.example.com/agent:1"}}' WHERE id = 1`);
  expect(specFor(c, 1).image).toBe("ghcr.io/pamin-labs/orch-agent:latest");

  // A locally built one is still honoured — that is how this gets debugged.
  c.db.run(`UPDATE project SET config_json = '{"sandbox":{"image":"orch/agent:1"}}' WHERE id = 1`);
  expect(specFor(c, 1).image).toBe("orch/agent:1");
});

test("a machine's default image is what a new project runs on, and it is not the yaml", () => {
  // Registering a repository sets no image at all — the point of the default is
  // that nobody is asked. It lived only in `config/default.yaml`, which is
  // committed, so anybody self-hosting lost their edit on the next pull.
  const db = openMemory();
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', 'me/x', 0)");
  const cfg = loadConfig("config/does-not-exist.yaml");
  cfg.sandbox.image = "ghcr.io/pamin-labs/orch-agent:latest";
  const ctx = testContext({ db, config: cfg });

  expect(specFor(ctx, 1).image).toBe("ghcr.io/pamin-labs/orch-agent:latest");

  // Writes the settings row *and* the live config, which is what makes the next
  // container use it without a restart.
  setDefaultImage(db, cfg, "ghcr.io/pamin-labs/orch-agent:0.2.0");
  expect(specFor(ctx, 1).image).toBe("ghcr.io/pamin-labs/orch-agent:0.2.0");

  // The project's own answer still wins, and an image the boundary refuses falls
  // back to the machine's default rather than to the yaml — otherwise turning a
  // bad project override away would silently undo the default too.
  db.run(`UPDATE project SET config_json = '{"sandbox":{"image":"orch/agent:1"}}' WHERE id = 1`);
  expect(specFor(ctx, 1).image).toBe("orch/agent:1");
  db.run(`UPDATE project SET config_json = '{"sandbox":{"image":"evil.example.com/x:1"}}' WHERE id = 1`);
  expect(specFor(ctx, 1).image).toBe("ghcr.io/pamin-labs/orch-agent:0.2.0");
});

test("on Windows the mount path is the one the daemon can read, not the one we wrote", () => {
  // `opensandbox-server` is Linux-only — its egress mode is `dns+nft` — so on a
  // Windows machine it runs under WSL, beside the Docker Desktop daemon, and the
  // path it is handed is resolved in *that* filesystem. `C:\orch\skills` is not
  // a path it has.
  //
  // Untranslated, nothing errors: the server rejects it for not starting with
  // `/`, or accepts it and mounts an empty directory. Both end with every ticked
  // skill silently absent, which is this project's oldest failure shape.
  expect(hostPathForDaemon("C:\\orch\\skills", "win32")).toBe("/mnt/c/orch/skills");
  expect(hostPathForDaemon("D:/data/cache", "win32")).toBe("/mnt/d/data/cache");
  // Already POSIX, on Windows: somebody who has thought about this. Left alone.
  expect(hostPathForDaemon("/mnt/c/orch/skills", "win32")).toBe("/mnt/c/orch/skills");
  // Everywhere else it is the identity, and has to be: a macOS path that grew a
  // `/mnt` prefix would fail the same way in the other direction.
  expect(hostPathForDaemon("/var/tmp/orch-cache/skills", "darwin")).toBe("/var/tmp/orch-cache/skills");
  expect(hostPathForDaemon("/var/tmp/orch-cache/skills", "linux")).toBe("/var/tmp/orch-cache/skills");
});
