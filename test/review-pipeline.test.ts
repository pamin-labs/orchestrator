import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeApp, reservedGitAction, type Ctx } from "../src/api.ts";
import { Bus } from "../src/bus.ts";
import { loadConfig, loadRoles } from "../src/config.ts";
import { openMemory } from "../src/db.ts";
import { RepoLock } from "../src/mech/gitlock.ts";
import { gateState } from "../src/mech/gate.ts";
import { makeGitRunner, createWorktree, checkpoint } from "../src/mech/worktree.ts";
import { Scheduler, type Job } from "../src/scheduler.ts";
import {
  makeAuditVerdict,
  makeExecutor,
  makeReviewVerdict,
  type ExecDeps,
} from "../src/runtime/executor.ts";
import type { TurnResult, TurnSpec } from "../src/runtime/claude.ts";

const git = makeGitRunner(new RepoLock());

function turnOk(): TurnResult {
  return {
    sessionId: "s",
    ok: true,
    terminalReason: "completed",
    text: "done",
    usage: { input: 1, output: 1, cacheRead: 0, cacheCreate: 0, thinking: 0 },
    costUsd: 0,
    numTurns: 1,
    permissionDenials: [],
    toolSummaries: [],
    filesTouched: [],
  };
}

/** A real repo + worktree, so reconcile sees a real diff. */
async function harness(opts: { gates?: string[] } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "orch-rp-repo-"));
  await git(repo, ["init", "-q", "-b", "main"]);
  await git(repo, ["config", "user.email", "t@e.com"]);
  await git(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "a.txt"), "one\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "init"]);

  const workRoot = mkdtempSync(join(tmpdir(), "orch-rp-wt-"));
  const wt = await createWorktree(git, { repoPath: repo, workRoot, group: "g1" });

  const db = openMemory();
  const bus = new Bus(db);
  const cfg = { ...loadConfig(), dataDir: mkdtempSync(join(tmpdir(), "orch-rp-data-")), gateRetries: 2 };
  const specs: TurnSpec[] = [];
  let exec: any = null;
  const sched = new Scheduler(db, (j) => exec(j));
  const ctx: Ctx = {
    db,
    bus,
    sched,
    gitLock: new RepoLock(),
    git,
    waiters: new Map(),
    config: { language: cfg.language, difficultyModel: cfg.difficultyModel, workRoot },
  };
  const deps: ExecDeps = {
    ctx,
    cfg,
    roles: loadRoles("roles"),
    git,
    runTurn: async (spec) => {
      specs.push(spec);
      return turnOk();
    },
  };
  exec = makeExecutor(deps);
  ctx.reviewVerdict = makeReviewVerdict(deps);
  ctx.auditVerdict = makeAuditVerdict(deps);

  db.run("INSERT INTO project (name, repo_path, config_json, created_at) VALUES ('p', ?, ?, 0)", [
    repo,
    JSON.stringify({ gates: opts.gates ?? ["test"] }),
  ]);
  db.run("INSERT INTO grp (project_id, name, status, worktree, branch, created_at) VALUES (1, 'g1', 'RUNNING', ?, ?, 0)", [
    wt.worktree,
    wt.branch,
  ]);
  // 'running' is what startNextSlice sets: a task whose slice has not started
  // cannot be completed, so the fixture has to reflect a started slice.
  db.run(
    "INSERT INTO slice (grp_id, seq, title, accept_spec, difficulty, status, created_at) VALUES (1, 1, 'S1', 'a.txt says two', 'trivial', 'running', 0)",
  );
  db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, clearance, token, created_at) VALUES (1, 1, 'engineer', 'm', 'L1', 'tok-eng', 0)",
  );
  db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, clearance, token, created_at) VALUES (1, 1, 'qa', 'm', 'L1', 'tok-qa', 0)",
  );
  db.run("INSERT INTO task (grp_id, slice_id, title, created_at) VALUES (1, 1, 'edit a.txt', 0)");

  const app = makeApp(ctx);
  const post = (path: string, body?: unknown, token?: string) =>
    app(
      new Request(`http://x${path}`, {
        method: "POST",
        body: JSON.stringify(body ?? {}),
        headers: token ? { "x-orch-token": token } : undefined,
      }),
    );

  // Baseline for reconcile, as the executor would set on the slice's first turn.
  const base = await checkpoint(git, repo, wt.worktree, "start");
  db.run("UPDATE slice SET base_sha = ? WHERE id = 1", [base]);

  const gate = (code: number, out = "") =>
    db.run("INSERT OR REPLACE INTO resource (name, template, arg_schema_json, error_regex) VALUES ('test', ?, '{}', '^(FAIL|error)')", [
      // A template is tokenised, not shell-parsed: one argv, no spaces inside a
      // single token, no nesting. That constraint is the point of templates.
      code === 0 ? "true" : `bun -e console.log("${out}");process.exit(${code})`,
    ]);

  return { db, ctx, sched, deps, app, post, repo, wt, specs, gate, git };
}

