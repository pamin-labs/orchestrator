import { and, eq, inArray, isNull, max, notInArray } from "drizzle-orm";
import type { DB } from "../../platform/persistence/database.ts";
import { escalation, grp, lease, slice as sliceTable } from "../../platform/persistence/schema.ts";
import { activeTracer } from "../../platform/observability/traces.ts";
import { scopeAttributes } from "../../platform/observability/metrics.ts";
import { loadMap, mapFor } from "./repomap.ts";
import type { NoteIndex } from "./note-index.ts";
import { ESCALATION_TERMINAL_STATES } from "../../contracts/states.ts";
import { DEFAULTS_FOR_CHECK as DEFAULTS } from "../../platform/config/load.ts";

/**
 * Retrieval for \`orch ctx query\`.
 *
 * No embeddings, deliberately: this answers in milliseconds inside a turn, and the
 * corpus is one project's notes. What it does instead is the part naive keyword
 * scoring gets wrong — rare words count for more, and a long note stops winning
 * merely by containing many.
 *
 * The hard budget matters more than the ranking.
 */

export interface Doc {
  id: number;
  kind: string;
  body: string;
  exportPath: string | null;
  at: number;
  sliceId: number | null;
}

export interface Hit {
  doc: Doc;
  score: number;
}

export const KIND_WEIGHT: Record<string, number> = {
  decision: 1.6, // what was settled, and why — the highest-value thing to recall
  lesson: 1.5,
  retro: 1.3,
  onboarding: 1.3,
  risk: 1.2,
  fact: 1.1,
  handoff: 1.0,
  journal: 1.0,
};
export interface QueryOptions {
  db: DB;
  /**
   * The retrieval index, owned by the composition layer.
   *
   * Passed in rather than built here: building it costs hundreds of milliseconds
   * and it has to outlive the call, which makes it state — and state gets an
   * explicit owner. Tests build their own with `makeNoteIndex(db)`.
   */
  index: NoteIndex;
  grpId: number | null;
  projectId: number | null;
  question: string;
  /** Hard character budget. ~4 chars per token. */
  budget?: number;
  /**
   * Where the answer lives, already looked up. Passed in rather than looked up
   * here because PageIndex navigation is a model call, and this function is the
   * model-free half — the half every test can run without one.
   */
  where?: string;
  /**
   * Note ids `where` already spells out in full.
   *
   * PageIndex quotes the bodies of the notes the model picked; the lexical search
   * then finds the same notes again, and both copies are charged to one budget.
   */
  whereNotes?: readonly number[];
  now?: () => number;
}

/**
 * The fallback for a caller holding no config: tests, and the direct API.
 *
 * Reads the config default rather than restating it. Production passes
 * `ctxBudgetChars` from `api/orch/ctxquery.ts`, so this number only ever applies
 * where there is no `Config` to ask.
 */
export const DEFAULT_BUDGET = DEFAULTS.ctxBudgetChars;

/** Answer a query, always prefixing the group's acceptance context when present. */
export function query(opts: QueryOptions): Promise<string> {
  // No model call in here — four database reads and an in-memory Orama search.
  // It carries a span for comparison: ADR 020 measured this half at 0.32ms while
  // the other spends up to three model calls, and only a span on both puts that
  // difference in 系统耗时 rather than in a document.
  return activeTracer().startActiveSpan(
    "ctx.assemble",
    { attributes: scopeAttributes({ grpId: opts.grpId, projectId: opts.projectId }) },
    async (span) => {
      try {
        return await assemble(opts);
      } finally {
        span.end();
      }
    },
  );
}

async function assemble(opts: QueryOptions): Promise<string> {
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const now = opts.now?.() ?? Date.now();
  const output = budgetOutput(budget);
  if (opts.grpId) {
    const slices = await sliceContext(opts.db, opts.grpId);
    const state = await groupContext(opts.db, opts.grpId);
    if (slices) output.push(slices);
    if (state) output.push(state);
  }
  const room = Math.floor(budget / 4);
  const where = opts.where || mapFor(await loadMap(opts.db, opts.projectId ?? null), opts.question, room);
  if (where) output.push(`## Where that lives\n${where.slice(0, room)}`);
  const hits = await opts.index.search(opts.question, { grpId: opts.grpId, projectId: opts.projectId }, now);
  const shown = appendHits(output, hits, new Set(opts.whereNotes ?? []));
  return queryResult(output.parts, hits.length, shown);
}

