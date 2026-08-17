import type { DB } from "../../platform/persistence/database.ts";
import { loadMap, mapFor } from "./repomap.ts";
import {
  ESCALATION_TERMINAL_STATES,
  stateParam,
  type EscalationState,
  type GrpState,
  type LeaseState,
  type SliceState,
} from "../../contracts/states.ts";

/**
 * Retrieval for `orch ctx query`.
 *
 * No embeddings, deliberately: this has to answer in milliseconds inside a turn,
 * and the corpus is one project's notes, not a library. What it does instead is
 * the part naive keyword scoring gets wrong — rare words count for more than
 * common ones, and a long note stops winning merely by containing many words.
 *
 * The hard budget matters more than the ranking. An unbounded answer costs more
 * than the file the agent was about to read, which defeats the point.
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

/**
 * Words worth scoring, in whatever language the writing is in.
 *
 * This was two regexes: one for Latin tokens and one that split Han, Hiragana
 * and Katakana **per character**. Measured against eight scripts, it returned
 * zero terms for Korean, Russian, Thai, Arabic and Greek — the corpus was
 * simply invisible to search in those languages, silently — and it turned
 * サンドボックス into twelve single characters. That is a defect for a project
 * about to be read and written by people who do not all type Latin.
 *
 * `Intl.Segmenter` is ICU's word breaker, built into the runtime, and it
 * segments every one of those. No locale is passed on purpose: the corpus mixes
 * languages inside a single note, and ICU's default breaking handles the mix
 * better than any one locale tag would.
 *
 * `isWordLike` drops the spaces and punctuation between segments. A one-letter
 * Latin token carries no signal and is dropped as before; a one-character Han
 * token is often a whole word and is kept, which is why the length rule looks
 * at the script rather than at the count alone.
 */
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "word" });
const SINGLE_LETTER = /^[\p{Script=Latin}\p{N}_]$/u;

export function terms(text: string): string[] {
  const out: string[] = [];
  for (const { segment, isWordLike } of SEGMENTER.segment(text.toLowerCase())) {
    if (!isWordLike) continue;
    if (SINGLE_LETTER.test(segment)) continue;
    if (STOP.has(segment)) continue;
    out.push(segment);
  }
  return out;
}

const STOP = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "is",
  "it",
  "for",
  "on",
  "with",
  "this",
  "that",
  "was",
  "we",
  "i",
  "be",
  "as",
  "at",
  "by",
  "from",
  "how",
  "what",
  "which",
  "should",
  "would",
  "can",
  "do",
  "does",
  "not",
  "but",
  "if",
  "then",
  // Common verbs carry no information about which note is relevant, and keeping
  // them while dropping "should" would be an inconsistent list.
  "use",
  "used",
  "using",
  "need",
  "needs",
  "make",
  "makes",
  "get",
  "gets",
  "set",
  "sets",
  "have",
  "has",
  "are",
  "were",
  "will",
  "just",
  "also",
  "when",
  "where",
  "why",
  "who",
  "there",
  "their",
  "its",
  "our",
  "you",
  "your",
]);

const KIND_WEIGHT: Record<string, number> = {
  decision: 1.6, // what was settled, and why — the highest-value thing to recall
  lesson: 1.5,
  retro: 1.3,
  onboarding: 1.3,
  risk: 1.2,
  fact: 1.1,
  handoff: 1.0,
  journal: 1.0,
};
const BM25 = { k1: 1.4, b: 0.7 };

/** BM25-style rare-term scoring with saturation and length normalisation. */
export function rank(docs: Doc[], query: string, now = Date.now()): Hit[] {
  const q = [...new Set(terms(query))];
  if (q.length === 0 || docs.length === 0) return [];
  const tokenised = docs.map((d) => terms(d.body));
  const avgLen = tokenised.reduce((n, t) => n + t.length, 0) / docs.length || 1;
  const df = termCounts(tokenised.flatMap((tokens) => [...new Set(tokens)]));
  const hits: Hit[] = [];
  for (const [i, doc] of docs.entries()) {
    const score = docScore(doc, tokenised[i]!, q, df, docs.length, avgLen, now);
    if (!score) continue;
    hits.push({ doc, score });
  }
  return hits.sort((a, b) => b.score - a.score);
}

function termCounts(values: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function docScore(
  doc: Doc,
  tokens: string[],
  query: string[],
  documentFrequency: Map<string, number>,
  documentCount: number,
  averageLength: number,
  now: number,
): number {
  const frequency = termCounts(tokens);
  let score = 0;
  for (const term of query) {
    const count = frequency.get(term);
    if (!count) continue;
    const documents = documentFrequency.get(term) ?? 0;
    const idf = Math.log(1 + (documentCount - documents + 0.5) / (documents + 0.5));
    score +=
      idf * ((count * (BM25.k1 + 1)) / (count + BM25.k1 * (1 - BM25.b + (BM25.b * tokens.length) / averageLength)));
  }
  if (!score) return 0;
  const days = Math.max(0, (now - doc.at) / 86_400_000);
  return score * (KIND_WEIGHT[doc.kind] ?? 1) * (1 + 0.25 / (1 + days));
}

export interface QueryOptions {
  db: DB;
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
  const hits = rank(queryDocs(opts), opts.question, now);
  const shown = appendHits(output, hits);
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

function queryDocs(opts: QueryOptions): Doc[] {
  return opts.db
    .query<Doc, [number | null, number | null]>(
      `SELECT id, kind, body, export_path AS exportPath, at, slice_id AS sliceId FROM note
       WHERE kind NOT IN ('pageindex', 'map')
         AND (grp_id IS ? OR project_id IS ? OR (grp_id IS NULL AND project_id IS NULL))
       ORDER BY at DESC LIMIT 400`,
    )
    .all(opts.grpId, opts.projectId);
}

function appendHits(output: { push: (text: string) => boolean }, hits: Hit[]): number {
  let shown = 0;
  for (const hit of hits) {
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
