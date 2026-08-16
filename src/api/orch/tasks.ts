import { z } from "zod";
import { Id } from "../fields.ts";
import { bad, text, type AgentHandler } from "../shared.ts";
import { extractClaimedFiles } from "../../mech/flow/reconcile.ts";
import { recordGate } from "../../mech/gate.ts";
import { validateSelfReview } from "../../mech/util/validate.ts";
import type { SliceState } from "../../states.ts";

/**
 * The task card and the two verbs that move it.
 *
 * `task done` is the biggest of the three and is barely an HTTP handler: it is
 * the slice-close state machine — claim shape, parent status, the self-review a
 * closing task owes, and the gate job that follows.
 */

export const getTasks: AgentHandler = async (ctx, req, a) => {
  // The caller's own group, not the one it asked for. Every other `/orch` route
  // checks the token; these two never did, and the `/orch/` prefix gate on the
  // mailbox made them look as if they had — so any sandbox could enumerate any
  // group's cards by putting a number in a query string.
  if (!a.grp_id) return text("this route is for a group's agent", 401);
  const grp = a.grp_id;
  // Only the slice being worked, plus anything not tied to a slice. Showing the
  // whole plan's tasks let the writer mark future slices done, which pushed
  // slices that had never started into review.
  const rows = ctx.db
    .query<
      {
        id: number;
        title: string;
        status: string;
        slice_id: number | null;
        owner: string | null;
        claim_json: string | null;
      },
      [number]
    >(
      // The owner is only shown when it is someone who can still act. A retired
      // row rendered as `engineer` reads as "another engineer has this", and the
      // writer's own name for itself is `engineer` too — so the list said the card
      // was taken, by nobody, forever.
      `SELECT t.id, t.title, t.status, t.slice_id, t.claim_json,
              (SELECT a.role FROM agent a WHERE a.id = t.owner_agent_id AND a.state != 'retired') AS owner
       FROM task t
       WHERE t.grp_id = ?
         AND (t.slice_id IS NULL
              OR t.slice_id IN (SELECT id FROM slice WHERE grp_id = t.grp_id AND status NOT IN ('pending','accepted')))
       ORDER BY t.id`,
    )
    .all(grp);
  // Why the list is short, in the list itself.
  //
  // Slices run in order, so a later slice sits `pending` and its cards are filtered
  // out above. From inside a turn that is indistinguishable from cards that were
  // never written, and an agent that cannot tell the difference does the reasonable
  // thing: it asks the boss to create them. Measured once and it cost a blocker
  // escalation, a suspended group and 12 minutes of the boss's queue — for a state
  // that was correct the whole time. Prompt wording cannot fix this; the answer has
  // to be where the question is asked.
  const later = ctx.db
    .query<{ seq: number; n: number }, [number]>(
      `SELECT s.seq AS seq, count(t.id) AS n
       FROM slice s JOIN task t ON t.slice_id = s.id
       WHERE s.grp_id = ? AND s.status = 'pending'
       GROUP BY s.id ORDER BY s.seq`,
    )
    .all(grp);
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
  const redo = reopened.length
    ? "\n" +
      reopened
        .map((r) => {
          let claim: unknown = null;
          try { claim = JSON.parse(r.claim_json!); } catch {}
          const files = extractClaimedFiles([claim]).slice(0, 6).join(", ");
          return `task ${r.id} was delivered once already${files ? `, touching ${files}` : ""}`;
        })
        .join("\n") +
      "\nCheck the branch before you rewrite anything — `git log origin/main..HEAD` and " +
      "`git diff origin/main...HEAD`. If the work is still there and still right, claim the card " +
      'and close it with `--already-done "<what is on the branch>"` instead of doing it twice.'
    : "";
  if (rows.length === 0) return text(`no tasks are open in this group right now${gated}`);
  // Lines, not a JSON array. Handing an agent `[{"id":1,"title":"…"}]` invites it
  // to pass the title where an id belongs, which is what happened live.
  return text(
    ["id  status       slice  owner       title", ...rows.map(
      (r) =>
        `${String(r.id).padEnd(4)}${r.status.padEnd(13)}${String(r.slice_id ?? "-").padEnd(7)}` +
        `${(r.owner ?? "-").padEnd(12)}${r.title}`,
    )].join("\n") + redo + gated,
  );
};

export const TaskRef = z.object({ task_id: Id });

export const postTaskClaim: AgentHandler<z.infer<typeof TaskRef>> = async (ctx, _req, a, _p, b) => {
  // A retired owner is not an owner. Ownership is a row id, and a group that
  // rehires its writer — a rotation, a restart, anything that ends one agent row
  // and starts another — leaves its own cards locked to a session that no longer
  // exists. Nothing could ever unlock them, which is how a live group ends up with
  // work it is not allowed to touch.
  const r = ctx.db.run(
    `UPDATE task SET owner_agent_id = ?, status = 'in_progress'
     WHERE id = ? AND (owner_agent_id IS NULL
                       OR owner_agent_id IN (SELECT id FROM agent WHERE state = 'retired'))
       AND (slice_id IS NULL
            OR slice_id IN (SELECT id FROM slice WHERE id = task.slice_id AND status NOT IN ('pending','accepted')))`,
    [a.id, b.task_id],
  );
  return r.changes ? text("ok") : bad("already claimed, or its slice is not being worked yet");
};

/**
 * `claim` stays `unknown`.
 *
 * What it has to contain is checked below against what git says changed, which
 * is a stronger question than any shape: an empty object passes a schema and
 * makes reconcile vacuous — "claimed vs actual" degenerates into "did anything
 * change at all", which is what was observed live when every claim arrived `{}`.
 */
