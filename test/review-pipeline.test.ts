import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeApp, type Ctx } from "../src/api.ts";
import { Bus } from "../src/bus.ts";
import { loadConfig, loadRoles } from "../src/config.ts";
import { openMemory } from "../src/db.ts";
import { RepoLock } from "../src/mech/gitlock.ts";
import { gateState } from "../src/mech/gate.ts";
import { handToBoss } from "../src/mech/review.ts";
import { makeGitRunner, checkpoint } from "../src/mech/worktree.ts";
import { Scheduler, type Job } from "../src/scheduler.ts";
import {
  makeAuditVerdict,
  makeExecutor,
  makeReviewVerdict,
  type ExecDeps,
} from "../src/runtime/executor.ts";
import type { TurnResult, TurnSpec } from "../src/runtime/claude.ts";
import { fakeSandbox } from "./fake-sandbox.ts";
import { WORK } from "../src/mech/sandbox.ts";

const git = makeGitRunner(new RepoLock());

function turnOk(): TurnResult {
  return {
    sessionId: "s",
    ok: true,
    terminalReason: "completed",
    text: "done",
    usage: { input: 1, output: 1, cacheRead: 0, cacheCreate: 0, thinking: 0 },
    numTurns: 1,
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

  // The group's checkout: a clone, the way it is inside a sandbox.
  const wtDir = mkdtempSync(join(tmpdir(), "orch-rp-wt-"));
  const work = join(wtDir, "work");
  await git(wtDir, ["clone", "-q", repo, work]);
  await git(work, ["config", "user.email", "a@orch.local"], work);
  await git(work, ["config", "user.name", "orch agent"], work);
  await git(work, ["checkout", "-q", "-b", "orch/g1"], work);
  const wt = { worktree: work, branch: "orch/g1" };

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
    // The gates run in the group's sandbox. Here they run in this process, which
    // is all these tests need: what is under test is what the pipeline does with
    // an exit code, not how a command is spawned.
    sandbox: fakeSandbox((cmd, cwd) => {
      // In the group's checkout, never in this process's. Without the cwd these
      // spawns ran `git add -A && git commit` in the orchestrator's own repo.
      const p = Bun.spawnSync(["sh", "-c", cmd], { cwd: cwd === WORK || !cwd ? work : cwd, stdout: "pipe", stderr: "pipe" });
      return {
        code: p.exitCode,
        out: p.stdout.toString(),
        err: p.stderr.toString(),
      };
    }), waiters: new Map(),
    config: { language: cfg.language, workRoot: wtDir },
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

const REVIEW = "pass: a.txt contains two — the diff line adds it";

const doneClaim = (post: any, claim: unknown) =>
  post("/orch/task/done", { task_id: 1, claim, review: REVIEW }, "tok-eng");

test("a truthful claim with a passing gate reaches QA, not the boss", async () => {
  const h = await harness();
  h.gate(0);
  writeFileSync(join(h.wt.worktree, "a.txt"), "two\n");
  await h.post("/orch/git", { argv: ["commit", "-qam", "edit"] }, "tok-eng");

  await doneClaim(h.post, { files: ["a.txt"], summary: "a.txt now says two" });
  await h.sched.drain();

  // self is layer 1 and is recorded by `task done --review`, before the two
  // deterministic layers run.
  expect(gateState(h.db, 1)).toEqual({ self: "pass", reconcile: "pass", gate: "pass" });
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

  expect(gateState(h.db, 1)).toEqual({ self: "pass", reconcile: "pass", gate: "fail" });
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
  await h.post("/orch/review", { slice_id: 1, verdict: "fail", note: "fail: criterion 2 unchecked" }, "tok-qa");
  await h.sched.drain();
  expect(h.db.query<{ retries: number }, []>("SELECT retries FROM slice WHERE id = 1").get()!.retries).toBe(1);
  expect(h.specs.at(-1)!.prompt).toContain("criterion 2 unchecked");
});

test("a verdict with nothing behind it is refused", async () => {
  // `--verdict pass` with an empty note was accepted, which makes the independent
  // check a formality and leaves "the criterion itself was wrong" to surface three
  // slices later.
  const h = await harness();
  expect((await h.post("/orch/review", { slice_id: 1, verdict: "pass" }, "tok-qa")).status).toBe(422);
  const vague = await h.post("/orch/review", { slice_id: 1, verdict: "pass", note: "looks good" }, "tok-qa");
  expect(vague.status).toBe(422);
  expect(await vague.text()).toContain("carries no information");
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
  // ...but it has to say that it is hiding them. Live, an engineer read the short
  // list as "S2 has no cards" and filed a blocker asking the boss to create them.
  expect(list).toContain("S2: 1 cards, not yet open");
  expect(list).toContain("do not ask the boss");

  const done = await h.post("/orch/task/done", { task_id: 2, claim: { files: ["a.txt"] }, review: REVIEW }, "tok-eng");
  expect(done.status).toBe(422);
  expect(await done.text()).toContain("not being worked");

  const claim = await h.post("/orch/task/claim", { task_id: 2 }, "tok-eng");
  expect(claim.status).toBe(422);
});

test("the Auditor is hired outside the group it audits, and told how to read the branch", async () => {
  const h = await harness();
  h.gate(0);
  h.db.run("INSERT INTO note (grp_id, kind, lang, body, at) VALUES (1, 'retro', 'zh', 'S1 返工一次', 0)");
  await h.post("/api/slices/1/accept");
  await h.sched.drain();

  const auditor = h.db
    .query<{ grp_id: number | null; project_id: number | null }, []>(
      "SELECT grp_id, project_id FROM agent WHERE role = 'auditor'",
    )
    .get()!;
  // Inside the group it would be reviewing its own reasoning, and `orch audit`
  // refuses that — so the turn would fail with the branch already finished.
  expect(auditor.grp_id).toBeNull();
  expect(auditor.project_id).toBe(1);

  const spec = h.specs.find((s) => s.stable.systemAppend.includes("You are the Auditor"))!;
  expect(spec.prompt).toContain("group_id 1");
  expect(spec.prompt).toContain("orch audit 1 --verdict");
  // It is in the main checkout, so it needs to be told how to see the branch.
  expect(spec.prompt).toContain("git diff main...orch/g1");
});

test("task done refuses an empty claim — otherwise reconcile is vacuous", async () => {
  const h = await harness();
  // Observed live: every claim arrived as {}, so "claimed vs actual" had degenerated
  // into "did anything change at all".
  for (const body of [{ task_id: 1 }, { task_id: 1, claim: {} }, { task_id: 1, claim: "" }]) {
    const r = await h.post("/orch/task/done", body, "tok-eng");
    expect(r.status).toBe(422);
    expect(await r.text()).toContain("--claim");
  }
  const ok = await h.post("/orch/task/done", { task_id: 1, claim: { files: ["a.txt"] }, review: REVIEW }, "tok-eng");
  expect(ok.status).toBe(200);
});

test("--already-done is accepted and recorded as such", async () => {
  const h = await harness();
  const r = await h.post(
    "/orch/task/done",
    { task_id: 1, already_done: "S1 covered it", review: "pass: nothing to change — S1 already did it" },
    "tok-eng",
  );
  expect(r.status).toBe(200);
  const claim = JSON.parse(
    h.db.query<{ claim_json: string }, []>("SELECT claim_json FROM task WHERE id = 1").get()!.claim_json,
  );
  expect(claim.already_done).toBe("S1 covered it");
});

test("writing the retro resumes PR-level review instead of dead-ending", async () => {
  const h = await harness();
  h.gate(0);
  // Every slice accepted but no retro: review asks for one and stops.
  await h.post("/api/slices/1/accept");
  await h.sched.drain();
  expect(h.specs.at(-1)!.prompt).toContain("no retro");

  const before = h.db.query<{ c: number }, []>("SELECT count(*) AS c FROM job WHERE kind = 'reconcile'").get()!.c;
  await h.post(
    "/orch/journal",
    { kind: "retro", body: "S1 返工一次，验收标准写模糊了" },
    "tok-eng",
  );
  // Without this the PM writes a retro nobody asked for again and the finished
  // branch sits unreviewed until someone nudges it by hand.
  const after = h.db.query<{ c: number }, []>("SELECT count(*) AS c FROM job WHERE kind = 'reconcile'").get()!.c;
  expect(after).toBe(before + 1);
});

test("a retro written mid-flight does not trigger PR review", async () => {
  const h = await harness();
  h.db.run("INSERT INTO slice (grp_id, seq, title, accept_spec, created_at) VALUES (1, 2, 'S2', 'x', 0)");
  await h.post("/orch/journal", { kind: "retro", body: "早写的 retro" }, "tok-eng");
  expect(h.db.query<{ c: number }, []>("SELECT count(*) AS c FROM job WHERE kind = 'reconcile'").get()!.c).toBe(0);
});

test("a trivial slice is accepted automatically once all three gates pass", async () => {
  const h = await harness();
  h.ctx.config.autoAcceptTiers = ["trivial"];
  h.db.run("INSERT INTO slice (grp_id, seq, title, accept_spec, difficulty, status, created_at) VALUES (1, 2, 'S2', 'b', 'normal', 'pending', 0)");

  handToBoss({ ctx: h.ctx }, 1);

  const s1 = h.db.query<{ status: string }, [number]>("SELECT status FROM slice WHERE id = ?").get(1)!;
  // Three gates still ran; this skips the boss's look, not the verification.
  expect(s1.status).toBe("accepted");
  // Announced, never silent: an acceptance nobody can see cannot be audited.
  const said = h.db
    .query<{ body: string; author: string }, []>("SELECT author, body FROM event ORDER BY seq DESC")
    .all()
    .find((e) => e.body.includes("自动查收"))!;
  expect(said.author).toBe("orchestrator");
  expect(said.body).toContain("自动查收");
  // And the next slice starts, which is the point of the whole thing.
  expect(h.db.query<{ status: string }, [number]>("SELECT status FROM slice WHERE id = ?").get(2)!.status)
    .not.toBe("pending");
});

test("a normal slice still waits for the boss even with trivial auto-accept on", async () => {
  const h = await harness();
  h.ctx.config.autoAcceptTiers = ["trivial"];
  h.db.run("UPDATE slice SET difficulty = 'normal' WHERE id = 1");

  handToBoss({ ctx: h.ctx }, 1);
  expect(h.db.query<{ status: string }, [number]>("SELECT status FROM slice WHERE id = ?").get(1)!.status)
    .toBe("awaiting_boss");
});

test("with nothing configured, every slice waits for the boss", async () => {
  const h = await harness();
  handToBoss({ ctx: h.ctx }, 1);
  expect(h.db.query<{ status: string }, [number]>("SELECT status FROM slice WHERE id = ?").get(1)!.status)
    .toBe("awaiting_boss");
});


test("the task that closes a slice needs a self-review, and vacuous does not count", async () => {
  const h = await harness();
  writeFileSync(join(h.wt.worktree, "a.txt"), "two\n");

  // The Engineer's role prompt has always said a content-free self-review would be
  // rejected. Until this check existed, nothing rejected anything — the prompt was
  // describing a gate that was not there.
  const none = await h.post("/orch/task/done", { task_id: 1, claim: { files: ["a.txt"] } }, "tok-eng");
  expect(none.status).toBe(422);
  expect(await none.text()).toContain("--review");

  const vacuous = await h.post(
    "/orch/task/done",
    { task_id: 1, claim: { files: ["a.txt"] }, review: "looks good" },
    "tok-eng",
  );
  expect(vacuous.status).toBe(422);
  expect(await vacuous.text()).toContain("carries no information");

  const ok = await h.post(
    "/orch/task/done",
    { task_id: 1, claim: { files: ["a.txt"] }, review: "pass: a.txt says two — the diff adds that line" },
    "tok-eng",
  );
  expect(ok.status).toBe(200);
  // Recorded as the gate layer it is, so the panel can draw the first tick and the
  // evidence panel can show what was claimed.
  const gates = JSON.parse(
    h.db.query<{ gates_json: string }, []>("SELECT gates_json FROM slice WHERE id = 1").get()!.gates_json,
  );
  expect(gates.self).toBe("pass");
  const filed = h.db
    .query<{ body: string; author: string }, []>(
      "SELECT author, body FROM event WHERE kind = 'gate_result' ORDER BY seq",
    )
    .all()
    .find((e) => e.body.includes("a.txt says two"))!;
  expect(filed.author).toBe("engineer");
});

test("a branch the Auditor keeps rejecting stops instead of paying for another round", async () => {
  // A slice that keeps failing gives up after gateRetries and asks the boss. The
  // branch had no counter at all — the same money spent forever on the same
  // disagreement, with nothing on the boss's screen saying so.
  const h = await harness();
  h.ctx.auditVerdict!(1, false, "the error path is still untested");
  h.ctx.auditVerdict!(1, false, "still untested");
  expect(h.db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()!.status).toBe("RUNNING");

  h.ctx.auditVerdict!(1, false, "and again");
  const g = h.db.query<{ status: string; pr_retries: number }, []>("SELECT status, pr_retries FROM grp WHERE id = 1").get()!;
  expect(g.status).toBe("PAUSED");
  expect(g.pr_retries).toBe(3);
  const esc = h.db
    .query<{ severity: string; chain_state: string; question: string }, []>(
      "SELECT severity, chain_state, question FROM escalation ORDER BY id DESC LIMIT 1",
    )
    .get()!;
  expect(esc.severity).toBe("blocker");
  expect(esc.chain_state).toBe("boss");
  // The likely cause, said out loud: three rounds usually means the acceptance
  // wording is wrong, not the code.
  expect(esc.question).toContain("验收口径");
});
