import { expect, test } from "bun:test";
import { said } from "../support/said.ts";
import { gitFixture, testGit } from "../support/git-runner.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeApp } from "../../src/composition/api.ts";
import type { Ctx } from "../../src/mech/ctx.ts";
import { Bus } from "../../src/platform/persistence/event-bus.ts";
import { loadConfig, loadRoles } from "../../src/platform/config/load.ts";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { gateState } from "../../src/mech/gate.ts";
import { TaskClaimSchema } from "../../src/mech/flow/reconcile.ts";
import { runInvariants } from "../../src/mech/ops/invariants.ts";
import { handToBoss } from "../../src/mech/flow/review.ts";
import { checkpoint } from "../../src/mech/git/gitops.ts";
import { AgentTurnPayloadSchema, Scheduler, type Executor } from "../../src/platform/scheduling/scheduler.ts";
import { makeAuditVerdict, makeExecutor, makeReviewVerdict, type ExecDeps } from "../../src/application/executor.ts";
import type { TurnResult, TurnSpec } from "../../src/runtime/claude.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";
import { WORK } from "../../src/mech/sandbox/sandbox.ts";
import { seedAuth } from "../support/seed-auth.ts";
import type { Json } from "../../src/contracts/json.ts";
import { count, desc, eq } from "drizzle-orm";
import {
  agent as agentTable,
  escalation as escalationTable,
  event as eventTable,
  grp as grpTable,
  job as jobTable,
  resource as resourceTable,
  slice as sliceTable,
  task as taskTable,
} from "../../src/platform/persistence/schema.ts";
import * as fx from "../support/factories.ts";
import { z } from "zod";
import { tempDir } from "../support/temp.ts";

const GateResults = z.record(z.string(), z.string());

const git = testGit;

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

/** Real Git is reserved for the four tests whose subject is reconcile itself. */
async function harness(opts: { gates?: string[]; realGit?: boolean } = {}) {
  const realGit = opts.realGit ?? false;
  // Reconcile's four integration cases use the same clone shape as a sandbox.
  // `gitFixture` builds that origin-and-clone pair once for the file and copies
  // it, so the four do not each replay the same six commands to arrive at the
  // same repository — measured at 112ms of git per harness against 0.6ms.
  const fixture = realGit ? await gitFixture("orch-rp-") : null;
  const work = fixture ? fixture.work : tempDir("orch-rp-wt-");
  const repo = fixture ? fixture.origin : work;
  if (!fixture) await Bun.write(join(work, "a.txt"), "one\n");
  const wt = { worktree: work, branch: "orch/g1" };

  const db = await openMemory();

  await seedAuth(db);
  const bus = new Bus(db);
  const cfg = { ...loadConfig(), dataDir: tempDir("orch-rp-data-"), gateRetries: 2 };
  const specs: TurnSpec[] = [];
  let exec: Executor;
  const sched = new Scheduler(db, (j) => exec(j));
  const ctx: Ctx = {
    db,
    bus,
    sched,
    // The gates run in the group's sandbox. Here they run in this process, which
    // is all these tests need: what is under test is what the pipeline does with
    // an exit code, not how a command is spawned.
    sandbox: fakeSandbox((cmd, cwd) => {
      if (!realGit) {
        const failure = /console\.log\("([^"]*)"\);process\.exit\((\d+)\)/.exec(cmd);
        return failure ? { code: Number(failure[2]), out: failure[1] ?? "" } : { code: 0 };
      }
      // In the group's checkout, never in this process's. Without the cwd these
      // spawns ran `git add -A && git commit` in the orchestrator's own repo.
      const p = Bun.spawnSync(["sh", "-c", cmd], {
        cwd: cwd === WORK || !cwd ? work : cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        code: p.exitCode,
        out: p.stdout.toString(),
        err: p.stderr.toString(),
      };
    }),
    waiters: new Map(),
    config: cfg,
  };
  const deps: ExecDeps = {
    ctx,
    cfg,
    roles: loadRoles("roles"),
    runTurn: async (spec) => {
      specs.push(spec);
      return turnOk();
    },
  };
  exec = makeExecutor(deps);
  ctx.reviewVerdict = makeReviewVerdict(deps);
  ctx.auditVerdict = makeAuditVerdict(deps);

  const f = fx.on(db);
  const p = await f.project.create({
    name: "p",
    repo_path: repo,
    config_json: { gates: opts.gates ?? ["test"] },
  });
  const g = await f.runningGrp.create({ project_id: p.id, name: "g1", branch: wt.branch });
  // 'running' is what startNextSlice sets: a task whose slice has not started
  // cannot be completed, so the fixture has to reflect a started slice.
  const s = await f.slice.create({
    grp_id: g.id,
    seq: 1,
    title: "S1",
    accept_spec: "a.txt says two",
    difficulty: "trivial",
    status: "running",
  });
  await f.agent.create({ project_id: p.id, grp_id: g.id, token: "tok-eng" });
  await f.agent.create({ project_id: p.id, grp_id: g.id, role: "qa", token: "tok-qa" });
  await f.task.create({ grp_id: g.id, slice_id: s.id, title: "edit a.txt" });

  const app = makeApp(ctx);
  const post = (path: string, body?: Json, token?: string) =>
    app(
      new Request(`http://x${path}`, {
        method: "POST",
        body: JSON.stringify(body ?? {}),
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
          ...(token ? { "x-orch-token": token } : {}),
        },
      }),
    );

  // Baseline for reconcile, as the executor would set on the slice's first turn.
  const base = realGit ? await checkpoint(git, wt.worktree, "start") : null;
  await db.update(sliceTable).set({ base_sha: base }).where(eq(sliceTable.id, 1));

  const gate = (code: number, out = "") => {
    // A template is tokenised, not shell-parsed: one argv, no spaces inside a
    // single token, no nesting. That constraint is the point of templates.
    const template = code === 0 ? "true" : `bun -e console.log("${out}");process.exit(${code})`;
    const row = { name: "test", template, arg_schema_json: {}, error_regex: "^(FAIL|error)" };
    return db.insert(resourceTable).values(row).onConflictDoUpdate({ target: resourceTable.name, set: row });
  };

  return { db, ctx, sched, deps, app, post, repo, wt, specs, gate, git };
}

