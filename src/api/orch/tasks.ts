import { and, count, eq, inArray, isNull, ne, notInArray, or } from "drizzle-orm";
import type { DB } from "../../platform/persistence/database.ts";
import { z } from "zod";
import { Id } from "../../contracts/fields.ts";
import { valueOr } from "../../contracts/json.ts";
import type { Ctx } from "../../mech/ctx.ts";
import type { Caller } from "../../http/agent-auth.ts";
import type { AgentHandler } from "../../http/handler.ts";
import { bad, message } from "../../http/respond.ts";
import { agent, slice, task } from "../../platform/persistence/schema.ts";
import {
  AlreadyDoneClaimSchema,
  ChangedFilesClaimSchema,
  extractClaimedFiles,
  type TaskClaim,
  TaskClaimSchema,
} from "../../mech/flow/reconcile.ts";
import { recordGate } from "../../mech/gate.ts";
import { validateSelfReview } from "../../mech/util/validate.ts";
import type { SliceState } from "../../contracts/states.ts";
import { baseBranchOf } from "../../mech/util/rows.ts";

/**
 * The task card and the two verbs that move it.
 *
 * `task done` is the biggest of the three and is barely an HTTP handler: it is
 * the slice-close state machine — claim shape, parent status, the self-review a
 * closing task owes, and the gate job that follows.
 */

/** Agents whose row outlived them: a retired owner is not an owner. */
const retiredAgents = (db: DB) => db.select({ id: agent.id }).from(agent).where(eq(agent.state, "retired"));

/** Slices whose cards are open. A slice runs at a time; the rest are not started. */
const workableSlices = (db: DB) =>
  db
    .select({ id: slice.id })
    .from(slice)
    .where(notInArray(slice.status, ["pending", "accepted"]));

export const getTasks = (async (ctx, req, a) => {
  // The caller's own group, not the one it asked for. Every other `/orch/v1` route
  // checks the token; these two never did, and the `/orch/v1/` prefix gate on the
  // mailbox made them look as if they had — so any sandbox could enumerate any
  // group's cards by putting a number in a query string.
  if (!a.grp_id) return message("this route is for a group's agent", 401);
  const grp = a.grp_id;
  // Only the slice being worked, plus anything not tied to a slice. Showing the
  // whole plan's tasks let the writer mark future slices done, which pushed
  // slices that had never started into review.
  // The owner is only shown when it is someone who can still act. A retired row
  // rendered as `engineer` reads as "another engineer has this", and the writer's
  // own name for itself is `engineer` too — so the list said the card was taken,
  // by nobody, forever. The join carries that condition: `agent.id` is the primary
  // key, so it matches at most one row and the retired one drops out as NULL.
  const rows = await ctx.db
    .select({
      id: task.id,
      title: task.title,
      status: task.status,
      slice_id: task.slice_id,
      claim_json: task.claim_json,
      owner: agent.role,
    })
    .from(task)
    .leftJoin(agent, and(eq(agent.id, task.owner_agent_id), ne(agent.state, "retired")))
    .leftJoin(slice, eq(slice.id, task.slice_id))
    .where(and(eq(task.grp_id, grp), or(isNull(task.slice_id), notInArray(slice.status, ["pending", "accepted"]))))
    .orderBy(task.id);
  // Why the list is short, in the list itself.
  //
  // Slices run in order, so a later slice sits `pending` and its cards are filtered
  // out above. From inside a turn that is indistinguishable from cards that were
  // never written, and an agent that cannot tell the difference does the reasonable
  // thing: it asks the boss to create them. Measured once and it cost a blocker
  // escalation, a suspended group and 12 minutes of the boss's queue — for a state
  // that was correct the whole time. Prompt wording cannot fix this; the answer has
  // to be where the question is asked.
  const later = await ctx.db
    .select({ seq: slice.seq, n: count(task.id) })
    .from(slice)
    .innerJoin(task, eq(task.slice_id, slice.id))
    .where(and(eq(slice.grp_id, grp), eq(slice.status, "pending")))
    .groupBy(slice.id)
    .orderBy(slice.seq);
  const gated = later.length
    ? `\n${later.map((l) => `S${l.seq}: ${l.n} cards, not yet open`).join("\n")}\n` +
      "Later slices open one at a time, after the slice before them is accepted. " +
      "Their cards appear here by themselves — do not ask the boss to create or dispatch them."
    : "";
  // A card that was delivered once and sent back for a retry.
  //
  // The work is almost always still on the branch — the retry is usually about one
  // failing criterion, not about the whole slice. A writer that cannot tell a fresh
  // card from a reopened one starts over, and then spends the turn fighting its own
  // earlier commit. `--already-done` is the exit and it exists; it only gets used if
  // it is named here, next to the card, for the same reason the note above exists.
  const reopened = rows.filter((r) => r.status === "pending" && r.claim_json);
  // The project's own base. `main` was in the string, so a group on `develop` was
  // told to diff against a branch its repository has not got.
  const base = await baseBranchOf(ctx.db, grp, ctx.config.baseBranchFallbacks);
  const redo = reopened.length
    ? "\n" +
      reopened
        .map((r) => {
          const claim: TaskClaim | null = valueOr(r.claim_json, TaskClaimSchema.nullable(), null);
          const files = claim ? extractClaimedFiles([claim]).slice(0, 6).join(", ") : "";
          return `task ${r.id} was delivered once already${files ? `, touching ${files}` : ""}`;
        })
        .join("\n") +
      `\nCheck the branch before you rewrite anything — \`git log origin/${base}..HEAD\` and ` +
      `\`git diff origin/${base}...HEAD\`. If the work is still there and still right, claim the card ` +
      'and close it with `--already-done "<what is on the branch>"` instead of doing it twice.'
    : "";
  if (rows.length === 0) return message(`no tasks are open in this group right now${gated}`);
  // Lines, not a JSON array. Handing an agent `[{"id":1,"title":"…"}]` invites it
  // to pass the title where an id belongs, which is what happened live.
  return message(
    [
      "id  status       slice  owner       title",
      ...rows.map(
        (r) =>
          `${String(r.id).padEnd(4)}${r.status.padEnd(13)}${String(r.slice_id ?? "-").padEnd(7)}` +
          `${(r.owner ?? "-").padEnd(12)}${r.title}`,
      ),
    ].join("\n") +
      redo +
      gated,
  );
}) satisfies AgentHandler;

