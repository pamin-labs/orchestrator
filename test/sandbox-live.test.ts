import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openMemory } from "../src/db.ts";
import { makeApp, type Ctx } from "../src/api.ts";
import { Bus } from "../src/bus.ts";
import { Scheduler } from "../src/scheduler.ts";
import { RepoLock } from "../src/mech/gitlock.ts";
import { loadConfig } from "../src/config.ts";
import { createCheckout, httpsRemote, sandboxGit } from "../src/mech/checkout.ts";
import { startMailbox } from "../src/mech/mailbox.ts";
import { CODEX_HOME } from "../src/mech/auth.ts";
import { ConnectionConfig, SandboxManager } from "@alibaba-group/opensandbox";
import {
  closeAll,
  execIn,
  getFile,
  killSandbox,
  MAILBOX_DIR,
  putFile,
  REAL,
  WORK,
} from "../src/mech/sandbox.ts";

/**
 * The whole boundary, against a real container.
 *
 * Everything else in the suite runs against a fake driver, which proves the
 * orchestrator's half and nothing about OpenSandbox's. This proves the seam:
 * a sandbox is created, provisioned, given a checkout, runs commands in it, and
 * cannot reach this machine.
 *
 * Skipped unless a server is up, because it needs one — and it says so rather
 * than passing quietly, since a green suite that silently skipped the only test
 * of the real thing is the failure this whole design exists to avoid.
 *
 *   uvx opensandbox-server --config <toml>   # [egress] mode = "dns+nft", image >= v1.1.6
 *   docker build -f docker/agent.Dockerfile -t orch/agent:1 .
 */

const cfg = loadConfig();

/**
 * Usable, not merely listening.
 *
 * The first version of this asked whether the port answered, which it does even
 * when the API key is wrong — so the tests ran and failed on 401 instead of
 * skipping. "Can I drive it" is the only question worth asking.
 */
async function serverUp(): Promise<boolean> {
  try {
    const m = await SandboxManager.create({
      connectionConfig: new ConnectionConfig({
        domain: cfg.sandbox.server,
        protocol: "http",
        apiKey: cfg.sandbox.apiKey || undefined,
        requestTimeoutSeconds: 5,
      }),
    });
    await m.listSandboxInfos({ pageSize: 1 });
    await m.close();
    return true;
  } catch {
    return false;
  }
}

function ctx(port = cfg.port): Ctx {
  const db = openMemory();
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  db.run("INSERT INTO grp (project_id, name, status, created_at) VALUES (1, 'live', 'RUNNING', 0)");
  const sched = new Scheduler(db, async () => {});
  return {
    db,
    bus: new Bus(db),
    sched,
    gitLock: new RepoLock(),
    sandbox: REAL,
    waiters: new Map(),
    // An ephemeral port, not the configured one: this test serves the routes
    // itself, and a fixed port collides with a real orchestrator or with the
    // previous run's socket still in TIME_WAIT.
    config: { language: "中文", port, sandbox: cfg.sandbox, skillsDir: cfg.skillsDir },
  } as unknown as Ctx;
}

const up = await serverUp();
const live = up ? test : test.skip;
if (!up)
  console.log(
    `\n[sandbox-live] skipped: cannot drive opensandbox-server on ${cfg.sandbox.server}` +
      ` (not running, or ORCH_SANDBOX_API_KEY is unset/wrong)\n`,
  );

live(
  "a sandbox is a boundary: it gets a checkout, runs its gates, and cannot touch this machine",
  async () => {
    const c = ctx();
    const scope = { grp: 1 } as const;
    try {
      // Provisioning: the mailbox and a matching `orch` land before anything else.
      const orch = await execIn(c, scope, "test -x /usr/local/bin/orch && ls /var/orch");
      expect(orch.code).toBe(0);
      expect(orch.out).toContain("req");

      // The toolchain the gates need. `tsc` is why node is in the image at all.
      const tools = await execIn(c, scope, "bun --version && node --version && git --version");
      expect(tools.code).toBe(0);

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
      expect((await git(WORK, ["rev-parse", "--abbrev-ref", "HEAD"], WORK)).out.trim()).toBe("orch/live");

      // And it is a real repository the agent can commit to — which a mounted
      // `git worktree` could not have been without opening the boundary.
      await putFile(c, scope, `${WORK}/NOTE.md`, "written by the agent\n");
      const committed = await git(WORK, ["add", "-A"], WORK);
      expect(committed.code).toBe(0);
      expect((await git(WORK, ["commit", "-q", "-m", "wip: live check"], WORK)).code).toBe(0);
      expect((await git(WORK, ["log", "-1", "--format=%s"], WORK)).out.trim()).toBe("wip: live check");

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
    const c = ctx(port);
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
        `curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/api/state`,
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
      server.stop(true);
      await killSandbox(c, scope).catch(() => {});
      await closeAll();
    }
  },
  240_000,
);

live(
  "the staged skills are there, and the sandbox cannot write to them",
  async () => {
    const c = ctx();
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
    cpSync(join(import.meta.dir, "fixtures", "live-check"), join(dir, "live-check"), { recursive: true });
    expect(existsSync(join(dir, "live-check", "SKILL.md"))).toBe(true);
    try {
      // Both CLIs look in their own place; one host directory answers both.
      for (const at of ["/root/.claude/skills", `${CODEX_HOME}/skills`]) {
        const ls = await execIn(c, scope, `ls ${at}`);
        expect(ls.out).toContain("live-check");
        // Read-only: what the boss ticked is the contract, and one group editing
        // the set every other group mounts is not part of it.
        const w = await execIn(c, scope, `touch ${at}/nope 2>&1; echo rc=$?`);
        expect(w.out).toContain("rc=1");
      }
    } finally {
      rmSync(join(dir, "live-check"), { recursive: true, force: true });
      await killSandbox(c, scope).catch(() => {});
      await closeAll();
    }
  },
  240_000,
);