const REVIEW = "pass: a.txt contains two — the diff line adds it";

type Post = (path: string, body?: Json, token?: string) => Promise<Response>;
const doneClaim = (post: Post, claim: Json) =>
  post("/orch/v1/task/done", { task_id: 1, claim, review: REVIEW }, "tok-eng");

/**
 * The four real-git cases used to run `test.concurrent`, and cannot any more:
 * one the test database serves the process and `openMemory()` empties it, so a second
 * harness building its fixture deletes the first one's rows mid-test. Serial
 * they are, and serial they exceed bun's 5s default — measured at 5006ms here,
 * with the timeout leaking a `retries` of 2 into the next test. Same number and
 * same reason as the branch-audit case further down.
 */
const REAL_GIT_MS = 30_000;

test(
  "a truthful claim with a passing gate reaches QA, not the boss",
  async () => {
    const h = await harness({ realGit: true });
    await h.gate(0);
    writeFileSync(join(h.wt.worktree, "a.txt"), "two\n");
    await h.git(["commit", "-qam", "edit"], h.wt.worktree);

    await doneClaim(h.post, { files: ["a.txt"], summary: "a.txt now says two" });
    await h.sched.drain();

    // self is layer 1 and is recorded by `task done --review`, before the two
    // deterministic layers run.
    expect(await gateState(h.db, 1)).toEqual({ self: "pass", reconcile: "pass", gate: "pass" });
    const [slice] = await h.db.select({ status: sliceTable.status }).from(sliceTable).where(eq(sliceTable.id, 1));
    expect(slice!.status).toBe("qa");
    // A QA turn was queued; the boss is not involved until QA files a verdict.
    expect(h.specs.map((s) => s.stable.systemAppend).join("\n")).toContain("You are QA");
  },
  REAL_GIT_MS,
);

test(
  "a claim git cannot corroborate is sent back before any reviewer sees it",
  async () => {
    const h = await harness({ realGit: true });
    await h.gate(0);
    // Nothing changed on disk, but the claim says otherwise.
    await doneClaim(h.post, { files: ["a.txt"], summary: "edited a.txt" });
    await h.sched.drain();

    expect((await gateState(h.db, 1)).reconcile).toBe("fail");
    const [slice] = await h.db
      .select({ status: sliceTable.status, retries: sliceTable.retries })
      .from(sliceTable)
      .where(eq(sliceTable.id, 1));
    expect(slice!.retries).toBe(1);
    // Straight back to the writer — the reviewer's judgement is not spent on this.
    expect(h.specs.filter((s) => s.stable.systemAppend.includes("You are QA"))).toEqual([]);
    const retry = h.specs.at(-1)!;
    expect(retry.prompt).toContain("Reconcile failed");
    // A retry starts a fresh session: the old history is mostly the failed attempt.
    expect(retry.resumeSessionId).toBeUndefined();
    expect(retry.newSessionId).toBeTruthy();
  },
  REAL_GIT_MS,
);

