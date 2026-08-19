import { z } from "zod";
import type { Ctx } from "../../mech/ctx.ts";
import type { Caller } from "../../http/agent-auth.ts";
import type { AgentHandler } from "../../http/handler.ts";
import { message } from "../../http/respond.ts";
import { query as ctxQuery } from "../../mech/knowledge/ctx.ts";
import { makeNoteIndex } from "../../mech/knowledge/note-index.ts";
import { loadTree, NOTE_PREFIX, render, search } from "../../mech/knowledge/pageindex.ts";
import { projectOfAgent } from "../../mech/util/rows.ts";
import { Id } from "../../contracts/fields.ts";
import { SpanStatusCode } from "@opentelemetry/api";
import { activeTracer } from "../../platform/observability/traces.ts";
import { scopeAttributes } from "../../platform/observability/metrics.ts";

/** The tree render, plus the notes it quoted — which must not be quoted twice. */
async function pageIndexContext(
  ctx: Ctx,
  caller: Caller,
  projectId: number | null,
  question: string,
): Promise<{ where: string; notes: number[] }> {
  const none = { where: "", notes: [] };
  const tree = loadTree(ctx.db, projectId);
  // Bound before the closure: narrowing a property does not survive into a
  // callback, and the honest fix is the local, not an assertion that tells the
  // compiler to stop checking a field the composition layer leaves unset in tests.
  const askIn = ctx.askIn;
  if (!tree || !askIn || !projectId) return none;

  // Its own span, inside `ctx.query`: this half makes up to three serial model
  // calls and the other half makes none, so one number over both cannot say
  // which paid for what. Opened after the guards, because a project with no tree
  // does none of this and a span there would report work that never happened.
  return activeTracer().startActiveSpan("ctx.pageindex", async (span) => {
    try {
      const scope = caller.grp_id ? { grp: caller.grp_id } : { project: projectId };
      const hits = await search(tree, question, askIn(scope), ctx.config.pageindex);
      if (hits.length === 0) return none;

      let answer = render(tree, hits);
      const noteIds = hits.filter((hit) => hit.startsWith(NOTE_PREFIX)).map((hit) => Number(hit.split("/").pop()));
      const quoted: number[] = [];
      for (const id of noteIds) {
        const note = ctx.db
          .query<{ kind: string; body: string }, [number]>("SELECT kind, body FROM note WHERE id = ?")
          .get(id);
        if (!note) continue;
        answer += `\n\n### ${note.kind} #${id}\n${note.body.slice(0, 1200)}`;
        quoted.push(id);
      }
      return { where: answer, notes: quoted };
    } catch {
      // The catch predates the span and is the reason it is worth having: a failed
      // walk is indistinguishable from a tree with no hits, and both fall through
      // to the lexical half without a word. `index.ask` already reports its own
      // exit code; this reports that the walk as a whole came back empty-handed.
      span.setStatus({ code: SpanStatusCode.ERROR, message: "pageindex walk threw" });
      return none;
    } finally {
      span.end();
    }
  });
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

export const postCtxQuery = (async (ctx, _req, a, _p, b) =>
  // The one command every role is told to run first, and until now the only
  // waiting path in the system with no span: its whole justification is that it
  // is cheaper than the grep rounds it replaces, and that was the one claim
  // nothing here could measure. At the handler, not inside the two halves, so a
  // later caller cannot arrive uninstrumented.
  activeTracer().startActiveSpan(
    "ctx.query",
    { attributes: scopeAttributes({ grpId: a.grp_id, projectId: a.project_id }) },
    async (span) => {
      try {
        return await answerCtxQuery(ctx, a, b);
      } finally {
        span.end();
      }
    },
  )) satisfies AgentHandler<z.infer<typeof CtxQueryBody>>;

async function answerCtxQuery(ctx: Ctx, a: Caller, b: z.infer<typeof CtxQueryBody>): Promise<Response> {
  const projectId = projectOfAgent(ctx.db, a.id);
  // PageIndex: a model walks the summary tree and can land on a file whose name
  // shares no word with the question. It costs one cheap call, against grep rounds
  // that each re-read the agent's whole transcript. No tree yet, or a navigator
  // that fails, falls through to the lexical map inside ctxQuery.
  // In the caller's own sandbox, not the project's. The walk reads summaries
  // already in the database; the shared index build remains project-scoped.
  const picked = await pageIndexContext(ctx, a, projectId, b.question);
  return message(
    ctxQuery({
      db: ctx.db,
      index: ctx.notes ?? makeNoteIndex(ctx.db),
      grpId: a.grp_id,
      projectId,
      question: b.question,
      where: picked.where,
      whereNotes: picked.notes,
      // From config, not the module default: `ctxBudgetChars` was a setting that
      // read back as itself and changed nothing, because nobody ever passed it here.
      budget: b.limit ?? ctx.config.ctxBudgetChars,
    }),
  );
}