function budgetOutput(budget: number): { parts: string[]; push: (text: string) => boolean } {
  const parts: string[] = [];
  let used = 0;
  return {
    parts,
    push: (text) => {
      if (used + text.length > budget) return false;
      parts.push(text);
      used += text.length;
      return true;
    },
  };
}

async function sliceContext(db: DB, groupId: number): Promise<string | null> {
  const slices = await db
    .select({
      seq: sliceTable.seq,
      title: sliceTable.title,
      accept_spec: sliceTable.accept_spec,
      status: sliceTable.status,
    })
    .from(sliceTable)
    .where(eq(sliceTable.grp_id, groupId))
    .orderBy(sliceTable.seq);
  if (!slices.length) return null;
  return (
    `## This group's slices\n` +
    slices
      .map((slice) => `S${slice.seq} [${slice.status}] ${slice.title} — accepted when: ${slice.accept_spec}`)
      .join("\n")
  );
}

async function groupContext(db: DB, groupId: number): Promise<string | null> {
  const [group] = await db
    .select({ name: grp.name, status: grp.status, branch: grp.branch, pr: grp.pr_number })
    .from(grp)
    .where(eq(grp.id, groupId));
  if (!group) return null;
  // The state subset is an array `notInArray` binds directly. It used to be JSON
  // fed through `json_each(?)`, a table-valued function with no builder — the
  // one shape SQLite had for this and Postgres does not need.
  const open = await db
    .select({
      id: escalation.id,
      chain_state: escalation.chain_state,
      severity: escalation.severity,
      question: escalation.question,
    })
    .from(escalation)
    .where(
      and(
        eq(escalation.grp_id, groupId),
        isNull(escalation.answer),
        notInArray(escalation.chain_state, [...ESCALATION_TERMINAL_STATES]),
      ),
    )
    .orderBy(escalation.id);
  // The newest lease per resource. No ORDER BY in the original and none added:
  // the caller joins these into one line and never indexed them.
  const newestPerResource = db
    .select({ id: max(lease.id) })
    .from(lease)
    .where(eq(lease.grp_id, groupId))
    .groupBy(lease.resource);
  const gates = await db
    .select({ resource: lease.resource, state: lease.state })
    .from(lease)
    .where(and(eq(lease.grp_id, groupId), inArray(lease.id, newestPerResource)));
  const branch = group.branch ? ` on ${group.branch}` : "";
  const pullRequest = group.pr ? ` — PR #${group.pr}` : " — no PR yet";
  const gateState = gates.length
    ? `last gate per resource: ${gates.map((gate) => `${gate.resource}=${gate.state}`).join(", ")}\n`
    : "";
  const questions = open.length
    ? open
        .map((item) => `#${item.id} [${item.severity}, with ${item.chain_state}] ${item.question.slice(0, 80)}`)
        .join(" | ")
    : "none";
  return `## This group right now\nstatus ${group.status}${branch}${pullRequest}\n${gateState}open questions: ${questions}`;
}

function appendHits(output: { push: (text: string) => boolean }, hits: Hit[], already: Set<number>): number {
  let shown = 0;
  for (const hit of hits) {
    if (already.has(hit.doc.id)) continue;
    const where = hit.doc.exportPath ? ` (${hit.doc.exportPath})` : "";
    if (!output.push(`## ${hit.doc.kind}${where}\n${hit.doc.body}`)) break;
    shown++;
  }
  return shown;
}

function queryResult(parts: string[], matches: number, shown: number): string {
  if (!shown) {
    const state = parts.length ? `${parts.join("\n\n")}\n\n` : "";
    return `${state}nothing on the blackboard matches that. Try different words, read the code, or ask the PM with \`orch mail pm --intent ask\`.`;
  }
  const trailer = shown < matches ? `\n\n(${matches - shown} more matches omitted to stay in budget)` : "";
  return parts.join("\n\n") + trailer;
}