test(
  "a failing gate sends the slice back with the failing lines",
  async () => {
    const h = await harness({ realGit: true });
    await h.gate(1, "FAIL_mw_test");
    writeFileSync(join(h.wt.worktree, "a.txt"), "two\n");
    await h.git(["commit", "-qam", "edit"], h.wt.worktree);
    await doneClaim(h.post, { files: ["a.txt"], summary: "a.txt now says two" });
    await h.sched.drain();

    expect(await gateState(h.db, 1)).toEqual({ self: "pass", reconcile: "pass", gate: "fail" });
    expect(h.specs.at(-1)!.prompt).toContain("FAIL_mw_test");
  },
  REAL_GIT_MS,
);

test(
  "repeated failures escalate to the boss instead of looping forever",
  async () => {
    const h = await harness({ realGit: true });
    await h.gate(1, "FAIL_again");
    writeFileSync(join(h.wt.worktree, "a.txt"), "two\n");
    await h.git(["commit", "-qam", "edit"], h.wt.worktree);

    for (let i = 0; i < 3; i++) {
      await h.db.update(taskTable).set({ status: "done" }).where(eq(taskTable.id, 1));
      await h.ctx.sched.enqueue("gate", { grp_id: 1, slice_id: 1 });
      await h.sched.drain();
    }

    const [esc] = await h.db.select().from(escalationTable);
    expect(esc!.severity).toBe("blocker");
    // The three values it is built from, not a copy of the sentence they go into:
    // the wording is the catalogue's and the boss reads it in their own language.
    expect(esc!.brief).toContain("S1");
    expect(esc!.brief).toContain("gate");
    expect(esc!.brief).toContain("3");
    expect(esc!.kind).toBe("spec");
    expect(esc!.chain_state).toBe("boss");
    // The question carries the gate's own output, which is the part no catalogue
    // owns — the sentence around it is the catalogue's, and the boss reads it in
    // their own language. The identity of that sentence is checked by `said`.
    expect(esc!.question).toContain("Reconcile failed");
    expect(esc!.question_said).toMatchObject(said('S{seq} "{title}" failed {from} {n} times. Latest:\n{feedback}'));
    expect((await h.db.select({ status: grpTable.status }).from(grpTable).where(eq(grpTable.id, 1)))[0]!.status).toBe(
      "PAUSING",
    );
  },
  REAL_GIT_MS,
);

test("QA's pass hands the slice to the boss and rotates the sessions", async () => {
  const h = await harness();
  await h.db.update(sliceTable).set({ difficulty: "hard" }).where(eq(sliceTable.id, 1));
  await h.db.update(agentTable).set({ session_id: "old", session_tokens: 90000 });
  await h.post("/orch/v1/review", { slice_id: 1, verdict: "pass", note: "all three criteria met" }, "tok-qa");

  expect(
    (await h.db.select({ status: sliceTable.status }).from(sliceTable).where(eq(sliceTable.id, 1)))[0]!.status,
  ).toBe("awaiting_boss");
  // The slice boundary is the primary rotation point: cheapest handoff, and it
  // stops a session growing across unrelated work.
  const agents = await h.db
    .select({ session_id: agentTable.session_id, session_tokens: agentTable.session_tokens })
    .from(agentTable);
  expect(agents.filter((a) => a.session_id !== null || a.session_tokens !== 0)).toEqual([]);
});

test("QA's fail sends the slice back with QA's note", async () => {
  const h = await harness();
  await h.post("/orch/v1/review", { slice_id: 1, verdict: "fail", note: "fail: criterion 2 unchecked" }, "tok-qa");
  await h.sched.drain();
  expect(
    (await h.db.select({ retries: sliceTable.retries }).from(sliceTable).where(eq(sliceTable.id, 1)))[0]!.retries,
  ).toBe(1);
  expect(h.specs.at(-1)!.prompt).toContain("criterion 2 unchecked");
});

test("a verdict with nothing behind it is refused", async () => {
  // `--verdict pass` with an empty note was accepted, which makes the independent
  // check a formality and leaves "the criterion itself was wrong" to surface three
  // slices later.
  const h = await harness();
  expect((await h.post("/orch/v1/review", { slice_id: 1, verdict: "pass" }, "tok-qa")).status).toBe(422);
  const vague = await h.post("/orch/v1/review", { slice_id: 1, verdict: "pass", note: "looks good" }, "tok-qa");
  expect(vague.status).toBe(422);
  expect(await vague.text()).toContain("carries no information");
});