export const TaskRef = z.object({ task_id: Id });

export const postTaskClaim = (async (ctx, _req, a, _p, b) => {
  if (!a.grp_id) return message("this route is for a group's agent", 401);
  // A retired owner is not an owner. Ownership is a row id, and a group that
  // rehires its writer — a rotation, a restart, anything that ends one agent row
  // and starts another — leaves its own cards locked to a session that no longer
  // exists. Nothing could ever unlock them, which is how a live group ends up with
  // work it is not allowed to touch.
  const claimed = await ctx.db
    .update(task)
    .set({ owner_agent_id: a.id, status: "in_progress" })
    .where(
      and(
        eq(task.id, b.task_id),
        eq(task.grp_id, a.grp_id),
        or(isNull(task.owner_agent_id), inArray(task.owner_agent_id, retiredAgents(ctx.db))),
        or(isNull(task.slice_id), inArray(task.slice_id, workableSlices(ctx.db))),
      ),
    )
    .returning({ id: task.id });
  return claimed.length ? message("ok") : bad("already claimed, or its slice is not being worked yet");
}) satisfies AgentHandler<z.infer<typeof TaskRef>>;

const TaskDoneBase = {
  task_id: Id,
  review: z.string().max(8000).optional(),
};

export const TaskDoneBody = z.xor([
  z.strictObject({ ...TaskDoneBase, claim: ChangedFilesClaimSchema }),
  z.strictObject({ ...TaskDoneBase, already_done: AlreadyDoneClaimSchema.shape.already_done }),
]);

type TaskCompletion = {
  slice_id: number | null;
  slice_status: SliceState | null;
  open: number;
  accept_spec: string | null;
  seq: number | null;
};

// Two statements, not one: `open` counted the slice's other tasks through a
// subquery correlated on both `t.slice_id` and `t.id`. Uncorrelated it is an
// ordinary count over the slice this task turned out to belong to, and this runs
// once per `task done` — a round trip nobody is waiting on.
async function taskCompletion(db: DB, taskId: number, grpId: number): Promise<TaskCompletion | null> {
  const [row] = await db
    .select({
      slice_id: task.slice_id,
      slice_status: slice.status,
      accept_spec: slice.accept_spec,
      seq: slice.seq,
    })
    .from(task)
    .leftJoin(slice, eq(slice.id, task.slice_id))
    .where(and(eq(task.id, taskId), eq(task.grp_id, grpId)));
  if (!row) return null;
  if (row.slice_id === null) return { ...row, open: 0 };
  const [counted] = await db
    .select({ open: count(task.id) })
    .from(task)
    .where(and(eq(task.slice_id, row.slice_id), ne(task.status, "done"), ne(task.id, taskId)));
  return { ...row, open: counted?.open ?? 0 };
}

function reviewError(taskId: number, completion: TaskCompletion | null, review: string | undefined): string | null {
  if (completion?.slice_id == null || completion.open !== 0) return null;
  const checked = validateSelfReview(review ?? "", 1);
  if (checked.ok) return null;
  return (
    `${checked.error}\n\nThis task closes S${completion.seq ?? "?"}, so it needs a self-review:\n` +
    `  orch task done ${taskId} --claim '{…}' --review "pass: <criterion> — <the diff line that satisfies it>"\n` +
    `Acceptance criterion: ${completion.accept_spec ?? "(none recorded)"}`
  );
}

