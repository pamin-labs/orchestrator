import type { DB } from "../../platform/persistence/database.ts";
import { loadMap, mapFor } from "./repomap.ts";
import type { NoteIndex } from "./note-index.ts";
import {
  ESCALATION_TERMINAL_STATES,
  stateParam,
  type EscalationState,
  type GrpState,
  type LeaseState,
  type SliceState,
} from "../../contracts/states.ts";

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
   * pure, synchronous half — the half every test can run without a model.
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

export const DEFAULT_BUDGET = 16_000;

/** Answer a query, always prefixing the group's acceptance context when present. */
export function query(opts: QueryOptions): string {
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const now = opts.now?.() ?? Date.now();
  const output = budgetOutput(budget);
  if (opts.grpId) {
    const slices = sliceContext(opts.db, opts.grpId);
    const state = groupContext(opts.db, opts.grpId);
    if (slices) output.push(slices);
    if (state) output.push(state);
  }
  const room = Math.floor(budget / 4);
  const where = opts.where || mapFor(loadMap(opts.db, opts.projectId ?? null), opts.question, room);
  if (where) output.push(`## Where that lives\n${where.slice(0, room)}`);
  const hits = opts.index.search(opts.question, { grpId: opts.grpId, projectId: opts.projectId }, now);
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

function sliceContext(db: DB, groupId: number): string | null {
  const slices = db
    .query<{ seq: number; title: string; accept_spec: string; status: SliceState }, [number]>(
      "SELECT seq, title, accept_spec, status FROM slice WHERE grp_id = ? ORDER BY seq",
    )
    .all(groupId);
  if (!slices.length) return null;
  return (
    `## This group's slices\n` +
    slices
      .map((slice) => `S${slice.seq} [${slice.status}] ${slice.title} — accepted when: ${slice.accept_spec}`)
      .join("\n")
  );
}

function groupContext(db: DB, groupId: number): string | null {
  const group = db
    .query<{ name: string; status: GrpState; branch: string | null; pr: number | null }, [number]>(
      "SELECT name, status, branch, pr_number AS pr FROM grp WHERE id = ?",
    )
    .get(groupId);
  if (!group) return null;
  const open = db
    .query<{ id: number; chain_state: EscalationState; severity: string; question: string }, [number, string]>(
      `SELECT id, chain_state, severity, question FROM escalation
       WHERE grp_id = ? AND answer IS NULL
         AND chain_state NOT IN (SELECT value FROM json_each(?)) ORDER BY id`,
    )
    .all(groupId, stateParam(ESCALATION_TERMINAL_STATES));
  const gates = db
    .query<{ resource: string; state: LeaseState }, [number, number]>(
      `SELECT resource, state FROM lease WHERE grp_id = ? AND id IN
         (SELECT max(id) FROM lease WHERE grp_id = ? GROUP BY resource)`,
    )
    .all(groupId, groupId);
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