test("only reviewers may file verdicts, and only for their own group", async () => {
  const h = await harness();
  expect((await h.post("/orch/v1/review", { slice_id: 1, verdict: "pass" }, "tok-eng")).status).toBe(422);
  expect((await h.post("/orch/v1/review", { slice_id: 1, verdict: "maybe" }, "tok-qa")).status).toBe(400);
  expect((await h.post("/orch/v1/review", { slice_id: 99, verdict: "pass" }, "tok-qa")).status).toBe(422);
});

test("a slice with open tasks does not enter review", async () => {
  const h = await harness();
  await fx.on(h.db).task.create({ grp_id: 1, slice_id: 1, title: "second task" });
  await doneClaim(h.post, { files: ["a.txt"] });
  await h.sched.drain();
  // Reviewing half a slice spends judgement on work that is about to change.
  expect((await h.db.select({ c: count() }).from(jobTable).where(eq(jobTable.kind, "gate")))[0]!.c).toBe(0);
});

test("accepting the last slice starts PR review; accepting an earlier one does not", async () => {
  const h = await harness();
  await fx.on(h.db).slice.create({ grp_id: 1, seq: 2, title: "S2" });

  await h.post("/api/v1/slices/1/accept");
  expect((await h.db.select({ c: count() }).from(jobTable).where(eq(jobTable.kind, "reconcile")))[0]!.c).toBe(0);

  await h.post("/api/v1/slices/2/accept");
  // "The boss is satisfied" is not a verdict an agent can reach, so nothing an
  // agent does can start this.
  expect((await h.db.select({ c: count() }).from(jobTable).where(eq(jobTable.kind, "reconcile")))[0]!.c).toBe(1);
});

test("a group with no retro cannot wind up — the PM is sent back to write one", async () => {
  const h = await harness();
  await h.gate(0);
  await h.post("/api/v1/slices/1/accept");
  await h.sched.drain();

  // retro is the only long-term memory this system has, and "later" means never
  // once the branch is merged.
  expect(h.specs.at(-1)!.prompt).toContain("no retro");
  expect((await h.db.select({ status: grpTable.status }).from(grpTable).where(eq(grpTable.id, 1)))[0]!.status).not.toBe(
    "PR_OPEN",
  );
});

test("with a retro and a green branch gate, the Auditor is called in", async () => {
  const h = await harness();
  await h.gate(0);
  await fx.on(h.db).note.create({ grp_id: 1, kind: "retro", body: "S1 返工一次，验收标准写模糊了" });
  await h.post("/api/v1/slices/1/accept");
  await h.sched.drain();

  expect((await h.db.select({ status: grpTable.status }).from(grpTable).where(eq(grpTable.id, 1)))[0]!.status).toBe(
    "PR_OPEN",
  );
  expect(h.specs.map((s) => s.stable.systemAppend).join("\n")).toContain("You are the Auditor");
});

test("an auditor may not audit its own group", async () => {
  const h = await harness();
  await fx.on(h.db).agent.create({ project_id: 1, grp_id: 1, role: "auditor", token: "tok-in" });
  await fx.on(h.db).agent.create({ project_id: 1, role: "auditor", token: "tok-out" });
  // Sharing the group's context means reviewing your own reasoning.
  expect((await h.post("/orch/v1/audit", { group_id: 1, verdict: "pass" }, "tok-in")).status).toBe(422);
  expect((await h.post("/orch/v1/audit", { group_id: 1, verdict: "pass" }, "tok-out")).status).toBe(200);
});

test("a failed audit reopens the group and sends the PM back", async () => {
  const h = await harness();
  await fx.on(h.db).agent.create({ project_id: 1, role: "auditor", token: "tok-aud" });
  await h.db.update(grpTable).set({ status: "PR_OPEN" }).where(eq(grpTable.id, 1));
  await h.post("/orch/v1/audit", { group_id: 1, verdict: "fail", note: "S2's promise is not in the diff" }, "tok-aud");
  await h.sched.drain();

  expect((await h.db.select({ status: grpTable.status }).from(grpTable).where(eq(grpTable.id, 1)))[0]!.status).toBe(
    "RUNNING",
  );
  expect(h.specs.at(-1)!.prompt).toContain("S2's promise is not in the diff");
});