export const TaskDoneBody = z.object({
  task_id: Id,
  claim: z.unknown().optional(),
  already_done: z.string().max(4000).optional(),
  review: z.string().max(8000).optional(),
});

export const postTaskDone: AgentHandler<z.infer<typeof TaskDoneBody>> = async (ctx, _req, a, _p, b) => {

  // An empty claim makes reconcile vacuous: "claimed vs actual" degenerates into
  // "did anything change at all". Observed live — every claim arrived as {}.
  const claimText = JSON.stringify(b.claim ?? null);
  const hasClaim = Boolean(b.claim) && claimText !== "{}" && claimText !== "null" && claimText !== '""';
  if (!hasClaim && !b.already_done?.trim()) {
    return bad(
      "task done needs --claim (what you actually changed: files and a one-line summary), " +
        'or --already-done "<why>" if an earlier slice already covered it.',
    );
  }
  // A task belonging to a slice that has not started cannot be completed: the
  // writer works one slice at a time, and letting it close future tasks pushed
  // unstarted slices into review.
  const owning = ctx.db
    .query<{ status: SliceState | null }, [number]>(
      "SELECT (SELECT status FROM slice WHERE id = t.slice_id) AS status FROM task t WHERE t.id = ?",
    )
    .get(b.task_id);
  if (owning?.status && ["pending", "accepted"].includes(owning.status)) {
    return bad(
      `task ${b.task_id} belongs to a slice that is not being worked (${owning.status}). ` +
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
   * check: it reads as done. PLAN.md §7 is explicit that self-review needs a
   * deterministic anchor (the acceptance criteria and the agent's own diff lines) or
   * it is self-congratulation.
   *
   * Demanded only on the task that closes the slice: that is where the work is
   * finished, and asking per task would make it a formality four times over.
   */
  const closing = ctx.db
    .query<{ slice_id: number | null; open: number }, [number]>(
      `SELECT t.slice_id AS slice_id,
              (SELECT count(*) FROM task o WHERE o.slice_id = t.slice_id AND o.status != 'done' AND o.id != t.id) AS open
       FROM task t WHERE t.id = ?`,
    )
    .get(b.task_id);
  const lastOfSlice = closing?.slice_id != null && closing.open === 0;
  if (lastOfSlice) {
    const spec = ctx.db
      .query<{ accept_spec: string; seq: number }, [number]>("SELECT accept_spec, seq FROM slice WHERE id = ?")
      .get(closing!.slice_id!);
    const v = validateSelfReview(b.review ?? "", 1);
    if (!v.ok) {
      return bad(
        `${v.error}\n\nThis task closes S${spec?.seq ?? "?"}, so it needs a self-review:\n` +
          `  orch task done ${b.task_id} --claim '{…}' --review "pass: <criterion> — <the diff line that satisfies it>"\n` +
          `Acceptance criterion: ${spec?.accept_spec ?? "(none recorded)"}`,
      );
    }
  }

  // Unowned is fine: a group has one writer, so requiring an explicit claim only
  // adds a step that gets forgotten. Someone else's task is not — unless that
  // someone else is retired, in which case the card outlived its claimant and the
  // group's current writer is the only one who can finish it. Same reason as claim.
  const claim = b.already_done?.trim()
    ? { already_done: b.already_done.trim(), files: [] }
    : (b.claim as unknown);
  const done = ctx.db.run(
    `UPDATE task SET status = 'done', claim_json = ?, owner_agent_id = ?
     WHERE id = ? AND (owner_agent_id IS NULL OR owner_agent_id = ?
                       OR owner_agent_id IN (SELECT id FROM agent WHERE state = 'retired'))`,
    [JSON.stringify(claim), a.id, b.task_id, a.id],
  );
  if (done.changes === 0) return bad(`task ${b.task_id} is not yours, or does not exist`);
  ctx.bus.emit({
    grpId: a.grp_id,
    author: a.role,
    kind: "state_change",
    body: `task ${b.task_id} done`,
    meta: { task_id: b.task_id, claim: b.claim ?? {} },
  });

  // A slice enters review only when nothing is left open in it. Reviewing a
  // half-finished slice burns the reviewer on work that is about to change.
  const slice = ctx.db
    .query<{ slice_id: number | null }, [number]>("SELECT slice_id FROM task WHERE id = ?")
    .get(b.task_id);
  if (lastOfSlice && b.review?.trim()) {
    recordGate(ctx.db, closing!.slice_id!, "self", "pass");
    ctx.bus.emit({
      grpId: a.grp_id,
      author: a.role,
      kind: "gate_result",
      intent: "decision",
      body: b.review.trim().slice(0, 1200),
      meta: { slice_id: closing!.slice_id, layer: "self" },
    });
  }

  if (slice?.slice_id) {
    const open = ctx.db
      .query<{ c: number }, [number]>(
        "SELECT count(*) AS c FROM task WHERE slice_id = ? AND status != 'done'",
      )
      .get(slice.slice_id)!.c;
    if (open === 0) {
      ctx.db.run("UPDATE slice SET status = 'gate' WHERE id = ?", [slice.slice_id]);
      // Same priority as reconcile, and for the same reason: this job consults no
      // model, runs in 16 seconds, and the whole slice → QA → boss chain is stuck
      // behind it. At the default 0 it queued behind every priority-4 and -6 turn
      // in the fleet — measured 3235s of waiting for 16s of work, which is most of
      // why QA turns averaged an hour and 54 minutes before they started.
      ctx.sched.enqueue("gate", { grp_id: a.grp_id, slice_id: slice.slice_id, priority: 5 });
      ctx.sched.tick();
    }
  }
  return text("ok");
};
