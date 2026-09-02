import { afterAll, expect, test } from "bun:test";
import { renderSaid } from "../../src/platform/text/lang.ts";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { grp as grpTable, project as projectTable } from "../../src/platform/persistence/schema.ts";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { makeApp } from "../../src/composition/api.ts";
import { loadConfig } from "../../src/platform/config/load.ts";
import { createCheckout, keepBranch, sandboxGit, utilGit } from "../../src/mech/git/checkout.ts";
import { startMailbox } from "../../src/mech/sandbox/mailbox.ts";
import { CODEX_HOME, SANDBOX_KEY, sandboxKeyFor, saveAuth } from "../../src/mech/sandbox/auth.ts";
import { ensureServer } from "../../src/mech/sandbox/server.ts";
import {
  bindCredentials,
  closeAll,
  execIn,
  execLines,
  getFile,
  killSandbox,
  MAILBOX_DIR,
  putFile,
  REAL,
  serverKeyOnDisk,
  SKILL_SYNC,
  UTIL,
  WORK,
} from "../../src/mech/sandbox/sandbox.ts";
import { cacheProjectSkills } from "../../src/mech/skills.ts";
import * as fx from "../support/factories.ts";
import { testContext } from "../support/test-context.ts";

/**
 * The whole boundary, against a real container.
 *
 * Everything else in the suite runs against a fake driver, which proves the
 * orchestrator's half and nothing about OpenSandbox's. This proves the seam: a
 * sandbox is created, provisioned, given a checkout, runs commands in it, and
 * cannot reach this machine.
 */
/**
 * The suite starts its own server, and skips only for a reason it detected.
 *
 * Probing 8080 and skipping when nothing answered made "nobody started a server"
 * indistinguishable from "this machine cannot run containers", and only the
 * second is a reason to skip the only test of the real thing. `ensureServer` is
 * the same call the orchestrator makes at boot.
 *
 * On with `ORCH_LIVE_SANDBOX=1`, which nightly sets and fails if anything skips.
 */
/*
 *   docker pull ghcr.io/pamin-labs/orch-agent:latest   # public, no login
 *   docker pull opensandbox/egress:v1.1.6              # v1.1.4 403s scoped fetches
 */
const cfg = loadConfig();

/** On by explicit request only. Anything else, including unset, is off. */
const ENABLED = process.env.ORCH_LIVE_SANDBOX === "1";

/**
 * The daemon, not the binary.
 *
 * `docker --version` answers on a machine whose daemon is not running, and the
 * symptom of trusting it is a server that starts, listens, and fails every
 * create. Same probe as preflight's docker check.
 */
