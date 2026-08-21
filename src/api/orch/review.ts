import { and, asc, count, eq, gt, ne, sql } from "drizzle-orm";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { roleFor, type Ctx } from "../../mech/ctx.ts";
import { acceptSlice } from "../../mech/flow/review.ts";
import { criteriaIn, validateSelfReview } from "../../mech/util/validate.ts";
import { sliceDiffBase } from "../../mech/git/gitops.ts";
import { baseRefFor, sandboxGit } from "../../mech/git/checkout.ts";
import { WORK } from "../../mech/sandbox/sandbox.ts";
import { z } from "zod";
import { Attachment as AttachmentSchema, GroupRef, Id, IdParams } from "../../contracts/fields.ts";
import type { AgentHandler, Handler } from "../../http/handler.ts";
import { badEnglish, json, message } from "../../http/respond.ts";
import { mayAct, resolveGroup } from "./access.ts";
import { withAttachments } from "../../mech/util/attachment-text.ts";
import { bossFact } from "../panel/attach.ts";
import { GateName, gatesFor } from "../../mech/gate.ts";
import { event, grp, slice as slices } from "../../platform/persistence/schema.ts";
import { hold } from "../../mech/flow/intercept.ts";

/**
 * The verdicts, and the evidence the boss reads before adding one.
 *
 * QA on a slice, the Auditor on a branch, and the boss on either — plus the
 * diff, the gate logs and the acceptance line that make the boss's button worth
 * pressing. Those three are not decoration: a decision offered without them is
 * a rubber stamp, and the three gates in front of it were run for nothing.
 */

/**
 * An explicit verb, never a boolean.
 *
 * A model writing `{"pass": false}` and a model writing `{"pass": "false"}` are
 * one keystroke apart and the second is truthy — a "fail" delivered as a "pass",
 * which is the one error this whole pipeline exists to prevent.
 */
const Verdict = z.enum(["pass", "fail"]);

export const AuditBody = z.object({ group_id: GroupRef, verdict: Verdict, note: z.string().max(8000).optional() });

export const postAudit = (async (ctx, _req, a, _p, b) => {
  if (a.role !== roleFor(ctx, "audit_branch")) return badEnglish(`${a.role} does not file audit verdicts`);
  const gid = await resolveGroup(ctx, b.group_id);
  if (!gid) return badEnglish("which group? pass its id or name");
  // The Auditor is deliberately not a member of the group it reviews, so it is
  // the one role whose group check is inverted. It is still bounded by its
  // project — a pass here opens a PR, which is a host `git push`, and that is not
  // an action to leave addressable by any group id an agent cares to name.
  if (a.grp_id === gid) return badEnglish("an auditor may not audit its own group");
  if (!(await mayAct(ctx.db, a, gid))) return message("not your project", 403);

  await ctx.bus.emit({
    grpId: gid,
    author: roleFor(ctx, "audit_branch"),
    kind: "gate_result",
    intent: "decision",
    body: `audit ${b.verdict}${b.note ? `: ${b.note}` : ""}`,
    meta: { verdict: b.verdict },
  });
  await ctx.auditVerdict?.(gid, b.verdict === "pass", b.note ?? "");
  return message("ok");
}) satisfies AgentHandler<z.infer<typeof AuditBody>>;

/**
 * QA's verdict, as a value rather than as prose.
 *
 * Parsing a review out of natural language means occasionally mis-reading a
 * "fail" as a "pass", which is the one error this whole pipeline exists to
 * prevent. So the verdict is an explicit verb.
 */
export const ReviewBody = z.object({
  slice_id: Id,
  verdict: Verdict,
  note: z.string().max(8000).optional(),
});

export const postReview = (async (ctx, _req, a, _p, b) => {
  if (a.role !== roleFor(ctx, "review_slice") && a.role !== roleFor(ctx, "audit_branch"))
    return badEnglish(`${a.role} does not file review verdicts`);

  const [slice] = await ctx.db
    .select({ id: slices.id, grp_id: slices.grp_id, seq: slices.seq, accept_spec: slices.accept_spec })
    .from(slices)
    .where(eq(slices.id, b.slice_id));
  if (!slice) return badEnglish(`no slice ${b.slice_id}`);
  if (slice.grp_id !== a.grp_id) return badEnglish("that slice belongs to another group");

  // QA's verdict was the one review layer with no floor under it: `--verdict pass`
  // with an empty note was accepted, which makes the independent check a formality
  // and leaves "the acceptance criterion itself was wrong" to surface three slices
  // later. Same validator the Engineer's self-review uses, and the same reason —
  // a verdict per criterion, or it carries no information.
  const need = criteriaIn(slice.accept_spec);
  const v = validateSelfReview(b.note ?? "", need);
  if (!v.ok) {
    return badEnglish(
      `${v.error}\n\nAcceptance for S${slice.seq}: ${slice.accept_spec}\n` +
        `  orch review ${b.slice_id} --verdict ${b.verdict} --note "pass: <criterion> — <what you ran and saw>"`,
    );
  }

  await ctx.bus.emit({
    grpId: slice.grp_id,
    author: a.role,
    kind: "gate_result",
    intent: "decision",
    body: `S${slice.seq} ${b.verdict}${b.note ? `: ${b.note}` : ""}`,
    meta: { slice_id: slice.id, verdict: b.verdict },
  });
  await ctx.reviewVerdict?.(slice.id, b.verdict === "pass", b.note ?? "");
  return message("ok");
}) satisfies AgentHandler<z.infer<typeof ReviewBody>>;

