import { checkPrMessage } from "../../mech/git/prwatch.ts";
import { z } from "zod";
import { GroupRef } from "../../contracts/fields.ts";
import type { AgentHandler } from "../../http/handler.ts";
import { bad, message } from "../../http/respond.ts";
import { mayAct, resolveGroup } from "./access.ts";
import type { GrpState } from "../../contracts/states.ts";

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
  if (a.role !== "scribe") return bad(`${a.role} does not write pull request messages`);
  const gid = resolveGroup(ctx, b.group_id);
  if (!gid) return bad("which group? pass its id or name");
  if (!mayAct(ctx, a, gid)) return message("not your project", 403);

  const title = b.title.trim();
  const summary = b.body.trim();
  const wrong = checkPrMessage(title, summary);
  if (wrong) return bad(wrong);

  const g = ctx.db
    .query<{ status: GrpState; pr_number: number | null }, [number]>("SELECT status, pr_number FROM grp WHERE id = ?")
    .get(gid);
  if (!g) return bad("no such group");
  ctx.db.run("UPDATE grp SET pr_title = ?, pr_summary = ? WHERE id = ?", [title, summary, gid]);
  ctx.bus.emit({
    grpId: gid,
    author: "scribe",
    kind: "note",
    intent: "note",
    body: title,
  });
  // Already open: the message is stored and `openPr` PATCHes the existing one
  // rather than opening a second. Publishing is still the same call either way.
  ctx.publishBranch?.(gid);
  return message("ok");
}) satisfies AgentHandler<z.infer<typeof PrBody>>;