test("accepting a slice starts the next one, and only one runs at a time", async () => {
  const h = await harness();
  await fx.on(h.db).slice.create({ grp_id: 1, seq: 2, title: "S2" });
  await fx.on(h.db).slice.create({ grp_id: 1, seq: 3, title: "S3" });

  const { startNextSlice } = await import("../../src/mech/flow/review.ts");
  // S1 is already running in the fixture, so nothing new may start: a second
  // in-flight slice would only queue behind the group's single writer and its
  // review would race the first one's.
  expect(await startNextSlice(h.ctx, 1)).toBeNull();

  await h.db.update(sliceTable).set({ status: "accepted" }).where(eq(sliceTable.id, 1));
  expect(await startNextSlice(h.ctx, 1)).toBe(2);
  await h.db.update(sliceTable).set({ status: "pending" }).where(eq(sliceTable.id, 2));
  // S1 back to where the boss actually accepts from. It was left `accepted` here,
  // so this step was re-accepting an already-accepted slice — which `acceptSlice`
  // now refuses, because a second acceptance is a second carry-over note.
  await h.db.update(sliceTable).set({ status: "awaiting_boss" }).where(eq(sliceTable.id, 1));
  await h.post("/api/v1/slices/1/accept");
  const running = (
    await h.db.select({ seq: sliceTable.seq }).from(sliceTable).where(eq(sliceTable.status, "running"))
  ).map((r) => r.seq);
  expect(running).toEqual([2]);
});

test("a slice waits for the one it depends on", async () => {
  const h = await harness();
  await fx.on(h.db).slice.create({ grp_id: 1, seq: 2, title: "S2", depends_on: 1 });
  const { startNextSlice } = await import("../../src/mech/flow/review.ts");
  await h.db.update(sliceTable).set({ status: "accepted" }).where(eq(sliceTable.id, 1));
  expect(await startNextSlice(h.ctx, 1)).toBe(2);

  const h2 = await harness();
  await fx.on(h2.db).slice.create({ grp_id: 1, seq: 2, title: "S2", depends_on: 1 });
  await h2.db.update(sliceTable).set({ status: "rejected" }).where(eq(sliceTable.id, 1));
  expect(await startNextSlice(h2.ctx, 1)).toBeNull();
});

test("a task on a slice that has not started cannot be listed or completed", async () => {
  const h = await harness();
  await fx.on(h.db).slice.create({ grp_id: 1, seq: 2, title: "S2" });
  await fx.on(h.db).task.create({ grp_id: 1, slice_id: 2, title: "later work" });
  const list = await (
    await h.app(new Request("http://x/orch/v1/task", { headers: { "x-orch-token": "tok-eng" } }))
  ).text();
  // Showing the whole plan let the writer close future slices' tasks, which
  // pushed slices that had never started into review.
  expect(list).toContain("edit a.txt");
  expect(list).not.toContain("later work");
  // ...but it has to say that it is hiding them. Live, an engineer read the short
  // list as "S2 has no cards" and filed a blocker asking the boss to create them.
  expect(list).toContain("S2: 1 cards, not yet open");
  expect(list).toContain("do not ask the boss");

  const done = await h.post(
    "/orch/v1/task/done",
    { task_id: 2, claim: { files: ["a.txt"], summary: "a.txt now says two" }, review: REVIEW },
    "tok-eng",
  );
  expect(done.status).toBe(422);
  expect(await done.text()).toContain("not being worked");

  const claim = await h.post("/orch/v1/task/claim", { task_id: 2 }, "tok-eng");
  expect(claim.status).toBe(422);
});

test("the Auditor is hired outside the group it audits, and told how to read the branch", async () => {
  const h = await harness();
  await h.gate(0);
  await fx.on(h.db).note.create({ grp_id: 1, kind: "retro", body: "S1 返工一次" });
  await h.post("/api/v1/slices/1/accept");
  await h.sched.drain();

  const [auditor] = await h.db
    .select({ grp_id: agentTable.grp_id, project_id: agentTable.project_id })
    .from(agentTable)
    .where(eq(agentTable.role, "auditor"));
  // Inside the group it would be reviewing its own reasoning, and `orch audit`
  // refuses that — so the turn would fail with the branch already finished.
  expect(auditor!.grp_id).toBeNull();
  expect(auditor!.project_id).toBe(1);

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
  const invalidBodies: Json[] = [{ task_id: 1 }, { task_id: 1, claim: {} }, { task_id: 1, claim: "" }];
  for (const body of invalidBodies) {
    const r = await h.post("/orch/v1/task/done", body, "tok-eng");
    expect(r.status).toBe(400);
  }
  const ok = await h.post(
    "/orch/v1/task/done",
    { task_id: 1, claim: { files: ["a.txt"], summary: "a.txt now says two" }, review: REVIEW },
    "tok-eng",
  );
  expect(ok.status).toBe(200);
});

