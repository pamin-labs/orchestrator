import { join } from "node:path";
import { existsSync } from "node:fs";
import { acceptSlice } from "../../mech/flow/review.ts";
import { criteriaIn, validateSelfReview } from "../../mech/util/validate.ts";
import { sliceDiffBase } from "../../mech/git/worktree.ts";
import { baseRefFor, sandboxGit } from "../../mech/git/checkout.ts";
import { WORK } from "../../mech/sandbox/sandbox.ts";
import { z } from "zod";
import { Attachment as AttachmentSchema, GroupRef, Id } from "../fields.ts";
import { bad, json, mayAct, resolveGroup, text, type AgentHandler, type Handler } from "../shared.ts";
import { bossFact, withAttachments } from "../panel/attach.ts";
import { gatesFor } from "../../mech/gate.ts";
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

export const postAudit: AgentHandler<z.infer<typeof AuditBody>> = async (ctx, _req, a, _p, b) => {
  if (a.role !== "auditor") return bad(`${a.role} does not file audit verdicts`);
  const gid = resolveGroup(ctx, b.group_id);
  if (!gid) return bad("which group? pass its id or name");
  // The Auditor is deliberately not a member of the group it reviews, so it is
  // the one role whose group check is inverted. It is still bounded by its
  // project — a pass here opens a PR, which is a host `git push`, and that is not
  // an action to leave addressable by any group id an agent cares to name.
  if (a.grp_id === gid) return bad("an auditor may not audit its own group");
  if (!mayAct(ctx, a, gid)) return text("not your project", 403);

  ctx.bus.emit({
    grpId: gid,
    author: "auditor",
    kind: "gate_result",
    intent: "decision",
    body: `audit ${b.verdict}${b.note ? `: ${b.note}` : ""}`,
    meta: { verdict: b.verdict },
  });
  ctx.auditVerdict?.(gid, b.verdict === "pass", b.note ?? "");
  return text("ok");
};

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

export const postReview: AgentHandler<z.infer<typeof ReviewBody>> = async (ctx, _req, a, _p, b) => {
  if (a.role !== "qa" && a.role !== "auditor") return bad(`${a.role} does not file review verdicts`);

  const slice = ctx.db
    .query<{ id: number; grp_id: number; seq: number; accept_spec: string }, [number]>(
      "SELECT id, grp_id, seq, accept_spec FROM slice WHERE id = ?",
    )
    .get(b.slice_id);
  if (!slice) return bad(`no slice ${b.slice_id}`);
  if (slice.grp_id !== a.grp_id) return bad("that slice belongs to another group");

  // QA's verdict was the one review layer with no floor under it: `--verdict pass`
  // with an empty note was accepted, which makes the independent check a formality
  // and leaves "the acceptance criterion itself was wrong" to surface three slices
  // later. Same validator the Engineer's self-review uses, and the same reason —
  // a verdict per criterion, or it carries no information.
  const need = criteriaIn(slice.accept_spec);
  const v = validateSelfReview(b.note ?? "", need);
  if (!v.ok) {
    return bad(
      `${v.error}\n\nAcceptance for S${slice.seq}: ${slice.accept_spec}\n` +
        `  orch review ${b.slice_id} --verdict ${b.verdict} --note "pass: <criterion> — <what you ran and saw>"`,
    );
  }

  ctx.bus.emit({
    grpId: slice.grp_id,
    author: a.role,
    kind: "gate_result",
    intent: "decision",
    body: `S${slice.seq} ${b.verdict}${b.note ? `: ${b.note}` : ""}`,
    meta: { slice_id: slice.id, verdict: b.verdict },
  });
  ctx.reviewVerdict?.(slice.id, b.verdict === "pass", b.note ?? "");
  return text("ok");
};

/** Roughly a screenful of diff. Beyond this the boss wants the editor, not a panel. */
// 400k. The old 80k was sized for a page that pasted the whole diff into one
// <pre>: past that it was unreadable anyway, so truncating cost nothing. The
// viewer now renders one file at a time from a parsed diff, so the ceiling that
// matters is the browser's, not the reader's — and a slice that touched thirty
// files was being cut off mid-review, which is the one moment the boss needs all
// of it.
const DIFF_CAP = 400_000;

/**
 * What actually happened in one slice: the diff, QA's verdict, the gate output.
 *
 * Accepting is one of the boss's three approval points, and it was being asked
 * for on a title and an acceptance line — the same information the boss already
 * approved on the DRAFT card. Nothing new to judge means the button is a rubber
 * stamp, which makes the three gates in front of it decorative.
 */