const doneClaim = (post: any, claim: unknown) =>
  post("/orch/task/done", { task_id: 1, claim }, "tok-eng");

test("a truthful claim with a passing gate reaches QA, not the boss", async () => {
  const h = await harness();
  h.gate(0);
  writeFileSync(join(h.wt.worktree, "a.txt"), "two\n");
  await h.post("/orch/git", { argv: ["commit", "-qam", "edit"] }, "tok-eng");

  await doneClaim(h.post, { files: ["a.txt"], summary: "a.txt now says two" });
  await h.sched.drain();

  expect(gateState(h.db, 1)).toEqual({ reconcile: "pass", gate: "pass" });
  const slice = h.db.query<{ status: string }, []>("SELECT status FROM slice WHERE id = 1").get()!;
  expect(slice.status).toBe("qa");
  // A QA turn was queued; the boss is not involved until QA files a verdict.
  expect(h.specs.some((s) => s.stable.systemAppend.includes("You are QA"))).toBe(true);
});

test("a claim git cannot corroborate is sent back before any reviewer sees it", async () => {
  const h = await harness();
  h.gate(0);
  // Nothing changed on disk, but the claim says otherwise.
  await doneClaim(h.post, { files: ["a.txt"], summary: "edited a.txt" });
  await h.sched.drain();

  expect(gateState(h.db, 1).reconcile).toBe("fail");
  const slice = h.db.query<{ status: string; retries: number }, []>(
    "SELECT status, retries FROM slice WHERE id = 1",
  ).get()!;
  expect(slice.retries).toBe(1);
  // Straight back to the writer — the reviewer's judgement is not spent on this.
  expect(h.specs.some((s) => s.stable.systemAppend.includes("You are QA"))).toBe(false);
  const retry = h.specs.at(-1)!;
  expect(retry.prompt).toContain("Reconcile failed");
  // A retry starts a fresh session: the old history is mostly the failed attempt.
  expect(retry.resumeSessionId).toBeUndefined();
  expect(retry.newSessionId).toBeTruthy();
});

test("a failing gate sends the slice back with the failing lines", async () => {
  const h = await harness();
  h.gate(1, "FAIL_mw_test");
  writeFileSync(join(h.wt.worktree, "a.txt"), "two\n");
  await h.post("/orch/git", { argv: ["commit", "-qam", "edit"] }, "tok-eng");
  await doneClaim(h.post, { files: ["a.txt"] });
  await h.sched.drain();

  expect(gateState(h.db, 1)).toEqual({ reconcile: "pass", gate: "fail" });
  expect(h.specs.at(-1)!.prompt).toContain("FAIL_mw_test");
});

test("repeated failures escalate to the boss instead of looping forever", async () => {
  const h = await harness();
  h.gate(1, "FAIL_again");
  writeFileSync(join(h.wt.worktree, "a.txt"), "two\n");
  await h.post("/orch/git", { argv: ["commit", "-qam", "edit"] }, "tok-eng");

  for (let i = 0; i < 3; i++) {
    h.db.run("UPDATE task SET status = 'done' WHERE id = 1");
    h.ctx.sched.enqueue("gate", { grp_id: 1, slice_id: 1 });
    await h.sched.drain();
  }

  const esc = h.db.query<{ severity: string; question: string }, []>(
    "SELECT severity, question FROM escalation",
  ).get()!;
  expect(esc.severity).toBe("blocker");
  // Two failures usually means the criteria are wrong, not the code — so the
  // message says that rather than just reporting another failure.
  expect(esc.question).toContain("failed gate");
  expect(h.db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()!.status).toBe("PAUSING");
});

test("QA's pass hands the slice to the boss and rotates the sessions", async () => {
  const h = await harness();
  h.db.run("UPDATE agent SET session_id = 'old', session_tokens = 90000");
  await h.post("/orch/review", { slice_id: 1, verdict: "pass", note: "all three criteria met" }, "tok-qa");

  expect(h.db.query<{ status: string }, []>("SELECT status FROM slice WHERE id = 1").get()!.status).toBe(
    "awaiting_boss",
  );
  // The slice boundary is the primary rotation point: cheapest handoff, and it
  // stops a session growing across unrelated work.
  const agents = h.db.query<{ session_id: string | null; session_tokens: number }, []>(
    "SELECT session_id, session_tokens FROM agent",
  ).all();
  expect(agents.every((a) => a.session_id === null && a.session_tokens === 0)).toBe(true);
});