test("--already-done is accepted and recorded as such", async () => {
  const h = await harness();
  const r = await h.post(
    "/orch/v1/task/done",
    { task_id: 1, already_done: "S1 covered it", review: "pass: nothing to change — S1 already did it" },
    "tok-eng",
  );
  expect(r.status).toBe(200);
  const [row] = await h.db.select({ claim_json: taskTable.claim_json }).from(taskTable).where(eq(taskTable.id, 1));
  const claim = TaskClaimSchema.parse(row!.claim_json);
  expect("already_done" in claim ? claim.already_done : undefined).toBe("S1 covered it");
});

test("writing the retro resumes PR-level review instead of dead-ending", async () => {
  const h = await harness();
  await h.gate(0);
  // Every slice accepted but no retro: review asks for one and stops.
  await h.post("/api/v1/slices/1/accept");
  await h.sched.drain();
  // Any of them, not the last one. `drain` dispatches every pending turn, and
  // which finishes last is the scheduler's business — this failed once on CI's
  // four cores and never on ten. What the test is about is that review asks for
  // the retro rather than dead-ending, which is a claim about the prompt existing.
  expect(h.specs.filter((s) => s.prompt.includes("no retro"))).not.toEqual([]);

  const before = (await h.db.select({ c: count() }).from(jobTable).where(eq(jobTable.kind, "reconcile")))[0]!.c;
  await h.post("/orch/v1/journal", { kind: "retro", body: "S1 返工一次，验收标准写模糊了" }, "tok-eng");
  // Without this the PM writes a retro nobody asked for again and the finished
  // branch sits unreviewed until someone nudges it by hand.
  const after = (await h.db.select({ c: count() }).from(jobTable).where(eq(jobTable.kind, "reconcile")))[0]!.c;
  expect(after).toBe(before + 1);
});

test("a retro written mid-flight does not trigger PR review", async () => {
  const h = await harness();
  await fx.on(h.db).slice.create({ grp_id: 1, seq: 2, title: "S2" });
  await h.post("/orch/v1/journal", { kind: "retro", body: "早写的 retro" }, "tok-eng");
  expect((await h.db.select({ c: count() }).from(jobTable).where(eq(jobTable.kind, "reconcile")))[0]!.c).toBe(0);
});

test("a trivial slice is accepted automatically once all three gates pass", async () => {
  const h = await harness();
  h.ctx.config.autoAcceptTiers = ["trivial"];
  await fx.on(h.db).slice.create({ grp_id: 1, seq: 2, title: "S2", accept_spec: "b", status: "pending" });

  await handToBoss({ ctx: h.ctx }, 1);

  const [s1] = await h.db.select({ status: sliceTable.status }).from(sliceTable).where(eq(sliceTable.id, 1));
  // Three gates still ran; this skips the boss's look, not the verification.
  expect(s1!.status).toBe("accepted");
  // Announced, never silent: an acceptance nobody can see cannot be audited.
  const said = (
    await h.db
      .select({ author: eventTable.author, body: eventTable.body })
      .from(eventTable)
      .orderBy(desc(eventTable.seq))
  ).find((e) => e.body.includes("自动查收"))!;
  expect(said.author).toBe("orchestrator");
  expect(said.body).toContain("自动查收");
  // And the next slice starts, which is the point of the whole thing.
  expect(
    (await h.db.select({ status: sliceTable.status }).from(sliceTable).where(eq(sliceTable.id, 2)))[0]!.status,
  ).not.toBe("pending");
});

test("a normal slice still waits for the boss even with trivial auto-accept on", async () => {
  const h = await harness();
  h.ctx.config.autoAcceptTiers = ["trivial"];
  await h.db.update(sliceTable).set({ difficulty: "normal" }).where(eq(sliceTable.id, 1));

  await handToBoss({ ctx: h.ctx }, 1);
  expect(
    (await h.db.select({ status: sliceTable.status }).from(sliceTable).where(eq(sliceTable.id, 1)))[0]!.status,
  ).toBe("awaiting_boss");
});

test("with auto-accept disabled, every slice waits for the boss", async () => {
  const h = await harness();
  h.ctx.config = { ...h.ctx.config, autoAcceptTiers: [] };
  await handToBoss({ ctx: h.ctx }, 1);
  expect(
    (await h.db.select({ status: sliceTable.status }).from(sliceTable).where(eq(sliceTable.id, 1)))[0]!.status,
  ).toBe("awaiting_boss");
});