/** Roughly a screenful of diff. Beyond this the boss wants the editor, not a panel. */
// 400k. The old 80k was sized for a page that pasted the whole diff into one
// <pre>: past that it was unreadable anyway, so truncating cost nothing. The
// viewer now renders one file at a time from a parsed diff, so the ceiling that
// matters is the browser's, not the reader's — and a slice that touched thirty
// files was being cut off mid-review, which is the one moment the boss needs all
// of it.
const DIFF_CAP = 400_000;

/**
 * The diff, against the base this work will actually land on.
 *
 * Never `git diff <base_sha>` straight: after a rebase that base is a commit on
 * old main and the diff picks up every other group's landed work — see
 * `sliceDiffBase`. And the project's base branch rather than whatever the
 * sandbox's clone thinks the default is, because a project that develops on
 * `develop` says so once.
 */
async function sliceDiff(
  ctx: Ctx,
  grpId: number,
  projectId: number,
  baseSha: string | null,
): Promise<{ stat: string; diff: string; truncated: boolean; scope: "slice" | "branch" }> {
  const empty = { stat: "", diff: "", truncated: false, scope: "slice" as const };
  const git = sandboxGit(ctx, { grp: grpId });
  const from = await sliceDiffBase(git, WORK, baseSha, projectId ? await baseRefFor(ctx, projectId) : undefined);
  if (!from) return empty;

  const [s, d] = await Promise.all([
    git(["diff", "--stat", from.base, "--"], WORK),
    git(["diff", from.base, "--"], WORK),
  ]);
  const diff = d.code === 0 ? d.out : "";
  return {
    stat: s.code === 0 ? s.out.trim() : "",
    diff: diff.slice(0, DIFF_CAP),
    truncated: diff.length > DIFF_CAP,
    scope: from.scope,
  };
}

/**
 * The gate logs that exist. The gate wrote these itself (gate.ts logPath), and a
 * configured gate that never ran is left out rather than offered as a link to
 * nothing.
 */
async function gateLogs(
  ctx: Ctx,
  projectId: number,
  sliceId: number,
): Promise<Array<{ name: string; path: string; size: number }>> {
  const configured = await gatesFor(ctx.db, projectId);
  return configured.flatMap((name) => {
    const path = join(ctx.config.dataDir, "gates", `${sliceId}-${name}.log`);
    return existsSync(path) ? [{ name, path, size: Bun.file(path).size }] : [];
  });
}

/**
 * What actually happened in one slice: the diff, QA's verdict, the gate output.
 *
 * Accepting is one of the boss's three approval points, and it was being asked
 * for on a title and an acceptance line — the same information the boss already
 * approved on the DRAFT card. Nothing new to judge means the button is a rubber
 * stamp, which makes the three gates in front of it decorative.
 */
export const getEvidence = (async (ctx, _req, params) => {
  const id = params.id;
  const [sl] = await ctx.db
    .select({
      grp_id: slices.grp_id,
      seq: slices.seq,
      title: slices.title,
      accept_spec: slices.accept_spec,
      base_sha: slices.base_sha,
      retries: slices.retries,
    })
    .from(slices)
    .where(eq(slices.id, id));
  if (!sl) return message("no such slice", 404);

  // One lookup for both halves: the diff base and the gate list are the same
  // project's answers, and asking twice is two places for them to disagree.
  const [owner] = await ctx.db.select({ project_id: grp.project_id }).from(grp).where(eq(grp.id, sl.grp_id));
  const projectId = owner?.project_id ?? 0;
  // Both reviewers file through the same route, so this is QA's verdict on a
  // slice and the Auditor's on a branch, in the order they were given.
  const verdicts = await ctx.db
    .select({ author: event.author, body: event.body, at: event.at })
    .from(event)
    // Raw on the right: jsonb containment has no Drizzle operator, and the slice
    // id lives in `meta_json`. Built by Postgres rather than encoded here — the
    // driver encodes a parameter bound against jsonb, so a pre-encoded document
    // arrived as a jsonb *string* and `@>` matched nothing, silently.
    .where(and(eq(event.kind, "gate_result"), sql`${event.meta_json} @> jsonb_build_object('slice_id', ${id}::int)`))
    .orderBy(asc(event.seq));

  return json({
    ...sl,
    ...(await sliceDiff(ctx, sl.grp_id, projectId, sl.base_sha)),
    verdicts,
    gates: await gateLogs(ctx, projectId, id),
  });
}) satisfies Handler<undefined, z.infer<typeof IdParams>>;

