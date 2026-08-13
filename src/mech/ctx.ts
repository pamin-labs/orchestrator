import type { DB } from "../db.ts";

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

/** Words worth scoring: CJK runs are split per character, Latin by token. */
export function terms(text: string): string[] {
  const lower = text.toLowerCase();
  const latin = lower.match(/[\p{Script=Latin}\p{N}_][\p{Script=Latin}\p{N}_.-]{1,}/gu) ?? [];
  const cjk = lower.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) ?? [];
  return [...latin.filter((w) => w.length > 1 && !STOP.has(w)), ...cjk];
}

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "is", "it", "for", "on", "with",
  "this", "that", "was", "we", "i", "be", "as", "at", "by", "from", "how", "what",
  "which", "should", "would", "can", "do", "does", "not", "but", "if", "then",
  // Common verbs carry no information about which note is relevant, and keeping
  // them while dropping "should" would be an inconsistent list.
  "use", "used", "using", "need", "needs", "make", "makes", "get", "gets", "set",
  "sets", "have", "has", "are", "were", "will", "just", "also", "when", "where",
  "why", "who", "there", "their", "its", "our", "you", "your",
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

/**
 * BM25-ish scoring.
 *
 * Rare terms dominate (idf), a term repeated a hundred times does not beat a
 * document that also matches the other terms (saturation), and length is
 * normalised so a 6-line decision can outrank a 300-line journal.
 */
export function rank(docs: Doc[], query: string, now = Date.now()): Hit[] {
  const q = [...new Set(terms(query))];
  if (q.length === 0 || docs.length === 0) return [];

  const tokenised = docs.map((d) => terms(d.body));
  const avgLen = tokenised.reduce((n, t) => n + t.length, 0) / docs.length || 1;

  const df = new Map<string, number>();
  for (const toks of tokenised) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  }

  const K1 = 1.4;
  const B = 0.7;
  const hits: Hit[] = [];

  for (const [i, doc] of docs.entries()) {
    const toks = tokenised[i]!;
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);

    let score = 0;
    for (const term of q) {
      const f = tf.get(term);
      if (!f) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * toks.length) / avgLen)));
    }
    if (score === 0) continue;

    score *= KIND_WEIGHT[doc.kind] ?? 1;
    // Mild recency preference: a decision from an hour ago is likelier to be the
    // one in play than an equally-matching one from last month. Mild, because an
    // old decision is still a decision.
    const days = Math.max(0, (now - doc.at) / 86_400_000);
    score *= 1 + 0.25 / (1 + days);
    hits.push({ doc, score });
  }
  return hits.sort((a, b) => b.score - a.score);
}

export interface QueryOptions {
  db: DB;
  grpId: number | null;
  projectId: number | null;
  question: string;
  /** Hard character budget. ~4 chars per token. */
  budget?: number;
  now?: () => number;
}

export const DEFAULT_BUDGET = 16_000;

/**
 * Answer a context query.
 *
 * The group's own acceptance criteria go in first regardless of the query: they
 * are the frame for every question an agent asks inside a slice, and an agent that
 * has to search for them will instead guess.
 */
export function query(opts: QueryOptions): string {
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const now = opts.now?.() ?? Date.now();
  const parts: string[] = [];
  let used = 0;

  const push = (text: string): boolean => {
    if (used + text.length > budget) return false;
    parts.push(text);
    used += text.length;
    return true;
  };

  if (opts.grpId) {
    const slices = opts.db
      .query<{ seq: number; title: string; accept_spec: string; status: string }, [number]>(
        "SELECT seq, title, accept_spec, status FROM slice WHERE grp_id = ? ORDER BY seq",
      )
      .all(opts.grpId);
    if (slices.length) {
      push(
        `## This group's slices\n` +
          slices.map((s) => `S${s.seq} [${s.status}] ${s.title} — accepted when: ${s.accept_spec}`).join("\n"),
      );
    }

    // The state agents were fishing for with shell commands. Measured: one turn
    // spent twelve rounds on `sqlite3 data/orchestrator.sqlite`, every one denied
    // by the sandbox, and every round re-reads the whole transcript — the tail of
    // long turns is where the token bill actually is. Answering it here costs a
    // SELECT and removes the reason to go looking.
    const g = opts.db
      .query<{ name: string; status: string; branch: string | null; pr: number | null }, [number]>(
        "SELECT name, status, branch, pr_number AS pr FROM grp WHERE id = ?",
      )
      .get(opts.grpId);
    const open = opts.db
      .query<{ id: number; chain_state: string; severity: string; question: string }, [number]>(
        `SELECT id, chain_state, severity, question FROM escalation
         WHERE grp_id = ? AND answer IS NULL AND chain_state NOT IN ('answered','revoked') ORDER BY id`,
      )
      .all(opts.grpId);
    const gates = opts.db
      .query<{ resource: string; state: string }, [number, number]>(
        `SELECT resource, state FROM lease WHERE grp_id = ? AND id IN
           (SELECT max(id) FROM lease WHERE grp_id = ? GROUP BY resource)`,
      )
      .all(opts.grpId, opts.grpId);
    if (g) {
      push(
        `## This group right now\n` +
          `status ${g.status}${g.branch ? ` on ${g.branch}` : ""}${g.pr ? ` — PR #${g.pr}` : " — no PR yet"}\n` +
          (gates.length ? `last gate per resource: ${gates.map((x) => `${x.resource}=${x.state}`).join(", ")}\n` : "") +
          (open.length
            ? `open questions: ${open.map((e) => `#${e.id} [${e.severity}, with ${e.chain_state}] ${e.question.slice(0, 80)}`).join(" | ")}`
            : "open questions: none"),
      );
    }
  }

  const docs = opts.db
    .query<Doc, [number | null, number | null]>(
      `SELECT id, kind, body, export_path AS exportPath, at, slice_id AS sliceId FROM note
       WHERE grp_id IS ? OR project_id IS ? OR (grp_id IS NULL AND project_id IS NULL)
       ORDER BY at DESC LIMIT 400`,
    )
    .all(opts.grpId, opts.projectId);

  const hits = rank(docs, opts.question, now);
  let shown = 0;
  for (const h of hits) {
    const where = h.doc.exportPath ? ` (${h.doc.exportPath})` : "";
    if (!push(`## ${h.doc.kind}${where}\n${h.doc.body}`)) break;
    shown++;
  }

  // On `shown`, not on `parts`: the group's own state is always there now, and
  // returning it silently would read as "that is the answer to your question".
  if (shown === 0) {
    const state = parts.length ? `${parts.join("\n\n")}\n\n` : "";
    return (
      `${state}nothing on the blackboard matches that. Try different words, read the code, ` +
      "or ask the PM with `orch mail pm --intent ask`."
    );
  }
  // Say what was dropped: silent truncation reads as "that is everything there
  // is", which is worse than a smaller answer that admits its own limit.
  const trailer =
    shown < hits.length ? `\n\n(${hits.length - shown} more matches omitted to stay in budget)` : "";
  return parts.join("\n\n") + trailer;
}