function dockerUp(): boolean {
  try {
    return Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * A server, and the key to drive it with.
 *
 * The key is what made this skip on a machine where everything worked:
 * `ORCH_SANDBOX_API_KEY` is normally unset, a server already on 8080 has one,
 * and every call came back 401. `serverKeyOnDisk` reads it from that server's
 * own config, seeded into the boot database so `ensureServer` does not generate
 * a second key the running config has never heard of.
 */
async function boot(): Promise<{ key: string; started: string | null } | { why: string }> {
  if (!ENABLED) return { why: "ORCH_LIVE_SANDBOX is not 1" };
  if (!dockerUp()) return { why: "the docker daemon does not answer — no containers, so these prove nothing" };

  const db = await openMemory();
  const held = serverKeyOnDisk();
  const known = cfg.sandbox.apiKey || (held?.server === cfg.sandbox.server ? held.key : "");
  if (known)
    await saveAuth(db, {
      runtime: SANDBOX_KEY,
      mode: "api_key",
      secret: known,
      baseUrl: `http://${cfg.sandbox.server}`,
    });

  // Every "no" this returns is a different sentence and each names what to do,
  // which is the whole reason to go through it rather than probe a port.
  const state = await ensureServer(await testContext({ db, config: cfg }));
  if (state.kind === "down" || state.kind === "stuck") return { why: renderSaid("en", state.why) };
  return {
    key: await sandboxKeyFor(db, cfg.sandbox.server, cfg.sandbox.apiKey),
    started: state.kind === "started" ? state.pid : null,
  };
}

const booted = await boot();
const ready = "key" in booted;
const live = ready ? test : test.skip;
if (!ready) console.log(`\n[sandbox-live] skipped: ${booted.why}\n`);

// Only ever the one we started. A server that was already there is somebody
// else's — possibly the orchestrator this checkout is being developed against —
// and killing it is not this file's business.
afterAll(() => {
  if (ready && booted.started) process.kill(Number(booted.started));
});

async function ctx(port = cfg.port) {
  const db = await openMemory();
  const f = fx.on(db);
  const p = await f.project.create({ name: "p" });
  await f.runningGrp.create({ project_id: p.id, name: "live" });
  return testContext({
    db,
    sandbox: REAL,
    // An ephemeral port, not the configured one: this test serves the routes
    // itself, and a fixed port collides with a real orchestrator or with the
    // previous run's socket still in TIME_WAIT.
    config: { ...cfg, port, sandbox: { ...cfg.sandbox, apiKey: ready ? booted.key : "" } },
  });
}

live(
  "a sandbox is a boundary: it gets a checkout, runs its gates, and cannot touch this machine",
  async () => {
    const c = await ctx();
    const scope = { grp: 1 } as const;
    try {
      // Provisioning: the mailbox and a matching `orch` land before anything else.
      // Asserted with the output attached, not on the code alone. One run in seven
      // gave `Received: 126` here and nothing else — the shell's "found but could
      // not execute", against a command that only runs `test` and `ls` — and the
      // two streams that would have named it had been discarded by the matcher.
      // A container is the one place where re-running is not a way to find out.
      const orch = await execIn(c, scope, "test -x /usr/local/bin/orch && ls /var/orch");
      const said = (r: { code: number; out: string; err: string }) => `code=${r.code} out=${r.out} err=${r.err}`;
      expect(orch.code, said(orch)).toBe(0);
      expect(orch.out, said(orch)).toContain("req");

      // The toolchain the gates need. `tsc` is why node is in the image at all.
      const tools = await execIn(c, scope, "bun --version && node --version && git --version");
      expect(tools.code, said(tools)).toBe(0);

      // The host is not reachable. This is the whole point: whatever the agent
      // does, it does inside here.
      const escape = await execIn(c, scope, `ls ${import.meta.dir} 2>&1; echo rc=$?`);
      expect(escape.out).not.toContain("sandbox-live.test.ts");

      // A checkout, cloned rather than mounted. Public repo: this asserts the
      // clone path, not GitHub credentials.
      await createCheckout(c, scope, {
        remote: "https://github.com/octocat/Hello-World.git",
        branch: "orch/live",
        base: "origin/HEAD",
      });
      const git = sandboxGit(c, scope);
      expect((await git(["rev-parse", "--abbrev-ref", "HEAD"], WORK)).out.trim()).toBe("orch/live");

      // And it is a real repository the agent can commit to — which a mounted
      // `git worktree` could not have been without opening the boundary.
      await putFile(c, scope, `${WORK}/NOTE.md`, "written by the agent\n");
      const committed = await git(["add", "-A"], WORK);
      expect(committed.code).toBe(0);
      expect((await git(["commit", "-q", "-m", "wip: live check"], WORK)).code).toBe(0);
      expect((await git(["log", "-1", "--format=%s"], WORK)).out.trim()).toBe("wip: live check");

      // Files in and out, which is what the mailbox and the bundle both ride on.
      expect(await getFile(c, scope, `${WORK}/NOTE.md`)).toContain("written by the agent");
    } finally {
      await killSandbox(c, scope).catch(() => {});
      await closeAll();
    }
  },
  240_000,
);

live(
  "an agent reaches the orchestrator through the mailbox, with no route to this machine",
  async () => {
    const port = 40000 + Math.floor(Math.random() * 20000);
    const c = await ctx(port);
    const scope = { grp: 1 } as const;
    // A real orchestrator, on the port the mailbox replays to.
    const app = makeApp(c);
    const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: (req) => app(req) });
    const stop = startMailbox(c);
    try {
      await execIn(c, scope, "true"); // create the sandbox so the poller sees it

      // Straight at the port: refused, because nothing routes there from inside.
      const direct = await execIn(
        c,
        scope,
        `curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/api/v1/state`,
      );
      expect(direct.out.trim()).not.toBe("200");

      // Through the mailbox: answered. `orch status` needs an agent token, so a
      // 422 is the orchestrator replying — which is what is under test here.
      const viaOrch = await execIn(c, scope, `orch status live-check 2>&1; echo rc=$?`, {
        env: { ORCH_MAILBOX: MAILBOX_DIR, ORCH_TOKEN: "not-a-real-agent" },
        timeoutMs: 60_000,
      });
      expect(viaOrch.out).toContain("agent");
    } finally {
      stop();
      await server.stop(true);
      await killSandbox(c, scope).catch(() => {});
      await closeAll();
    }
  },
  240_000,
);

