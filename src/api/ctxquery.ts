import { projectOfAgent } from "../mech/util/rows.ts";
import { query as ctxQuery, DEFAULT_BUDGET } from "../mech/knowledge/ctx.ts";
import { loadTree, NOTE_PREFIX, render, search } from "../mech/knowledge/pageindex.ts";
import { z } from "zod";
import { text, type AgentHandler } from "./shared.ts";

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
  limit: z.number().int().positive().max(64_000).optional(),
});

export const postCtxQuery: AgentHandler<z.infer<typeof CtxQueryBody>> = async (ctx, _req, a, _p, b) => {
  const projectId =
    projectOfAgent(ctx.db, a.id);
  // PageIndex: a model walks the summary tree and can land on a file whose name
  // shares no word with the question. It costs one cheap call, against grep rounds
  // that each re-read the agent's whole transcript. No tree yet, or a navigator
  // that fails, falls through to the lexical map inside ctxQuery.
  let where = "";
  const tree = loadTree(ctx.db, projectId);
  if (tree && ctx.askIn && projectId) {
    try {
      // In the caller's own sandbox, not the project's.
      //
      // The walk reads nothing from a checkout: the menu is built from summaries
      // already in the database and the model answers with ids. So the container
      // it runs in cannot change the answer — and routing every group's query into
      // the one project sandbox would put ten agents' first step through a single
      // container with a single CPU quota, on the step `assemble.ts` tells every
      // role to take FIRST. The index *build* stays project-scoped; it is shared
      // work and there is one of it.
      const scope = a.grp_id ? { grp: a.grp_id } : { project: projectId };
      const hits = await search(tree, b.question, ctx.askIn(scope));
      if (hits.length) {
        where = render(tree, hits);
        // A note the walk landed on is the answer, not a pointer to it: journals and
        // retros are already short, and making the agent go and fetch one costs
        // another round, which is the thing this whole path exists to avoid.
        const noteIds = hits.filter((h) => h.startsWith(NOTE_PREFIX)).map((h) => Number(h.split("/").pop()));
        for (const id of noteIds) {
          const n = ctx.db
            .query<{ kind: string; body: string }, [number]>("SELECT kind, body FROM note WHERE id = ?")
            .get(id);
          if (n) where += `\n\n### ${n.kind} #${id}\n${n.body.slice(0, 1200)}`;
        }
      }
    } catch {}
  }
  return text(
    ctxQuery({
      db: ctx.db,
      grpId: a.grp_id,
      projectId,
      question: b.question,
      where,
      // From config, not the module default: `ctxBudgetChars` was a setting that
      // read back as itself and changed nothing, because nobody ever passed it here.
      budget: b.limit ?? ctx.config.ctxBudgetChars ?? CTX_BUDGET_CHARS,
    }),
  );
};

export const CTX_BUDGET_CHARS = DEFAULT_BUDGET;