test("the task that closes a slice needs a self-review, and vacuous does not count", async () => {
  const h = await harness();
  writeFileSync(join(h.wt.worktree, "a.txt"), "two\n");

  // The Engineer's role prompt has always said a content-free self-review would be
  // rejected. Until this check existed, nothing rejected anything — the prompt was
  // describing a gate that was not there.
  const none = await h.post(
    "/orch/v1/task/done",
    { task_id: 1, claim: { files: ["a.txt"], summary: "a.txt now says two" } },
    "tok-eng",
  );
  expect(none.status).toBe(422);
  expect(await none.text()).toContain("--review");

  const vacuous = await h.post(
    "/orch/v1/task/done",
    { task_id: 1, claim: { files: ["a.txt"], summary: "a.txt now says two" }, review: "looks good" },
    "tok-eng",
  );
  expect(vacuous.status).toBe(422);
  expect(await vacuous.text()).toContain("carries no information");

  const ok = await h.post(
    "/orch/v1/task/done",
    {
      task_id: 1,
      claim: { files: ["a.txt"], summary: "a.txt now says two" },
      review: "pass: a.txt says two — the diff adds that line",
    },
    "tok-eng",
  );
  expect(ok.status).toBe(200);
  // Recorded as the gate layer it is, so the panel can draw the first tick and the
  // evidence panel can show what was claimed.
  const [sliceRow] = await h.db
    .select({ gates_json: sliceTable.gates_json })
    .from(sliceTable)
    .where(eq(sliceTable.id, 1));
  const gates = GateResults.parse(sliceRow!.gates_json);
  expect(gates.self).toBe("pass");
  const filed = (
    await h.db
      .select({ author: eventTable.author, body: eventTable.body })
      .from(eventTable)
      .where(eq(eventTable.kind, "gate_result"))
      .orderBy(eventTable.seq)
  ).find((e) => e.body.includes("a.txt says two"))!;
  expect(filed.author).toBe("engineer");
});

// 30s, not bun's 5s default. Measured at 5000.79ms in one full-suite run out of
// thirteen: this harness's fake sandbox really `Bun.spawnSync`es every command,
// its setup alone is eight git processes, and under a loaded machine that
// exceeds the default. It is timing, not a leak — nothing here reads module
// state, and the three holds that do have resets are cleared before every test
// by `test/support/setup.ts`. Do not go hunting for one.
test("a branch the Auditor keeps rejecting stops instead of paying for another round", async () => {
  // A slice that keeps failing gives up after gateRetries and asks the boss. The
  // branch had no counter at all — the same money spent forever on the same
  // disagreement, with nothing on the boss's screen saying so.
  const h = await harness();
  await h.ctx.auditVerdict!(1, false, "the error path is still untested");
  await h.ctx.auditVerdict!(1, false, "still untested");
  expect((await h.db.select({ status: grpTable.status }).from(grpTable).where(eq(grpTable.id, 1)))[0]!.status).toBe(
    "RUNNING",
  );

  await h.ctx.auditVerdict!(1, false, "and again");
  const [g] = await h.db
    .select({ status: grpTable.status, pr_retries: grpTable.pr_retries })
    .from(grpTable)
    .where(eq(grpTable.id, 1));
  expect(g!.status).toBe("PAUSED");
  expect(g!.pr_retries).toBe(3);
  const [esc] = await h.db.select().from(escalationTable).orderBy(desc(escalationTable.id)).limit(1);
  expect(esc!.severity).toBe("blocker");
  expect(esc!.chain_state).toBe("boss");
  expect(esc!.brief).toContain("the Auditor");
  expect(esc!.brief).toContain("3");
  expect(esc!.kind).toBe("spec");
  // The likely cause, said out loud: three rounds usually means the acceptance
  // wording is wrong, not the code. Asserted through who rejected it and the
  // reason they last gave, both of which this test supplied — the sentence
  // carrying them is the catalogue's.
  expect(esc!.question).toContain("the Auditor");
  expect(esc!.question).toContain("and again");
}, 30_000);