/** Tail of one gate's log, on demand: it is only opened when a verdict is doubted. */
export const GateLogParams = IdParams.extend({ name: GateName });
export const GateLogQuery = z.object({ grep: z.string().max(4000).optional() });

export const getGateLog = (async (ctx, _req, params, { grep }) => {
  const path = join(ctx.config.dataDir, "gates", `${params.id}-${params.name}.log`);
  if (!existsSync(path)) return message("no log", 404);
  const raw = await Bun.file(path).text();
  const lines = raw.split("\n");
  // The panel scrolls this locally, so the tail is about not shipping a 200MB
  // build log, not about what is worth reading. 400 lines was the latter, and it
  // cut a `bun test` run in half.
  //
  // A substring, not a regex — the same rule as `getLeaseLog`, which was fixed
  // and never generalised. `new RegExp` on a caller-supplied string runs on the
  // host, in the single process that is also the SSE fan-out, the scheduler, the
  // mailbox poller and every blocked `orch lease`; one nested quantifier stalls
  // all of it. This route takes no token either.
  const text = grep
    ? lines
        .filter((l) => l.includes(grep))
        .slice(0, 4000)
        .join("\n")
    : lines.slice(-4000).join("\n");
  return json({ text });
}) satisfies Handler<z.infer<typeof GateLogQuery>, z.infer<typeof GateLogParams>>;

export const SliceDecision = IdParams.extend({
  decision: z.enum(["accept", "reject"]),
});

export const SliceDecisionBody = z.object({
  feedback: z.string().max(20_000).optional(),
  attachments: z.array(AttachmentSchema).max(20).optional(),
});

export const postSliceDecision = (async (ctx, _req, params, raw) => {
  const b = { feedback: raw.feedback ? withAttachments(raw.feedback, raw.attachments) : raw.feedback };
  const id = params.id;
  const accept = params.decision === "accept";
  const [sl] = await ctx.db
    .select({ grp_id: slices.grp_id, seq: slices.seq, title: slices.title })
    .from(slices)
    .where(eq(slices.id, id));
  if (!sl) return message("no such slice", 404);

  // One acceptance path, whoever accepted: see acceptSlice.
  if (accept) await acceptSlice(ctx, id, "boss");

  if (!accept) {
    await ctx.db.update(slices).set({ status: "rejected" }).where(eq(slices.id, id));
    await ctx.bus.emit({
      grpId: sl.grp_id,
      author: "boss",
      kind: "boss_say",
      intent: "request",
      body: b.feedback ?? "rejected",
      meta: { slice_id: id },
    });
    // Only when the boss said something. A rejection with no words is already the
    // slice's own status and the event above; filing it as a *fact* puts a note on
    // the blackboard that tells later work nothing, and three of them sediment into
    // a project rule about nothing. `lessons.ts` used to filter the placeholder's
    // words back out, one table further down.
    if (b.feedback) await bossFact(ctx, sl.grp_id, b.feedback);
    // With autoAdvance on, later slices were built on the one just rejected. Fixing
    // it underneath work that assumed it is how two problems become four, so the
    // group stops and says so instead.
    // `sl.seq` and not the subquery that was here: it read the rejected slice's
    // own `seq`, which this handler already selected.
    const [started] = await ctx.db
      .select({ c: count() })
      .from(slices)
      .where(and(eq(slices.grp_id, sl.grp_id), gt(slices.seq, sl.seq), ne(slices.status, "pending")));
    const ahead = started?.c ?? 0;
    if (ctx.config.autoAdvance && ahead > 0) {
      await hold(ctx.db, sl.grp_id, { reason: "escalation", from: "RUNNING" });
      await ctx.bus.emit({
        grpId: sl.grp_id,
        author: "orchestrator",
        kind: "escalation",
        intent: "ask",
        severity: "blocker",
        body:
          `你退回了 S${sl.seq}，但 autoAdvance 已经让后面 ${ahead} 片开工了 —— 它们是在这一片的基础上做的。` +
          `全组先停下：要么让它先修这一片，要么把后面几片一起退回。`,
      });
    }
    await ctx.sched.enqueue("agent_turn", { grp_id: sl.grp_id, slice_id: id, payload: { rejection: b.feedback } });
  }
  await ctx.sched.tick();
  return message("ok");
}) satisfies Handler<z.infer<typeof SliceDecisionBody>, z.infer<typeof SliceDecision>>;