test("QA's fail sends the slice back with QA's note", async () => {
  const h = await harness();
  await h.post("/orch/review", { slice_id: 1, verdict: "fail", note: "criterion 2 unchecked" }, "tok-qa");
  await h.sched.drain();
  expect(h.db.query<{ retries: number }, []>("SELECT retries FROM slice WHERE id = 1").get()!.retries).toBe(1);
  expect(h.specs.at(-1)!.prompt).toContain("criterion 2 unchecked");
});

test("only reviewers may file verdicts, and only for their own group", async () => {
  const h = await harness();
  expect((await h.post("/orch/review", { slice_id: 1, verdict: "pass" }, "tok-eng")).status).toBe(422);
  expect((await h.post("/orch/review", { slice_id: 1, verdict: "maybe" }, "tok-qa")).status).toBe(422);
  expect((await h.post("/orch/review", { slice_id: 99, verdict: "pass" }, "tok-qa")).status).toBe(422);
});

test("a slice with open tasks does not enter review", async () => {
  const h = await harness();
  h.db.run("INSERT INTO task (grp_id, slice_id, title, created_at) VALUES (1, 1, 'second task', 0)");
  await doneClaim(h.post, { files: ["a.txt"] });
  await h.sched.drain();
  // Reviewing half a slice spends judgement on work that is about to change.
  expect(h.db.query<{ c: number }, []>("SELECT count(*) AS c FROM job WHERE kind = 'gate'").get()!.c).toBe(0);
});

test("reserved git actions are refused at the orch boundary", async () => {
  const h = await harness();
  for (const argv of [
    ["push", "origin", "HEAD"],
    ["merge", "main"],
    ["push", "--force"],
    ["reset", "--hard", "HEAD~3"],
  ]) {
    const r = await h.post("/orch/git", { argv }, "tok-eng");
    expect(r.status).toBe(422);
    expect(await r.text()).toContain("refused");
  }
  // A refusal is visible to the boss, not silent — the agent will otherwise go
  // looking for a way around it.
  expect(
    h.db.query<{ c: number }, []>("SELECT count(*) AS c FROM event WHERE kind = 'escalation'").get()!.c,
  ).toBe(4);
});

test("ordinary git work still goes through", () => {
  expect(reservedGitAction(["commit", "-m", "x"])).toBeNull();
  expect(reservedGitAction(["status"])).toBeNull();
  expect(reservedGitAction(["diff", "--name-only"])).toBeNull();
  // Rebasing your own branch onto main is normal and stays allowed.
  expect(reservedGitAction(["rebase", "origin/main"])).toBeNull();
});

test("accepting the last slice starts PR review; accepting an earlier one does not", async () => {
  const h = await harness();
  h.db.run("INSERT INTO slice (grp_id, seq, title, accept_spec, created_at) VALUES (1, 2, 'S2', 'x', 0)");

  await h.post("/api/slices/1/accept");
  expect(h.db.query<{ c: number }, []>("SELECT count(*) AS c FROM job WHERE kind = 'reconcile'").get()!.c).toBe(0);

  await h.post("/api/slices/2/accept");
  // "The boss is satisfied" is not a verdict an agent can reach, so nothing an
  // agent does can start this.
  expect(h.db.query<{ c: number }, []>("SELECT count(*) AS c FROM job WHERE kind = 'reconcile'").get()!.c).toBe(1);
});

test("a group with no retro cannot wind up — the PM is sent back to write one", async () => {
  const h = await harness();
  h.gate(0);
  await h.post("/api/slices/1/accept");
  await h.sched.drain();

  // retro is the only long-term memory this system has, and "later" means never
  // once the branch is merged.
  expect(h.specs.at(-1)!.prompt).toContain("no retro");
  expect(h.db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()!.status).not.toBe("PR_OPEN");
});

test("with a retro and a green branch gate, the Auditor is called in", async () => {
  const h = await harness();
  h.gate(0);
  h.db.run("INSERT INTO note (grp_id, kind, lang, body, at) VALUES (1, 'retro', 'zh', 'S1 返工一次，验收标准写模糊了', 0)");
  await h.post("/api/slices/1/accept");
  await h.sched.drain();

  expect(h.db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()!.status).toBe("PR_OPEN");
  expect(h.specs.some((s) => s.stable.systemAppend.includes("You are the Auditor"))).toBe(true);
});