/**
 * The env map reaches the process, on the path a turn actually takes.
 *
 * Three things ride it and nothing proved any of them arrived: `CODEX_HOME` for
 * the refresher, `CLAUDE_CODE_OAUTH_TOKEN` out of the egress vault, and
 * `IS_SANDBOX=1`, without which claude-code refuses `--dangerously-skip-permissions`
 * as root and every turn ends `no_result` carrying the refusal.
 */
/**
 * The unit guard for that one asserts the `TurnSpec` carries it, which is a
 * different claim: `spec.env` still has to survive `runLineStream` → `execLines`
 * → `realLines` → `runOpts` → the SDK's `envs`. Only a real container can say,
 * and the two paths are checked separately because `execIn` may fall back to a
 * one-shot `run()` while `execLines` always uses one.
 */
live(
  "an environment given to a command is the environment the command runs in",
  async () => {
    const c = await ctx();
    const scope = { grp: 1 } as const;
    const say = String.raw`printf 'X=[%s]\n' "$ORCH_LIVE_PROBE"`;
    try {
      const one = await execIn(c, scope, say, { env: { ORCH_LIVE_PROBE: "carried" } });
      expect(one.out.trim(), `code=${one.code} err=${one.err}`).toBe("X=[carried]");

      // The turn path. `execLines` streams, and a turn's env goes through here.
      const lines: string[] = [];
      const stream = execLines(c, scope, say, { env: { ORCH_LIVE_PROBE: "carried" } });
      for (;;) {
        const step = await stream.next();
        if (step.done) break;
        lines.push(step.value);
      }
      expect(lines.join("\n").trim()).toBe("X=[carried]");

      // And absence is absence, so the assertion above is not passing on a
      // variable the image happens to set.
      const none = await execIn(c, scope, say);
      expect(none.out.trim()).toBe("X=[]");
    } finally {
      await killSandbox(c, scope).catch(() => {});
      await closeAll();
    }
  },
  240_000,
);

live(
  "the utility container takes a commit out of a group and into its mirror",
  async () => {
    // The path that runs every turn, and the one nothing had ever executed: a
    // container with no agent in it, a bare mirror, and a bundle carried between
    // them with no network and no credential. It would otherwise have run for the
    // first time at the boss's first slice boundary.
    //
    // A public repository, so this asserts the mechanism and not a token.
    const c = await ctx();
    const grp = { grp: 1 } as const;
    const remote = "https://github.com/octocat/Hello-World.git";
    await c.db.update(projectTable).set({ remote, base_branch: "master" }).where(eq(projectTable.id, 1));
    try {
      // Not a sandbox in the 005 sense: no agent, so none of an agent's furniture.
      const bare = await execIn(
        c,
        UTIL,
        "test -x /usr/local/bin/orch || test -d /var/orch || test -d /root/.claude/skills",
      );
      expect(bare.code).not.toBe(0);

      // The verb allowlist, refusing for real rather than in a unit test.
      // oxlint-disable-next-line typescript/await-thenable -- Bun's async matcher is awaitable, but Matchers is not declared Thenable
      await expect(utilGit(c, ["checkout", "main"])).rejects.toThrow(/may not run/);

      const mirror = `/repos/${remote.replace(/[^\w.-]+/g, "-")}`;
      expect((await utilGit(c, ["clone", "--bare", "--filter=blob:none", remote, mirror])).code).toBe(0);
      // Bare: nothing that came out of the repository is written anywhere that
      // anything would run it. That is what lets this container hold the login.
      expect((await execIn(c, UTIL, `test -d ${mirror}/.git && echo worktree || echo bare`)).out.trim()).toBe("bare");

      await createCheckout(c, grp, { remote, branch: "orch/live", base: "origin/master" });
      await execIn(c, grp, "echo probe > PROBE.md && git add -A && git commit -qm 'wip: probe'", { cwd: WORK });
      await c.db.update(grpTable).set({ branch: "orch/live" }).where(eq(grpTable.id, 1));

      expect(await keepBranch(c, 1)).toEqual({ ok: true });
      // `refs/orch/`, not `refs/heads/`: the mirror's `+refs/heads/*:refs/heads/*`
      // prune deletes by destination, so a local-only branch under `refs/heads/` is
      // gone before `pushBranch` can send it. `pushBranch` is what promotes it, and
      // to the *remote*'s `refs/heads/`. This asserted the location it had before
      // that fix, so it read as "the utility container cannot take a commit".
      const landed = await execIn(c, UTIL, `git -C ${mirror} log -1 --format=%s refs/orch/orch/live`);
      expect(landed.out.trim()).toBe("wip: probe");
    } finally {
      await killSandbox(c, grp).catch(() => {});
      await killSandbox(c, UTIL).catch(() => {});
      await closeAll();
    }
  },
  240_000,
);

