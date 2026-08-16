import { z } from "zod";
import type { Caller, Ctx } from "../../ctx.ts";
import { query as ctxQuery } from "../../mech/knowledge/ctx.ts";
import { loadTree, NOTE_PREFIX, render, search } from "../../mech/knowledge/pageindex.ts";
import { projectOfAgent } from "../../mech/util/rows.ts";
import { Id } from "../fields.ts";
import { type AgentHandler, message } from "../shared.ts";

async function pageIndexContext(ctx: Ctx, caller: Caller, projectId: number | null, question: string): Promise<string> {
  const tree = loadTree(ctx.db, projectId);
  if (!tree || !ctx.askIn || !projectId) return "";

  try {
    const scope = caller.grp_id ? { grp: caller.grp_id } : { project: projectId };
    const hits = await search(tree, question, ctx.askIn(scope));
    if (hits.length === 0) return "";

    let answer = render(tree, hits);
    const noteIds = hits.filter((hit) => hit.startsWith(NOTE_PREFIX)).map((hit) => Number(hit.split("/").pop()));
    for (const id of noteIds) {
      const note = ctx.db
        .query<{ kind: string; body: string }, [number]>("SELECT kind, body FROM note WHERE id = ?")
        .get(id);
      if (note) answer += `\n\n### ${note.kind} #${id}\n${note.body.slice(0, 1200)}`;
    }
    return answer;
  } catch {
    return "";
  }
}

/**
 * The first thing every role is told to run, so its cost is everyone's cost.
 *
 * PageIndex first, lexical rank as the fallback, and a hard character budget on
 * the answer either way — this returns into a transcript that will be re-read
 * every turn of the session, which is what makes a generous answer expensive
 * long after the question was answered.
 */

/** A question, and how much of an answer it is willing to pay for. */
export const CtxQueryBody = z.object({
  question: z.string().min(1).max(2000),
  limit: Id.pipe(z.number().max(64_000)).optional(),
});

export const postCtxQuery = (async (ctx, _req, a, _p, b) => {
  const projectId = projectOfAgent(ctx.db, a.id);
  // PageIndex: a model walks the summary tree and can land on a file whose name
  // shares no word with the question. It costs one cheap call, against grep rounds
  // that each re-read the agent's whole transcript. No tree yet, or a navigator
  // that fails, falls through to the lexical map inside ctxQuery.
  // In the caller's own sandbox, not the project's. The walk reads summaries
  // already in the database; the shared index build remains project-scoped.
  const where = await pageIndexContext(ctx, a, projectId, b.question);
  return message(
    ctxQuery({
      db: ctx.db,
      grpId: a.grp_id,
      projectId,
      question: b.question,
      where,
      // From config, not the module default: `ctxBudgetChars` was a setting that
      // read back as itself and changed nothing, because nobody ever passed it here.
      budget: b.limit ?? ctx.config.ctxBudgetChars,
    }),
  );
}) satisfies AgentHandler<z.infer<typeof CtxQueryBody>>;
