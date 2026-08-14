import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/bus.ts";
import { openMemory } from "../src/db.ts";
import { RepoLock } from "../src/mech/gitlock.ts";
import { interrupt } from "../src/mech/intercept.ts";
import { makeGitRunner } from "../src/mech/worktree.ts";
import type { Ctx } from "../src/api.ts";
import { Scheduler } from "../src/scheduler.ts";
import { fakeSandbox } from "./fake-sandbox.ts";

/**
 * PLAN.md §7 L3: "打断并回滚" must end with the worktree back at the checkpoint the
 * turn started from. The pieces were tested apart — rollbackTo in worktree.test.ts,
 * the chain's revoke in chain.test.ts — and this end of it, kill plus rollback plus a
 * clean tree, never was.
 */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "orch-l3-"));
  const sh = (...a: string[]) => Bun.spawnSync(a, { cwd: dir });
  sh("git", "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n");
  sh("git", "add", "-A");
  sh("git", "-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "-qm", "init");
  const sha = new TextDecoder().decode(sh("git", "rev-parse", "HEAD").stdout).trim();
  return { dir, sha, sh };
}

function harness(worktree: string, repoPath: string, checkpoint: string) {
  const db = openMemory();
  const ctx: Ctx = {
    db,
    bus: new Bus(db),
    sched: new Scheduler(db, async () => {}),
    gitLock: new RepoLock(),
    sandbox: fakeSandbox(), waiters: new Map(),
    config: { language: "中文", workRoot: "/tmp/x" },
  };
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', ?, 0)", [repoPath]);
  db.run("INSERT INTO grp (project_id, name, status, worktree, created_at) VALUES (1, 'g1', 'RUNNING', ?, 0)", [
    worktree,
  ]);
  db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, clearance, state, created_at) VALUES (1, 1, 'engineer', 'sonnet', 'L1', 'running', 0)",
  );
  db.run(
    `INSERT INTO job (kind, grp_id, agent_id, state, checkpoint_sha, pid, enqueued_at, started_at)
     VALUES ('agent_turn', 1, 1, 'running', ?, NULL, 0, 0)`,
    [checkpoint],
  );
  return { db, ctx };
}

test("打断并回滚 returns the worktree to the checkpoint and leaves it clean", async () => {
  const r = repo();
  const h = harness(r.dir, r.dir, r.sha);
  // A turn's half-finished work: one tracked file edited, one new file added.
  writeFileSync(join(r.dir, "a.txt"), "one\ntwo — half a thought\n");
  writeFileSync(join(r.dir, "scratch.txt"), "leftover\n");

  const out = await interrupt(h.ctx, makeGitRunner(h.ctx.gitLock), 1, "rollback");
  expect(out.rolledBackTo).toBe(r.sha);
  expect(readFileSync(join(r.dir, "a.txt"), "utf8")).toBe("one\n");
  const status = new TextDecoder().decode(r.sh("git", "status", "--porcelain").stdout).trim();
  expect(status).toBe("");

  // And the queue is consistent: the turn is cancelled, the writer is idle, the group
  // is paused. A rolled-back tree under a still-"running" job is how two turns end up
  // writing over each other.
  const job = h.db.query<{ state: string; error: string }, []>("SELECT state, error FROM job").get()!;
  expect(job.state).toBe("cancelled");
  expect(job.error).toContain("rollback");
  expect(h.db.query<{ state: string }, []>("SELECT state FROM agent").get()!.state).toBe("idle");
  expect(h.db.query<{ status: string }, []>("SELECT status FROM grp").get()!.status).toBe("PAUSED");
});

test("打断保留 keeps the work and says nothing was rolled back", async () => {
  const r = repo();
  const h = harness(r.dir, r.dir, r.sha);
  writeFileSync(join(r.dir, "a.txt"), "one\ntwo — worth keeping\n");

  const out = await interrupt(h.ctx, makeGitRunner(h.ctx.gitLock), 1, "keep");
  expect(out.rolledBackTo).toBeUndefined();
  // The default is keep precisely because a half-done change usually has value.
  expect(readFileSync(join(r.dir, "a.txt"), "utf8")).toContain("worth keeping");
  expect(h.db.query<{ status: string }, []>("SELECT status FROM grp").get()!.status).toBe("PAUSED");
});
