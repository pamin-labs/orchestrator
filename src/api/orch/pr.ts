import { eq } from "drizzle-orm";
import { checkPrMessage, resolveReviewThread, reviewThreadAt } from "../../mech/git/prwatch.ts";
import { outsideOwns, parseOwns } from "../../mech/flow/ownership.ts";
import { parseRepo } from "../../contracts/repository.ts";
import { roleFor } from "../../mech/ctx.ts";
import { z } from "zod";
import { GroupRef } from "../../contracts/fields.ts";
import type { AgentHandler } from "../../http/handler.ts";
import { bad, message } from "../../http/respond.ts";
import { mayAct, resolveGroup } from "./access.ts";
import { orm } from "../../platform/persistence/orm.ts";
import { grp as grps, project } from "../../platform/persistence/schema.ts";

/**
 * The Scribe's PR message: title and body, checked before anything is pushed.
 *
 * A passed audit says the branch may be published; this says what it is
 * published *as*. Separate routes because they are separate decisions and the
 * second one is the only one a human reads on GitHub.
 */

/**
 * The Scribe's message, and the thing that publishes the branch.
 *
 * The validator is the convention — the role's prompt states these four
 * refusals by name, and `checkPrMessage` is what enforces them. A Scribe that
 * gets it wrong is told which rule and can send it again within the same turn:
 * nothing is published until one lands, so there is no half state to undo.
 */
/**
 * The subject and body a reviewer will read on GitHub.
 *
 * `checkPrMessage` still has the last word — it knows the conventional prefixes
 * and the shapes this project refuses — so this only says the two fields are
 * strings of a sane size.
 */
export const PrBody = z.object({
  group_id: GroupRef,
  title: z.string().min(1).max(200),
  body: z.string().max(20_000).default(""),
});

export const postPr = (async (ctx, _req, a, _p, b) => {
  if (a.role !== roleFor(ctx, "write_pr_message")) return bad(`${a.role} does not write pull request messages`);
  const gid = resolveGroup(ctx, b.group_id);
  if (!gid) return bad("which group? pass its id or name");
  if (!mayAct(ctx.db, a, gid)) return message("not your project", 403);

  const title = b.title.trim();
  const summary = b.body.trim();
  const wrong = checkPrMessage(title, summary);
  if (wrong) return bad(wrong);

  const g = orm(ctx.db)
    .select({ status: grps.status, pr_number: grps.pr_number })
    .from(grps)
    .where(eq(grps.id, gid))
    .get();
  if (!g) return bad("no such group");
  orm(ctx.db).update(grps).set({ pr_title: title, pr_summary: summary }).where(eq(grps.id, gid)).run();
  ctx.bus.emit({
    grpId: gid,
    author: roleFor(ctx, "write_pr_message"),
    kind: "note",
    intent: "note",
    body: title,
  });
  // Already open: the message is stored and `openPr` PATCHes the existing one
  // rather than opening a second. Publishing is still the same call either way.
  ctx.publishBranch?.(gid);
  return message("ok");
}) satisfies AgentHandler<z.infer<typeof PrBody>>;

/**
 * Closing a review thread the group actually dealt with.
 *
 * The reply half of `dispatchFeedback`: threads were read to the PM and there was
 * no way to say one was handled, so a PR that had been fully addressed still
 * showed every thread open and a human closed each by hand.
 */
/**
 * `thread_id` is GitHub's opaque node id, quoted back from the feedback the group
 * was given. `note` is for the record here, not for GitHub — `resolveReviewThread`
 * takes no message, and posting a reply comment is a separate decision.
 */
export const PrResolveBody = z.object({
  group_id: GroupRef.optional(),
  thread_id: z.string().min(1).max(500),
  note: z.string().max(2000).default(""),
});

export const postPrResolve = (async (ctx, req, a, _p, b) => {
  // The caller's own group when it did not say: an agent replying to a review of
  // its own PR has exactly one answer, and making it retype the id is how the
  // wrong one gets typed.
  const gid = resolveGroup(ctx, b.group_id, a.grp_id);
  if (!gid) return bad("which group? pass its id or name");
  if (!mayAct(ctx.db, a, gid)) return message("not your project", 403);
  if (!ctx.gh) return bad("this server has no GitHub client");

  const g = orm(ctx.db)
    .select({ pr_number: grps.pr_number, owns_json: grps.owns_json, remote: project.remote })
    .from(grps)
    .innerJoin(project, eq(project.id, grps.project_id))
    .where(eq(grps.id, gid))
    .get();
  if (!g) return bad("no such group");
  if (!g.pr_number) return bad("this group has no pull request open, so it has no threads to close");

  // Where the thread is, from GitHub rather than from the caller. The id is the
  // only thing an agent holds, and it is what the next two refusals check.
  const at = await reviewThreadAt(ctx.gh, b.thread_id, req.signal);
  if (!at) return bad(`no review thread with id ${b.thread_id} — quote the id from the feedback exactly`);

  // A thread on somebody else's pull request. The repository too, not just the
  // number: PR #5 exists in every repository the fleet's token can write to.
  const mine = parseRepo(g.remote ?? "");
  if (at.repo !== mine || at.prNumber !== g.pr_number) {
    return bad(`that thread is on ${at.repo}#${at.prNumber}; this group's pull request is ${mine}#${g.pr_number}`);
  }

  // A thread on a file this group does not own. Someone else is fixing it, or
  // nobody is — either way this group closing it hides the request from whoever
  // has to act on it. `outsideOwns` is the same answer `reconcile` uses to decide
  // whether a write belongs to this group; a group that declared no boundary is
  // not policed here, exactly as it is not there.
  if (outsideOwns([at.path], parseOwns(g.owns_json)).length) {
    return bad(
      `${at.path} is outside this group's boundary, so this group does not get to close that thread — ` +
        `say so with \`orch ask-boss\` and leave it open`,
    );
  }

  const failed = await resolveReviewThread(ctx.gh, b.thread_id, req.signal);
  if (failed) return bad(failed);
  ctx.bus.emit({
    grpId: gid,
    author: a.role,
    kind: "note",
    intent: "note",
    body: `resolved review thread on ${at.path}${b.note ? `: ${b.note}` : ""}`,
  });
  return message("ok");
}) satisfies AgentHandler<z.infer<typeof PrResolveBody>>;