live(
  "a credential bound to one path is not injected on another",
  async () => {
    // The whole of "a group container cannot push". Classic OAuth has no
    // read-only scope for a private repository, so nothing sits behind this: if
    // the sidecar ignored `paths`, every agent would hold a token that can write
    // to main and the design would be a sentence in a prompt.
    //
    // A decoy for the same header, so both directions are observable. Injection
    // REPLACES a header the client already set (005), so the real value arriving
    // means it was injected and the decoy arriving means it was not — no
    // guessing from an absent header.
    //
    // postman-echo rather than GitHub: this needs a host that says what it
    // received, and no credential of the boss's is involved.
    const c = await ctx();
    const scope = { grp: 1 } as const;
    const real = "REAL-INJECTED-BY-SIDECAR";
    const decoy = "DECOY-NEVER-INJECTED";
    try {
      await bindCredentials(c, scope, [
        { name: "probe", value: real, hosts: ["postman-echo.com"], header: "x-probe", paths: ["/get"] },
      ]);
      const ask = async (path: string) =>
        (
          await execIn(c, scope, `curl -s -H 'x-probe: ${decoy}' https://postman-echo.com${path}`, {
            timeoutMs: 60_000,
          })
        ).out;

      // On the list: the sidecar swaps the decoy for the real value.
      expect(await ask("/get")).toContain(real);
      // Off it: the decoy goes out untouched. Same host, same credential.
      const off = await ask("/headers");
      expect(off).toContain(decoy);
      expect(off).not.toContain(real);
    } finally {
      await killSandbox(c, scope).catch(() => {});
      await closeAll();
    }
  },
  240_000,
);