export const getEvidence: Handler = async (ctx, _req, params) => {
  const id = Number(params.id);
  const sl = ctx.db
    .query<
      { grp_id: number; seq: number; title: string; accept_spec: string; base_sha: string | null; retries: number },
      [number]
    >("SELECT grp_id, seq, title, accept_spec, base_sha, retries FROM slice WHERE id = ?")
    .get(id);
  if (!sl) return text("no such slice", 404);


  let stat = "";
  let diff = "";
  let truncated = false;
  // Never `git diff <base_sha>` straight: after a rebase that base is a commit on
  // old main and the diff picks up every other group's landed work. See
  // `sliceDiffBase`.
  let scope: "slice" | "branch" = "slice";
  {
    const git = sandboxGit(ctx, { grp: sl.grp_id });
    // The project's base branch, not whatever the sandbox's clone thinks the
    // default is: the boss is reading this diff against the branch this work
    // will land on, and a project that develops on `develop` says so once.
    const projectId = ctx.db
      .query<{ project_id: number }, [number]>("SELECT project_id FROM grp WHERE id = ?")
      .get(sl.grp_id)?.project_id;
    const from = await sliceDiffBase(
      git,
      WORK,
      WORK,
      sl.base_sha,
      projectId ? await baseRefFor(ctx, projectId) : undefined,
    );
    if (from) {
      scope = from.scope;
      const [s, d] = await Promise.all([
        git(WORK, ["diff", "--stat", from.base, "--"], WORK),
        git(WORK, ["diff", from.base, "--"], WORK),
      ]);
      stat = s.code === 0 ? s.out.trim() : "";
      diff = d.code === 0 ? d.out : "";
      truncated = diff.length > DIFF_CAP;
      if (truncated) diff = diff.slice(0, DIFF_CAP);
    }
  }

  // Both reviewers file through the same route, so this is QA's verdict on a
  // slice and the Auditor's on a branch, in the order they were given.
  const verdicts = ctx.db
    .query<{ author: string; body: string; at: number }, [number]>(
      `SELECT author, body, at FROM event
       WHERE kind = 'gate_result' AND json_extract(meta_json, '$.slice_id') = ?
       ORDER BY seq`,
    )
    .all(id);

  // The gate wrote these itself (gate.ts logPath). Tail only: a build log is
  // megabytes and the useful part is at the end.
  const projectId =
    ctx.db.query<{ project_id: number }, [number]>("SELECT project_id FROM grp WHERE id = ?").get(sl.grp_id)
      ?.project_id ?? 0;
  const gates = gatesFor(ctx.db, projectId).flatMap((name) => {
    const path = join(ctx.config.dataDir ?? "data", "gates", `${id}-${name}.log`);
    if (!existsSync(path)) return [];
    const raw = Bun.file(path);
    return [{ name, path, size: raw.size }];
  });

  return json({ ...sl, stat, diff, truncated, scope, verdicts, gates });
};

/** Tail of one gate's log, on demand: it is only opened when a verdict is doubted. */
export const getGateLog: Handler = async (ctx, req, params) => {
  const name = (params.name ?? "").replace(/[^\w.-]/g, "");
  const path = join(ctx.config.dataDir ?? "data", "gates", `${Number(params.id)}-${name}.log`);
  if (!existsSync(path)) return text("no log", 404);
  const raw = await Bun.file(path).text();
  const grep = new URL(req.url).searchParams.get("grep");
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
  return text(grep ? lines.filter((l) => l.includes(grep)).slice(0, 4000).join("\n") : lines.slice(-4000).join("\n"));
};

export const SliceDecision = z.object({
  id: z.coerce.number().int().positive(),
  decision: z.enum(["accept", "reject"]),
});

export const SliceDecisionBody = z.object({
  feedback: z.string().max(20_000).optional(),
  attachments: z.array(AttachmentSchema).max(20).optional(),
});

export const postSliceDecision: Handler<z.infer<typeof SliceDecisionBody>> = async (ctx, _req, params, raw) => {
  const b = { feedback: raw.feedback ? withAttachments(raw.feedback, raw.attachments) : raw.feedback };
  const id = Number(params.id);
  const accept = params.decision === "accept";
  const sl = ctx.db
    .query<{ grp_id: number; seq: number; title: string }, [number]>(
      "SELECT grp_id, seq, title FROM slice WHERE id = ?",
    )
    .get(id);
  if (!sl) return text("no such slice", 404);

  // One acceptance path, whoever accepted: see acceptSlice.
  if (accept) acceptSlice(ctx, id, "boss");

  if (!accept) {
    ctx.db.run("UPDATE slice SET status = 'rejected' WHERE id = ?", [id]);
    ctx.bus.emit({
      grpId: sl.grp_id,
      author: "boss",
      kind: "boss_say",
      intent: "request",
      body: b.feedback ?? "rejected",
      meta: { slice_id: id },
    });
    bossFact(ctx, sl.grp_id, b.feedback ?? "boss rejected the slice");
    // With autoAdvance on, later slices were built on the one just rejected. Fixing
    // it underneath work that assumed it is how two problems become four, so the
    // group stops and says so instead.
    const ahead = ctx.db
      .query<{ c: number }, [number, number]>(
        "SELECT count(*) AS c FROM slice WHERE grp_id = ? AND seq > (SELECT seq FROM slice WHERE id = ?) AND status != 'pending'",
      )
      .get(sl.grp_id, id)!.c;
    if (ctx.config.autoAdvance && ahead > 0) {
      hold(ctx, sl.grp_id, { reason: "escalation", from: "RUNNING" });
      ctx.bus.emit({
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
    ctx.sched.enqueue("agent_turn", { grp_id: sl.grp_id, slice_id: id, payload: { rejection: b.feedback } });
  }
  ctx.sched.tick();
  return text("ok");
};