test("a passed audit hires the Scribe, and nothing is published until it files", async () => {
  // The audit decides the branch *may* be published. What it is published *as* is
  // a separate question, and it used to be answered by `orch: ${group name}` —
  // the dispatcher's slug, identical across every pull request this project
  // opened, chosen before a line of the code existed.
  const h = await harness();
  let published = 0;
  h.ctx.publishBranch = () => published++;

  await h.db.update(grpTable).set({ status: "PR_OPEN" }).where(eq(grpTable.id, 1)); // set by the branch gate, before the audit
  await h.ctx.auditVerdict!(1, true, "");
  expect(published).toBe(0);

  const [job] = await h.db
    .select({ payload_json: jobTable.payload_json, grp_id: jobTable.grp_id })
    .from(jobTable)
    .where(eq(jobTable.kind, "agent_turn"))
    .orderBy(desc(jobTable.id))
    .limit(1);
  // In the group's own sandbox, unlike the Auditor: the branch it has to read is
  // checked out there, and summarising a diff is not reviewing one's own work.
  expect(job!.grp_id).toBe(1);
  expect(AgentTurnPayloadSchema.parse(job!.payload_json).role).toBe("scribe");

  // A place in the merge queue all the same. The queue is what the boss sees,
  // and a finished branch that is invisible until an agent writes a sentence is
  // a worse failure than an ugly title.
  expect((await h.db.select({ n: grpTable.merge_seq }).from(grpTable).where(eq(grpTable.id, 1)))[0]!.n).not.toBeNull();
});

test("a Scribe turn that never files does not strand the branch at the head of the queue", async () => {
  // The failure this guards is the shape `CLAUDE.md` names: one code path drives
  // a transition, that path does not run, and the group looks healthy — RUNNING
  // group, no error, finished work nobody can merge — while every group behind
  // it in a strictly serial queue waits.
  const h = await harness();
  let published = 0;
  h.ctx.publishBranch = (id: number) => void (published = id);

  await h.db.update(grpTable).set({ status: "PR_OPEN" }).where(eq(grpTable.id, 1)); // set by the branch gate, before the audit
  await h.ctx.auditVerdict!(1, true, "");
  // Still queued, so the repair leaves it alone: its own liveness is the
  // scheduler's until there is nothing left to run.
  await runInvariants(h.ctx);
  expect(published).toBe(0);

  await h.db.update(jobTable).set({ state: "failed" }).where(eq(jobTable.kind, "agent_turn"));
  await runInvariants(h.ctx);
  expect(published).toBe(1);
});

/**
 * A slice that keeps failing its gate stops instead of paying for another round.
 *
 * The branch-level counter has a test; the slice-level one — the older of the two,
 * and the one every rejected slice goes through — had none. Deleting its ceiling left
 * the suite green, measured by mutation.
 *
 * Looping forever is worse than interrupting the boss: past two attempts it is
 * usually the acceptance criteria that are wrong rather than the code.
 */
test("a slice the gate keeps rejecting asks the boss instead of going round again", async () => {
  const h = await harness();
  const status = async () =>
    (
      await h.db
        .select({ status: sliceTable.status, retries: sliceTable.retries })
        .from(sliceTable)
        .where(eq(sliceTable.id, 1))
    )[0]!;

  await h.ctx.reviewVerdict!(1, false, "the boundary cases are still missing");
  await h.ctx.reviewVerdict!(1, false, "still missing");
  expect(await status()).toEqual({ status: "running", retries: 2 });

  await h.ctx.reviewVerdict!(1, false, "and again");
  expect(await status()).toEqual({ status: "rejected", retries: 3 });
  // PAUSING, not PAUSED: `hold` writes the intent and `settle` lands it once the
  // turn in flight has stopped. Asserting the settled state here would be asserting
  // that the turn had already been cancelled, which is a different mechanism.
  expect((await h.db.select({ status: grpTable.status }).from(grpTable).where(eq(grpTable.id, 1)))[0]!.status).toBe(
    "PAUSING",
  );
});

/**
 * The question goes to the boss, not to the PM.
 *
 * The next line pauses the group, so a PM this was addressed to cannot run — the
 * question sat at `chain_state='pm'` forever, never reached `Awaiting your decision`, and the only
 * visible symptom was a paused group with no reason attached. Observed live: a
 * blocker filed two hours before anyone could have seen it.
 */
test("a slice that gave up asks the boss directly, because the group is about to stop", async () => {
  const h = await harness();
  for (const note of ["one", "two", "three"]) await h.ctx.reviewVerdict!(1, false, note);

  const [esc] = await h.db
    .select({
      chain_state: escalationTable.chain_state,
      severity: escalationTable.severity,
      kind: escalationTable.kind,
    })
    .from(escalationTable)
    .orderBy(desc(escalationTable.id))
    .limit(1);
  expect(esc).toEqual({ chain_state: "boss", severity: "blocker", kind: "spec" });
});