live(
  "every skill reaches both CLIs, and the ones the boss ticked stay read-only",
  async () => {
    const c = await ctx();
    const scope = { grp: 1 } as const;
    // One skill of our own, so this asserts the mount rather than whatever the
    // machine running it happens to have installed.
    //
    // Into `skillsDir`, which is the directory `skillMounts` mounts. It used to
    // stage into `dataDir` and assert against a container that had mounted
    // `skillsDir` — two different directories, so the `ls` came back empty. The
    // test had never run: it skips without a live server, and there was none
    // until now.
    //
    // Copied rather than `stageSkills`, which prunes anything not in its list —
    // against the real directory that is every skill the boss has ticked.
    const dir = cfg.skillsDir;
    mkdirSync(join(dir, "live-check"), { recursive: true });
    cpSync(join(import.meta.dir, "..", "fixtures", "live-check"), join(dir, "live-check"), { recursive: true });
    expect(existsSync(join(dir, "live-check", "SKILL.md"))).toBe(true);
    try {
      // A repository that ships skills the way the ecosystem actually does.
      // These are the two conventions that reached **neither** CLI: codex has no
      // project-local skills directory at all, and claude reads only
      // `.claude/skills`. Both were listed in the panel and delivered nowhere.
      for (const [base, name] of [
        [".codex", "repo-codex"],
        [".agents", "repo-agents"],
      ] as const) {
        await execIn(c, scope, `mkdir -p ${WORK}/${base}/skills/${name}`);
        await putFile(
          c,
          scope,
          `${WORK}/${base}/skills/${name}/SKILL.md`,
          `---\nname: ${name}\ndescription: |\n  shipped by the repository\n---\nbody\n`,
        );
      }
      const synced = await execIn(c, scope, SKILL_SYNC);
      expect(synced.code).toBe(0);

      for (const at of ["/root/.claude/skills", `${CODEX_HOME}/skills`]) {
        const ls = await execIn(c, scope, `ls ${at}`);
        // The boss's own, through the staging mount.
        expect(ls.out).toContain("live-check");
        // And the repository's, which is the whole point of the change.
        expect(ls.out).toContain("repo-codex");
        expect(ls.out).toContain("repo-agents");
        // Readable through the link, not merely present: a bind mount the
        // runtime cannot reach succeeds and delivers an empty directory, which
        // is exactly how this looked correct while every agent had no skills.
        const read = await execIn(c, scope, `cat ${at}/live-check/SKILL.md`);
        expect(read.code).toBe(0);
        expect(read.out.length).toBeGreaterThan(0);
      }

      // Read-only where it counts: what the boss ticked is the contract, and one
      // group editing the set every other group mounts is not part of it. The
      // directory itself is now ordinary container filesystem — that is what
      // lets a repository's skills join it — so the check is on the staged
      // source, through the link.
      const w = await execIn(c, scope, `touch /root/.claude/skills/live-check/nope 2>&1; echo rc=$?`);
      expect(w.out).not.toContain("rc=0");
      // And the listing travels back out, which is what the settings page and
      // `/name` read. It cannot come from this machine: the checkout is in here.
      const found = (await cacheProjectSkills(c.db, 1, synced.out)).map((skill) => skill.name).sort();
      expect(found).toEqual(["repo-agents", "repo-codex"]);
      expect((await cacheProjectSkills(c.db, 1, synced.out))[0]!.description).toBe("shipped by the repository");
    } finally {
      rmSync(join(dir, "live-check"), { recursive: true, force: true });
      await killSandbox(c, scope).catch(() => {});
      await closeAll();
    }
  },
  240_000,
);

live(
  "one line out of a container is still one line by the time it is read",
  async () => {
    // Measured, because it is not documented and the consequence is enormous:
    // the sandbox server hands over stdout **one line per message with the
    // newline stripped**. Joining those with "" ran every line together, so
    // `git status --porcelain`, `ls`, and a skills inventory all arrived as a
    // single line — and every caller that splits on newlines silently matched
    // nothing. A wrong answer shaped exactly like an empty one.
    const c = await ctx();
    const scope = { grp: 1 } as const;
    try {
      expect((await execIn(c, scope, `printf 'a\\nbb\\nccc\\n'`)).out.split("\n")).toEqual(["a", "bb", "ccc"]);
      // A blank line arrives AS "\n", so a naive re-join doubles every one of
      // them — which would have turned every diff hunk gap into two.
      expect((await execIn(c, scope, `printf 'a\\n\\n\\nb\\n'`)).out.split("\n")).toEqual(["a", "", "", "b"]);
      // And the streaming path, which is what a turn's NDJSON rides on: without
      // the terminator every object of the turn accumulates and is emitted once,
      // at the end, concatenated and unparseable.
      const seen: string[] = [];
      const stream = execLines(c, scope, `printf '{"i":1}\\n{"i":2}\\n{"i":3}\\n'`);
      for (;;) {
        const step = await stream.next();
        if (step.done) break;
        seen.push(step.value);
      }
      const StreamLine = z.object({ i: z.number() });
      expect(seen.map((line) => StreamLine.parse(JSON.parse(line)).i)).toEqual([1, 2, 3]);
    } finally {
      await killSandbox(c, scope).catch(() => {});
      await closeAll();
    }
  },
  240_000,
);
