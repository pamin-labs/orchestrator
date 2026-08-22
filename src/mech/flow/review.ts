import { msg, plural } from "@lingui/core/macro";
import { transaction } from "../../platform/persistence/database.ts";
import { and, asc, count, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import { roleFor, type Ctx } from "../../mech/ctx.ts";
import { addNote, projectOfGrp } from "../util/rows.ts";
import type { DB } from "../../platform/persistence/database.ts";
import {
  agent,
  event,
  grp as grpTable,
  note as noteTable,
  slice as sliceTable,
  task,
} from "../../platform/persistence/schema.ts";
import type { Config } from "../../platform/config/load.ts";
import { renderSaid } from "../../platform/text/lang.ts";
import { valueOr } from "../../contracts/json.ts";
import type { SliceState } from "../../contracts/states.ts";
import { runGates, recordGate, gateState } from "../gate.ts";
import { extractClaimedFiles, reconcile, TaskClaimSchema } from "./reconcile.ts";
import { changedSince, filesAt } from "../git/gitops.ts";
import { resourceExec, WORK } from "../sandbox/sandbox.ts";
import { pushBranch, sandboxGit } from "../git/checkout.ts";
import { joinQueue, position } from "./mergequeue.ts";
import { hold } from "./intercept.ts";
import { raise } from "./escalate.ts";
import { z } from "zod";

/**
 * Slice-level review, in the one order that makes sense.
 *
 *   self-review (in the writer's own turn)  ->  reconcile  ->  gate  ->  QA  ->  boss
 *
 * The two deterministic layers come first because they are free and certain, and
 * because letting a reviewer look at work whose claims are false, or whose tests
 * do not compile, wastes the expensive judgement on the wrong question.
 */

export interface ReviewDeps {
  ctx: Ctx;
  cfg: Config;
}

interface SliceRow {
  id: number;
  grp_id: number;
  seq: number;
  title: string;
  accept_spec: string;
  difficulty: string;
  base_sha: string | null;
  retries: number;
}

async function loadSlice(db: DB, sliceId: number): Promise<SliceRow | null> {
  const [row] = await db
    .select({
      id: sliceTable.id,
      grp_id: sliceTable.grp_id,
      seq: sliceTable.seq,
      title: sliceTable.title,
      accept_spec: sliceTable.accept_spec,
      difficulty: sliceTable.difficulty,
      base_sha: sliceTable.base_sha,
      retries: sliceTable.retries,
    })
    .from(sliceTable)
    .where(eq(sliceTable.id, sliceId));
  return row ?? null;
}

/**
 * There are no transactions left in this file, and that is the conversion.
 *
 * Every one of them wrapped row writes together with a `bus.emit` or a
 * `sched.enqueue`, and those two hold the pool rather than the caller's handle —
 * so the transaction could only ever contain half of the sequence, while the
 * half outside it waited on rows the half inside had locked. The guard that
 * actually mattered, in `acceptSlice`, is one `UPDATE ... WHERE ... RETURNING`
 * and is atomic on its own.
 */

/**
 * Run the deterministic half. Returns the feedback to send back on failure.
 *
 * Nothing here consults a model, so the verdict is reproducible and the boss can
 * be told exactly why a slice was sent back.
 */
export async function runDeterministicReview(
  deps: ReviewDeps,
  sliceId: number,
): Promise<{ pass: boolean; feedback: string }> {
  const { ctx, cfg } = deps;
  const slice = await loadSlice(ctx.db, sliceId);
  if (!slice) return { pass: false, feedback: "slice disappeared" };

  const projectId = await projectOfGrp(ctx.db, slice.grp_id);

  // --- reconcile: what was claimed against what git shows for THIS slice
  const storedClaims = (
    await ctx.db
      .select({ claim_json: task.claim_json })
      .from(task)
      .where(and(eq(task.slice_id, sliceId), eq(task.status, "done")))
  ).map((r) => valueOr(r.claim_json, z.json(), null));
  const claims = z.array(TaskClaimSchema).safeParse(storedClaims);
  if (!claims.success) {
    await recordGate(ctx.db, sliceId, "reconcile", "fail");
    return { pass: false, feedback: `Reconcile failed: ${z.prettifyError(claims.error)}` };
  }

  let changed: string[] = [];
  let absent: string[] = [];
  if (slice.base_sha) {
    // The group's own checkout, in its own container. This used to read
    // `grp.worktree` — a column nothing has ever written — so the guard was always
    // false, the change set was always empty, and the gate scored every claim
    // against nothing at all.
    const sgit = sandboxGit(ctx, { grp: slice.grp_id });
    changed = await changedSince(sgit, WORK, slice.base_sha);
    // A path that is in neither the branch point nor the change set: a scratch file
    // created and then deleted inside this slice. Git has no record of it either
    // way, so it cannot be a delivery — and it must not be scored as a lie.
    // (`changed` already carries the untracked files, so anything that exists now
    // is in one list or the other; no filesystem check is needed.)
    const known = new Set(await filesAt(sgit, WORK, slice.base_sha));
    const seen = new Set(changed);
    absent = extractClaimedFiles(claims.data).filter((c) => !known.has(c) && !seen.has(c));
  }
  const rec = reconcile({ claims: claims.data, changedFiles: changed, absent });
  await recordGate(ctx.db, sliceId, "reconcile", rec.pass ? "pass" : "fail");
  if (!rec.pass) {
    await ctx.bus.emit({
      grpId: slice.grp_id,
      author: "orchestrator",
      kind: "gate_result",
      // `rec.reason` is prose we wrote, so it stays out of the descriptor and the
      // two failing shapes get a key each. Both are reachable: every `pass: false`
      // from `reconcile` either names phantom files or claimed nothing at all.
      // Paths are values; a sentence would be one sentence in two languages.
      say: rec.phantom.length
        ? msg`reconcile failed on S${{ seq: slice.seq }}: claimed but not changed — ${{ files: rec.phantom.join(", ") }}`
        : msg`reconcile failed on S${{ seq: slice.seq }}: nothing was claimed and nothing changed`,
      meta: { slice_id: sliceId, phantom: rec.phantom },
    });
    return {
      pass: false,
      feedback:
        `Reconcile failed: ${rec.reason}.\n` +
        `git shows these changed: ${changed.length ? changed.join(", ") : "(nothing)"}.\n` +
        `Either make the change or correct the claim — both are cheaper than a reviewer's time.`,
    };
  }

  // --- gate: exit codes, no opinions
  const out = await runGates({
    db: ctx.db,
    projectId: projectId!,
    cwd: WORK,
    dataDir: cfg.dataDir,
    sliceId,
    exec: resourceExec(ctx, { grp: slice.grp_id }),
    timeoutMs: cfg.leaseTimeoutMs,
  });
  await recordGate(ctx.db, sliceId, "gate", out.pass ? "pass" : "fail");
  await ctx.bus.emit({
    grpId: slice.grp_id,
    author: "orchestrator",
    kind: "gate_result",
    say: out.pass ? msg`gate pass on S${{ seq: slice.seq }}` : msg`gate fail on S${{ seq: slice.seq }}`,
    meta: { slice_id: sliceId, results: out.results.map((r) => ({ name: r.name, pass: r.pass })) },
  });
  if (!out.pass) return { pass: false, feedback: out.feedback };

  if (rec.unclaimed.length) {
    // Not a defect, but the reviewer should know what else moved.
    await ctx.bus.emit({
      grpId: slice.grp_id,
      author: "orchestrator",
      kind: "gate_result",
      say: msg`also changed on S${{ seq: slice.seq }}, unclaimed: ${{ files: rec.unclaimed.slice(0, 10).join(", ") }}`,
      meta: { slice_id: sliceId },
    });
  }
  return { pass: true, feedback: out.feedback };
}

/**
 * Give the writer back a card it is allowed to work on.
 *
 * A slice going back for a retry kept its tasks `done`, and `done` is the one state
 * the writer cannot act on: `task list` showed a finished card, `task claim` said
 * the slice was not being worked, `task done` said the task was not its. No legal
 * move — so the turn ended the only way it could, by asking the boss. Six groups
 * reached the same dead end, four stopping outright.
 */
/**
 * `claim_json` stays. `reconcile` only reads it off `done` rows, so it is inert
 * here, and on a reopened card it is the record of what the last attempt already put
 * on the branch — which is what `getTasks` shows the writer so it checks before
 * rewriting.
 */
export async function reopenTasks(db: DB, sliceId: number): Promise<void> {
  await db
    .update(task)
    .set({ status: "pending", owner_agent_id: null })
    .where(and(eq(task.slice_id, sliceId), eq(task.status, "done")));
}

/**
 * Send a slice back to the writer.
 *
 * The retry always starts a FRESH session carrying only the acceptance spec, the
 * failing lines and the current diff. Resuming the old session would drag along
 * a history that is mostly the failed attempt.
 */
export async function sendBack(deps: ReviewDeps, sliceId: number, feedback: string, from: string): Promise<void> {
  const { ctx, cfg } = deps;
  const slice = await loadSlice(ctx.db, sliceId);
  if (!slice) return;

  const retries = slice.retries + 1;
  await ctx.db.update(sliceTable).set({ retries, status: "running" }).where(eq(sliceTable.id, sliceId));
  await reopenTasks(ctx.db, sliceId);

  if (retries > cfg.gateRetries) {
    // Looping forever is worse than interrupting the boss. Two failed attempts
    // usually means the acceptance criteria are wrong, not the code.
    // 'boss', not the default 'pm'. The next line pauses the group, so the PM this
    // was addressed to cannot run — the question sat at chain_state='pm' forever,
    // never reached 待你决策, and the only visible symptom was a paused group with
    // no reason attached. Observed on pm-ai-agent: a blocker filed two hours
    // earlier that the boss had no way to see.
    await raise(ctx.db, {
      grpId: slice.grp_id,
      lang: ctx.config.language,
      question: msg`S${{ seq: slice.seq }} "${{ title: slice.title }}" failed ${{ from }} ${{ n: retries }} times. Latest:\n${{ feedback }}`,
      brief: msg`S${{ seq: slice.seq }} failed ${{ from }} ${{ n: retries }}x in a row`,
      kind: "spec",
      chain: "boss",
    });
    await ctx.db.update(sliceTable).set({ status: "rejected" }).where(eq(sliceTable.id, sliceId));
    await hold(ctx.db, slice.grp_id, { reason: "escalation", from: "RUNNING" });
    await ctx.bus.emit({
      grpId: slice.grp_id,
      author: "orchestrator",
      kind: "escalation",
      intent: "ask",
      severity: "blocker",
      say: msg`S${{ seq: slice.seq }} failed ${{ from }} ${{ n: retries }}x — probably the acceptance criteria, not the code`,
      meta: { slice_id: sliceId },
    });
    return;
  }

  await ctx.sched.enqueue("agent_turn", {
    grp_id: slice.grp_id,
    slice_id: sliceId,
    payload: { role: roleFor(ctx, "write_code"), rejection: feedback, rotate: true },
  });
  await ctx.bus.emit({
    grpId: slice.grp_id,
    author: "orchestrator",
    kind: "state_change",
    say: msg`S${{ seq: slice.seq }} sent back by ${{ from }} (attempt ${{ n: retries }})`,
    meta: { slice_id: sliceId },
  });
  await ctx.sched.tick();
}

/**
 * Deterministic half passed: hand the slice to QA.
 *
 * One transaction, because the state and the job that acts on it are one fact:
 * a slice in `qa` with no reviewer queued is a slice nothing will ever move, and
 * nothing in the panel says so. `transaction()` is what `enqueue` reads to write
 * on the same handle, so the tick after it is the only part outside.
 */
export async function handToQa(deps: ReviewDeps, sliceId: number): Promise<void> {
  const { ctx } = deps;
  await transaction(ctx.db, async (tx) => {
    const slice = await loadSlice(tx, sliceId);
    if (!slice) return;
    await tx.update(sliceTable).set({ status: "qa" }).where(eq(sliceTable.id, sliceId));
    await ctx.sched.enqueue("agent_turn", {
      grp_id: slice.grp_id,
      slice_id: sliceId,
      payload: { role: roleFor(ctx, "review_slice"), review: sliceId },
    });
  });
  await ctx.sched.tick();
}

/** QA passed: the slice is the boss's to accept. */
export async function handToBoss(deps: Pick<ReviewDeps, "ctx">, sliceId: number): Promise<void> {
  const { ctx } = deps;
  const slice = await loadSlice(ctx.db, sliceId);
  if (!slice) return;
  await recordGate(ctx.db, sliceId, "qa", "pass");
  await ctx.db
    .update(sliceTable)
    .set({ status: "awaiting_boss", awaiting_at: Date.now() })
    .where(eq(sliceTable.id, sliceId));

  // Retire the sessions that carried this slice. A slice is a natural semantic
  // break, so the handoff is cheap, and a session that keeps growing costs more on
  // every remaining turn even at the cached rate.
  //
  // The writer and its reviewer only — not the whole roster. Rotating everyone cost
  // a full prefix rebuild per role per slice: measured over 259 turns, 95% of them
  // started on a cold prefix and cache creation came to 45.5M tokens, which bills
  // like ~570M cached reads. The PM, Dispatcher and Auditor carry group-level
  // context that is still true in the next slice, so throwing it away buys nothing.
  await ctx.db
    .update(agent)
    .set({ session_id: null, session_tokens: 0 })
    .where(
      and(
        eq(agent.grp_id, slice.grp_id),
        ne(agent.state, "retired"),
        inArray(agent.role, [roleFor(ctx, "write_code"), roleFor(ctx, "review_slice")]),
      ),
    );
  await ctx.bus.emit({
    grpId: slice.grp_id,
    author: "orchestrator",
    kind: "state_change",
    say: msg`S${{ seq: slice.seq }} "${{ title: slice.title }}" is ready for you`,
    meta: { slice_id: sliceId, gates: await gateState(ctx.db, sliceId) },
  });

  // Trivial work the boss chose not to look at. Every gate still ran — self
  // review, the deterministic gate, an independent QA — so this skips the fourth
  // layer, not the first three. It is announced, never silent: an acceptance
  // nobody can see is indistinguishable from one that did not happen.
  if (ctx.config.autoAcceptTiers.includes(slice.difficulty)) {
    await acceptSlice(
      ctx,
      sliceId,
      "orchestrator",
      renderSaid(ctx.config.language, msg`${{ tier: slice.difficulty }} auto-accepted, all three gates passed`),
    );
    return;
  }

  // Approving at night should buy a night of work. Acceptance is what normally
  // starts the next slice, so without this a group does exactly one slice and
  // then waits until morning. The slice still waits to be accepted; only the
  // next one stops waiting.
  if (ctx.config.autoAdvance) {
    const next = await queueNextSlice(ctx, slice.grp_id);
    if (next) {
      await ctx.bus.emit({
        grpId: slice.grp_id,
        author: "orchestrator",
        kind: "state_change",
        say: msg`autoAdvance: started the next slice without waiting for you`,
        meta: { slice_id: next },
      });
      await ctx.sched.tick();
    }
  }
}

/**
 * A slice is accepted. One path, whoever accepted it.
 *
 * The boss's button and the auto-accept policy must not be two implementations:
 * "what happens when a slice is accepted" is a rule about the pipeline, and a
 * second copy of it would drift the day one of them gained a step.
 */
export async function acceptSlice(ctx: Ctx, sliceId: number, by: string, why?: string): Promise<void> {
  const [sl] = await ctx.db
    .select({ grp_id: sliceTable.grp_id, seq: sliceTable.seq, title: sliceTable.title })
    .from(sliceTable)
    .where(eq(sliceTable.id, sliceId));
  if (!sl) return;

  // Where it is accepted *from* matters. A `pending` slice has never run, so
  // accepting it writes a carry-over handoff claiming it delivered, advances the
  // group, and — if it was the last one open — sends a branch that does not
  // contain it to review. `accepted` is excluded so a second call is not a second
  // carry-over. The returned rows are the guard: one statement, so a second
  // acceptance either matches nothing or waits and then matches nothing.
  // One transaction from here to the event. Acceptance, the carry-over handoff,
  // the next slice's job and the reconcile that closes the group are one fact:
  // any prefix of them committing alone leaves a group whose slices are all
  // accepted and whose branch nothing will ever send to review.
  const accepted = await transaction(ctx.db, async (tx) => {
    const moved = await tx
      .update(sliceTable)
      .set({ status: "accepted" })
      .where(and(eq(sliceTable.id, sliceId), notInArray(sliceTable.status, ["pending", "accepted"])))
      .returning({ id: sliceTable.id });
    if (!moved.length) return false;
    await carryOver(tx, sliceId, sl.grp_id);
    await queueNextSlice({ ...ctx, db: tx }, sl.grp_id);

    // The last acceptance starts PR-level review. Nothing an agent does can
    // trigger it: "satisfied" is the boss's call, or a policy the boss set.
    const [openRow] = await tx
      .select({ c: count() })
      .from(sliceTable)
      .where(and(eq(sliceTable.grp_id, sl.grp_id), ne(sliceTable.status, "accepted")));
    if ((openRow?.c ?? 0) === 0) await ctx.sched.enqueue("reconcile", { grp_id: sl.grp_id, priority: 5 });
    return true;
  });
  if (!accepted) return;
  await ctx.bus.emit({
    grpId: sl.grp_id,
    author: by,
    kind: "state_change",
    // Two keys rather than a bracket pair spliced in here: built at the call site
    // the brackets were fullwidth, so the English row read `accepted: S3 t（why）`.
    say: why
      ? msg`accepted: S${{ seq: sl.seq }} ${{ title: sl.title }} (${{ why }})`
      : msg`accepted: S${{ seq: sl.seq }} ${{ title: sl.title }}`,
    meta: { slice_id: sliceId, by },
  });

  // The slice boundary, and the only place a branch reaches the remote before
  // its PR (007 step 5). Here rather than per turn: a turn is thirty seconds of
  // work and a slice is a delivered unit, and a push per turn is a network round
  // trip per turn for a ref nobody is reading yet.
  //
  // Not awaited — the next slice must start whether or not GitHub is answering.
  // A failure is said out loud and left to the next boundary; `openPr` pushes
  // again before it creates the PR, so nothing ships on an unpushed branch.
  //
  // The `.catch` is not decoration. `pushBranch` returns its failures rather than
  // throwing, but the reporting itself can throw: `event.grp_id` is a foreign key
  // to `grp`, and this lands seconds later — by which time the group may have
  // been dropped, or the process may be somewhere else entirely. An unhandled
  // rejection from a detached promise surfaces against whatever is running when
  // it fires, which is a failure with no relationship to its cause.
  void pushBranch(ctx, sl.grp_id)
    .then(async (r) => {
      if (r.ok || /empty bundle/i.test(r.reason ?? "")) return;
      await ctx.bus.emit({
        grpId: sl.grp_id,
        author: "orchestrator",
        kind: "state_change",
        severity: "warn",
        say: msg`the branch was not pushed to the remote, and the next slice's acceptance will try again: ${{ reason: r.reason ?? "" }}`,
      });
    })
    .catch(() => {
      // The group is gone, or the record is. Either way there is nobody left to
      // tell, and this is the branch that must not take an unrelated caller down.
    });

  await ctx.sched.tick();
}

/**
 * What the next slice would otherwise rediscover.
 *
 * The second slice of a group re-greps what the first one already worked out —
 * which files matter, what the gate says, what was decided — because the only thing
 * carried across was a journal capped at six lines, and every one of those rounds
 * re-reads the whole transcript.
 */
/**
 * Derived, not asked for: the files are the commits this slice made, the gates are
 * recorded verdicts, the decisions are notes it wrote. A prompt asking an agent to
 * "summarise for the next slice" would be a model call producing what a SELECT
 * already knows, and would be forgotten on the turn it mattered.
 */
async function carryOver(db: DB, sliceId: number, grpId: number): Promise<void> {
  const files = new Set<string>();
  for (const e of await db
    .select({ meta_json: event.meta_json })
    .from(event)
    .where(
      and(
        eq(event.kind, "commit"),
        // Raw: the slice id lives inside the event's JSON blob, not in a column
        // of its own, and `->>` on a `jsonb` column has no builder. It compares
        // as text, which is what the operator yields.
        sql`${event.meta_json}->>'slice_id' = ${String(sliceId)}`,
      ),
    )) {
    for (const f of valueOr(e.meta_json, z.object({ files: z.array(z.string()).default([]) }), { files: [] }).files) {
      files.add(f);
    }
  }
  const decisions = (
    await db
      .select({ body: noteTable.body })
      .from(noteTable)
      .where(and(eq(noteTable.slice_id, sliceId), inArray(noteTable.kind, ["decision", "journal"])))
      .orderBy(asc(noteTable.id))
  ).map((n) => n.body.split("\n")[0]!.slice(0, 160));
  const [sl] = await db
    .select({ seq: sliceTable.seq, title: sliceTable.title, gates_json: sliceTable.gates_json })
    .from(sliceTable)
    .where(eq(sliceTable.id, sliceId));
  if (!sl) return;

  const body =
    `S${sl.seq} ${sl.title} — accepted.\n` +
    (files.size ? `Files it touched: ${[...files].slice(0, 20).join(", ")}\n` : "") +
    // `gates_json` is `jsonb`, so it arrives parsed: interpolating the value
    // itself puts `[object Object]` in the handoff the next slice reads.
    `Gates: ${JSON.stringify(sl.gates_json)}\n` +
    (decisions.length ? `What it settled:\n${decisions.map((d) => `- ${d}`).join("\n")}` : "");

  // Assembled from English above, and read by the next slice's agent.
  await addNote(db, { grpId, sliceId, kind: "handoff", body, lang: "en" });
}

/**
 * PR-level review, run once every slice has been accepted by the boss.
 *
 * Deterministic first, same as at slice level: the whole branch is reconciled and
 * gated before the Auditor is asked for judgement.
 */
export async function runPrReview(deps: ReviewDeps, grpId: number): Promise<void> {
  const { ctx, cfg } = deps;
  const [grp] = await ctx.db
    .select({ project_id: grpTable.project_id, branch: grpTable.branch, name: grpTable.name })
    .from(grpTable)
    .where(eq(grpTable.id, grpId));
  if (!grp) return;

  // A group cannot be wound up without a retro. It is the only long-term memory
  // the system has, and "later" means never once the branch is merged.
  const [retroRow] = await ctx.db
    .select({ c: count() })
    .from(noteTable)
    .where(and(eq(noteTable.grp_id, grpId), eq(noteTable.kind, "retro")));
  if ((retroRow?.c ?? 0) === 0) {
    await ctx.sched.enqueue("agent_turn", {
      grp_id: grpId,
      payload: {
        role: roleFor(ctx, "lead_group"),
        rejection:
          "Every slice is accepted, but this group has no retro. Write one now with " +
          "`orch journal add --kind retro`: what got reworked, which assumption was wrong, " +
          "what the next group touching this code needs to know. Max 6 lines.",
      },
    });
    await ctx.bus.emit({
      grpId,
      author: "orchestrator",
      kind: "state_change",
      say: msg`no retro yet — the group cannot wind up without one`,
    });
    await ctx.sched.tick();
    return;
  }

  const gateOut = await runGates({
    db: ctx.db,
    projectId: grp.project_id,
    cwd: WORK,
    dataDir: cfg.dataDir,
    sliceId: 0,
    exec: resourceExec(ctx, { grp: grpId }),
    timeoutMs: cfg.leaseTimeoutMs,
  });
  if (!gateOut.pass) {
    await ctx.bus.emit({
      grpId,
      author: "orchestrator",
      kind: "gate_result",
      say: msg`branch gate failed:\n${{ gates: gateOut.feedback }}`,
    });
    if (await branchRework(deps, grpId, "the branch gate", gateOut.feedback)) return;
    await ctx.sched.enqueue("agent_turn", {
      grp_id: grpId,
      payload: { role: roleFor(ctx, "write_code"), rejection: gateOut.feedback, rotate: true },
    });
    await ctx.sched.tick();
    return;
  }

  // Through, so the count starts again: the next rejection is about the next
  // branch, not this one.
  await ctx.db.update(grpTable).set({ status: "PR_OPEN", pr_retries: 0 }).where(eq(grpTable.id, grpId));
  // grp_id null on purpose: hiring the Auditor into the group it audits would
  // make it review its own reasoning, and `orch audit` rightly refuses that.
  await ctx.sched.enqueue("agent_turn", {
    grp_id: null,
    payload: { role: roleFor(ctx, "audit_branch"), audit: grpId, audit_branch: grp.branch, audit_group: grp.name },
  });
  await ctx.sched.tick();
}

/** The Auditor's verdict. Passing means the branch is the boss's to merge. */
export async function auditVerdict(deps: ReviewDeps, grpId: number, pass: boolean, note: string): Promise<void> {
  const { ctx } = deps;
  if (pass) {
    await joinQueue(ctx.db, grpId);
    // Not published yet: the Scribe writes what it is published *as*, and
    // `orch pr` is what calls `publishBranch`. One turn, in the group's own
    // sandbox, where the branch it has to read is checked out.
    //
    // Nothing here waits on it. If that turn dies, or ends without filing, the
    // group sits in PR_OPEN with a queue place and no number — which is the
    // state PR_OPEN's invariant repair looks for, and it publishes with the
    // record's own words rather than leaving finished work at the head of a
    // serial merge queue.
    await ctx.sched.enqueue("agent_turn", {
      grp_id: grpId,
      payload: { role: roleFor(ctx, "write_pr_message"), scribe: grpId },
    });
    const pos = await position(ctx.db, grpId);
    await ctx.bus.emit({
      grpId,
      author: roleFor(ctx, "audit_branch"),
      kind: "state_change",
      say:
        pos && pos.position > 1
          ? msg`audit passed — queued to merge, ${{ place: pos.position }} of ${{ total: pos.total }}`
          : msg`audit passed — ready for you to merge`,
      meta: { audit: "pass", ...pos },
    });
    return;
  }
  await ctx.db.update(grpTable).set({ status: "RUNNING" }).where(eq(grpTable.id, grpId));
  if (await branchRework(deps, grpId, "the Auditor", note)) return;
  await ctx.sched.enqueue("agent_turn", {
    grp_id: grpId,
    payload: {
      role: roleFor(ctx, "lead_group"),
      rejection: `The Auditor sent the branch back: ${note}`,
      rotate: true,
    },
  });
  await ctx.sched.tick();
}

/**
 * Count a branch-level rejection, and stop when there have been enough.
 *
 * A slice that keeps failing gives up after `gateRetries` and asks the boss. The
 * branch had no counter at all: a red branch gate sent the Engineer round, a
 * rejected audit sent the PM round, and neither loop had an end — the same money
 * spent forever on one disagreement, with nothing on the boss's screen.
 *
 * Returns true when the caller should stop rather than send it round again.
 */
async function branchRework(deps: ReviewDeps, grpId: number, from: string, why: string): Promise<boolean> {
  const { ctx, cfg } = deps;
  const [row] = await ctx.db.select({ pr_retries: grpTable.pr_retries }).from(grpTable).where(eq(grpTable.id, grpId));
  const n = (row?.pr_retries ?? 0) + 1;
  await ctx.db.update(grpTable).set({ pr_retries: n }).where(eq(grpTable.id, grpId));
  if (n <= cfg.gateRetries) return false;

  await hold(ctx.db, grpId, { reason: "escalation", settled: true });
  await raise(ctx.db, {
    grpId,
    lang: ctx.config.language,
    question: msg`${{ from }} has sent the whole branch back ${{ n }} times. That is usually the acceptance criteria rather than the code:\n${{ why }}`,
    brief: msg`the whole branch sent back ${{ n }}x by ${{ from }}`,
    kind: "spec",
    chain: "boss",
  });
  await ctx.bus.emit({
    grpId,
    author: "orchestrator",
    kind: "escalation",
    intent: "ask",
    severity: "blocker",
    say: msg`branch sent back by ${{ from }} ${plural({ n }, { one: "# time", other: "# times" })} — stopping rather than paying for another round`,
  });
  return true;
}

/**
 * Start the next slice that is ready to be worked.
 *
 * Called on approval and after every acceptance, because nothing else would:
 * approving a plan that then sits still is the most confusing possible failure —
 * it looks like the system ignored you.
 */
async function queueNextSlice(ctx: Ctx, grpId: number): Promise<number | null> {
  // A slice sitting on the boss is not occupying the writer. Counting it as busy
  // is correct only when acceptance is what starts the next one.
  // A list of states rather than a parenthesised SQL literal, so the values are
  // bound and the `security-sink` suppression this query used to need is gone.
  const idle: SliceState[] = ctx.config.autoAdvance
    ? ["pending", "accepted", "awaiting_boss"]
    : ["pending", "accepted"];
  const [busyRow] = await ctx.db
    .select({ c: count() })
    .from(sliceTable)
    .where(and(eq(sliceTable.grp_id, grpId), notInArray(sliceTable.status, idle)));
  // One slice at a time per group: the group has one writer, so a second
  // in-flight slice would just queue behind the first anyway — and its review
  // would race the first one's.
  if ((busyRow?.c ?? 0) > 0) return null;

  const [next] = await ctx.db
    .select({ id: sliceTable.id, seq: sliceTable.seq, depends_on: sliceTable.depends_on })
    .from(sliceTable)
    .where(and(eq(sliceTable.grp_id, grpId), eq(sliceTable.status, "pending")))
    .orderBy(asc(sliceTable.seq))
    .limit(1);
  if (!next) return null;

  if (next.depends_on) {
    const [dep] = await ctx.db
      .select({ status: sliceTable.status })
      .from(sliceTable)
      .where(eq(sliceTable.id, next.depends_on));
    if (dep && dep.status !== "accepted") return null;
  }

  await ctx.db.update(sliceTable).set({ status: "running" }).where(eq(sliceTable.id, next.id));
  await ctx.sched.enqueue("agent_turn", {
    grp_id: grpId,
    slice_id: next.id,
    payload: { role: roleFor(ctx, "write_code") },
  });
  return next.id;
}

export async function startNextSlice(ctx: Ctx, grpId: number): Promise<number | null> {
  const next = await queueNextSlice(ctx, grpId);
  if (next) await ctx.sched.tick();
  return next;
}