test("an auditor may not audit its own group", async () => {
  const h = await harness();
  h.db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, clearance, token, created_at) VALUES (1, 1, 'auditor', 'm', 'L2', 'tok-in', 0)",
  );
  h.db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, clearance, token, created_at) VALUES (1, NULL, 'auditor', 'm', 'L2', 'tok-out', 0)",
  );
  // Sharing the group's context means reviewing your own reasoning.
  expect((await h.post("/orch/audit", { group_id: 1, verdict: "pass" }, "tok-in")).status).toBe(422);
  expect((await h.post("/orch/audit", { group_id: 1, verdict: "pass" }, "tok-out")).status).toBe(200);
});

test("a failed audit reopens the group and sends the PM back", async () => {
  const h = await harness();
  h.db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, clearance, token, created_at) VALUES (1, NULL, 'auditor', 'm', 'L2', 'tok-aud', 0)",
  );
  h.db.run("UPDATE grp SET status = 'PR_OPEN' WHERE id = 1");
  await h.post("/orch/audit", { group_id: 1, verdict: "fail", note: "S2's promise is not in the diff" }, "tok-aud");
  await h.sched.drain();

  expect(h.db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()!.status).toBe("RUNNING");
  expect(h.specs.at(-1)!.prompt).toContain("S2's promise is not in the diff");
});

test("accepting a slice starts the next one, and only one runs at a time", async () => {
  const h = await harness();
  h.db.run("INSERT INTO slice (grp_id, seq, title, accept_spec, created_at) VALUES (1, 2, 'S2', 'x', 0)");
  h.db.run("INSERT INTO slice (grp_id, seq, title, accept_spec, created_at) VALUES (1, 3, 'S3', 'x', 0)");

  const { startNextSlice } = await import("../src/mech/review.ts");
  // S1 is already running in the fixture, so nothing new may start: a second
  // in-flight slice would only queue behind the group's single writer and its
  // review would race the first one's.
  expect(startNextSlice(h.ctx, 1)).toBeNull();

  h.db.run("UPDATE slice SET status = 'accepted' WHERE id = 1");
  expect(startNextSlice(h.ctx, 1)).toBe(2);
  h.db.run("UPDATE slice SET status = 'pending' WHERE id = 2");
  await h.post("/api/slices/1/accept");
  const running = h.db
    .query<{ seq: number }, []>("SELECT seq FROM slice WHERE status = 'running'")
    .all()
    .map((r) => r.seq);
  expect(running).toEqual([2]);
});

test("a slice waits for the one it depends on", async () => {
  const h = await harness();
  h.db.run(
    "INSERT INTO slice (grp_id, seq, title, accept_spec, depends_on, created_at) VALUES (1, 2, 'S2', 'x', 1, 0)",
  );
  const { startNextSlice } = await import("../src/mech/review.ts");
  h.db.run("UPDATE slice SET status = 'accepted' WHERE id = 1");
  expect(startNextSlice(h.ctx, 1)).toBe(2);

  const h2 = await harness();
  h2.db.run(
    "INSERT INTO slice (grp_id, seq, title, accept_spec, depends_on, created_at) VALUES (1, 2, 'S2', 'x', 1, 0)",
  );
  h2.db.run("UPDATE slice SET status = 'rejected' WHERE id = 1");
  expect(startNextSlice(h2.ctx, 1)).toBeNull();
});

test("a task on a slice that has not started cannot be listed or completed", async () => {
  const h = await harness();
  h.db.run("INSERT INTO slice (grp_id, seq, title, accept_spec, created_at) VALUES (1, 2, 'S2', 'x', 0)");
  h.db.run("INSERT INTO task (grp_id, slice_id, title, created_at) VALUES (1, 2, 'later work', 0)");
  const list = await (await h.app(new Request("http://x/orch/task?grp=1"))).text();
  // Showing the whole plan let the writer close future slices' tasks, which
  // pushed slices that had never started into review.
  expect(list).toContain("edit a.txt");
  expect(list).not.toContain("later work");

  const done = await h.post("/orch/task/done", { task_id: 2, claim: { files: ["a.txt"] } }, "tok-eng");
  expect(done.status).toBe(422);
  expect(await done.text()).toContain("not being worked");

  const claim = await h.post("/orch/task/claim", { task_id: 2 }, "tok-eng");
  expect(claim.status).toBe(422);
});