// `db` and not `ctx.db`: this runs inside the caller's transaction, and on this
// driver `ctx.db` is a different connection — the gate row and the slice status
// would land outside the transaction that decided to write them.
async function advanceCompletedSlice(
  ctx: Ctx,
  db: DB,
  caller: Caller,
  completion: TaskCompletion | null,
  review?: string,
): Promise<boolean> {
  if (completion?.slice_id == null || completion.open !== 0) return false;
  const sliceId = completion.slice_id;
  const note = review?.trim();
  if (note) await recordGate(db, sliceId, "self", "pass");
  await db.update(slice).set({ status: "gate" }).where(eq(slice.id, sliceId));
  // Deterministic gate work should not wait behind model turns.
  await ctx.sched.enqueue("gate", { grp_id: caller.grp_id, slice_id: sliceId, priority: 5 });
  if (note) {
    await ctx.bus.emit({
      grpId: caller.grp_id,
      author: caller.role,
      kind: "gate_result",
      intent: "decision",
      body: note.slice(0, 1200),
      meta: { slice_id: sliceId, layer: "self" },
    });
  }
  return true;
}

export const postTaskDone = (async (ctx, _req, a, _p, b) => {
  if (!a.grp_id) return message("this route is for a group's agent", 401);
  // A task belonging to a slice that has not started cannot be completed: the
  // writer works one slice at a time, and letting it close future tasks pushed
  // unstarted slices into review.
  const completion = await taskCompletion(ctx.db, b.task_id, a.grp_id);
  if (completion?.slice_status && ["pending", "accepted"].includes(completion.slice_status)) {
    return bad(
      `task ${b.task_id} belongs to a slice that is not being worked (${completion.slice_status}). ` +
        `Finish the slice you are on; the next one starts when the boss accepts this one.`,
    );
  }

  /**
   * Self-review: layer 1 of the slice review, and the only layer that was written
   * down and never enforced.
   *
   * The Engineer's role prompt already told it a content-free self-review would be
   * rejected, and nothing rejected anything — `validateSelfReview` existed, had a
   * test, and no caller. A prompt that promises a check nobody runs is worse than no
   * check: it reads as done.
   */
  /**
   * A self-review needs a deterministic anchor — the acceptance criteria and the
   * agent's own diff lines — or it is self-congratulation. Demanded only on the task
   * that closes the slice: that is where the work is finished, and asking per task
   * would make it a formality four times over.
   */
  const invalidReview = reviewError(b.task_id, completion, b.review);
  if (invalidReview) return bad(invalidReview);

  // Unowned is fine: a group has one writer, so requiring an explicit claim only
  // adds a step that gets forgotten. Someone else's task is not — unless that
  // someone else is retired, in which case the card outlived its claimant and the
  // group's current writer is the only one who can finish it. Same reason as claim.
  const claim: TaskClaim = "already_done" in b ? { already_done: b.already_done } : b.claim;
  // Read outside the closure: the guard at the top of the handler narrows
  // `a.grp_id` to a number, and that narrowing does not survive into a callback.
  // `eq()` refuses a possibly-null value against a NOT NULL column, where the
  // bound statement accepted one and matched nothing.
  const grpId = a.grp_id;
  const advanced = await ctx.bus.transaction(async (tx) => {
    // `.returning()` and not a row count: RETURNING emits one row per updated row
    // and this WHERE matches at most one, so the length is the answer.
    const done = await tx
      .update(task)
      .set({ status: "done", claim_json: claim, owner_agent_id: a.id })
      .where(
        and(
          eq(task.id, b.task_id),
          eq(task.grp_id, grpId),
          or(
            isNull(task.owner_agent_id),
            eq(task.owner_agent_id, a.id),
            inArray(task.owner_agent_id, retiredAgents(tx)),
          ),
        ),
      )
      .returning({ id: task.id });
    if (done.length === 0) return null;
    // A slice enters review only when nothing is left open in it. Reviewing a
    // half-finished slice burns the reviewer on work that is about to change.
    const shouldTick = await advanceCompletedSlice(ctx, tx, a, completion, b.review);
    await ctx.bus.emit({
      grpId: a.grp_id,
      author: a.role,
      kind: "state_change",
      body: `task ${b.task_id} done`,
      meta: { task_id: b.task_id, claim },
    });
    return shouldTick;
  });
  if (advanced === null) return bad(`task ${b.task_id} is not yours, or does not exist`);
  if (advanced) await ctx.sched.tick();
  return message("ok");
}) satisfies AgentHandler<z.infer<typeof TaskDoneBody>>;
