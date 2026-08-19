import type { Ctx } from "../../mech/ctx.ts";
import type { DB } from "../../platform/persistence/database.ts";
import { say } from "../../platform/text/lang.ts";

/**
 * The boss's repeated complaints become a project rule.
 *
 * Without this, dissatisfaction produces N isolated facts and never changes how the
 * agents behave: say "tests are too shallow" to three groups and the fourth writes
 * shallow tests too, because a fact attached to one group is invisible to the next.
 * A `lesson` is injected into every later group's prompt, which is the only
 * mechanism by which the twentieth group is smarter than the first.
 */
/**
 * Two stages on purpose. A deterministic prefilter decides *when* to look — the
 * same content words in three separate complaints — and only then does the CoS
 * spend a turn writing the rule. Asking a model on every complaint pays for
 * judgement that is nearly always "no"; deciding the wording with an `if` produces
 * a rule nobody can read.
 */

/** Words that carry no topic. Deliberately short: over-filtering hides the signal. */
const STOP = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "is",
  "are",
  "was",
  "be",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "this",
  "that",
  "it",
  "too",
  "so",
  "not",
  "no",
  "do",
  "does",
  "did",
  "you",
  "i",
  "we",
  "my",
  "your",
  "boss",
  "rejected",
  "sent",
  "back",
  "slice",
  "again",
  "的",
  "了",
  "是",
  "在",
  "和",
  "还",
  "太",
  "又",
  "被",
  "把",
  "给",
  "我",
  "你",
  "它",
  "这",
  "那",
  "个",
  "不",
  "没",
  "要",
  "就",
  "都",
  "很",
  "点",
  "些",
  "上",
  "下",
]);

/**
 * Content words, normalised.
 *
 * CJK has no spaces, so Latin runs are tokenised on non-letters and CJK is cut into
 * 2-character shingles — crude, and enough to notice that 「测试写得太浅」 and
 * 「测试太浅了」 are the same complaint, which is the whole job here.
 */
export function terms(text: string): Set<string> {
  const out = new Set<string>();
  const lower = (text ?? "").toLowerCase();
  for (const w of lower.split(/[^\p{L}\p{N}_]+/u)) {
    if (w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)) out.add(w);
  }
  const cjk = lower.replace(/[^\p{Script=Han}]+/gu, " ");
  for (const run of cjk.split(" ")) {
    for (let i = 0; i + 2 <= run.length; i++) {
      const pair = run.slice(i, i + 2);
      if (!STOP.has(pair) && !STOP.has(pair[0]!)) out.add(pair);
    }
  }
  return out;
}

/** Shared distinctive terms. Two is the floor: one is a coincidence. */
export const OVERLAP_FLOOR = 2;

export function sameComplaint(a: string, b: string): boolean {
  const ta = terms(a);
  const tb = terms(b);
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared >= OVERLAP_FLOOR;
}

interface FactRow {
  id: number;
  body: string;
}

/**
 * Called after the boss's words land as a fact. When the same complaint reaches the
 * threshold, hand the set to the CoS and mark them, so the next one starts a new count
 * instead of re-firing on the same three forever.
 */
export function sediment(ctx: Ctx, projectId: number | null, threshold: number): number {
  if (!projectId) return 0;
  const facts = ctx.db
    .query<FactRow, [number, number]>(
      `SELECT n.id, n.body FROM note n
       LEFT JOIN grp g ON g.id = n.grp_id
       WHERE n.kind = 'fact' AND (n.project_id = ? OR g.project_id = ?)
         AND coalesce(json_extract(n.frontmatter_json, '$.sedimented'), 0) != 1
       ORDER BY n.at DESC, n.id DESC LIMIT 40`,
    )
    .all(projectId, projectId);
  if (facts.length < threshold) return 0;

  const newest = facts[0]!;
  const kin = facts.filter((f) => f.id === newest.id || sameComplaint(newest.body, f.body));
  if (kin.length < threshold) return 0;

  const ids = kin.map((f) => f.id);
  ctx.db.run(
    `UPDATE note SET frontmatter_json = json_set(coalesce(frontmatter_json, '{}'), '$.sedimented', 1)
     WHERE id IN (${ids.map(() => "?").join(",")})`,
    ids,
  );
  ctx.bus.emit({
    author: "orchestrator",
    kind: "state_change",
    body: say(ctx.config.language, "sediment", { n: kin.length }),
    meta: { notes: ids },
  });
  // The CoS writes it, because a rule the agents must follow has to read like a rule.
  ctx.sched.enqueue("agent_turn", {
    priority: 3,
    payload: {
      role: "cos",
      sediment: kin.map((f) => f.body.slice(0, 400)),
    },
  });
  ctx.sched.tick();
  return kin.length;
}

export const LESSON_CAP = 20;

/** Newest first; id breaks same-millisecond ties consistently for reader and eviction. */
const NEWEST = "ORDER BY at DESC, id DESC";

/** What one project's agents are told: its own lessons and every global one. */
export function lessonsFor(db: DB, projectId: number | null): string[] {
  return db
    .query<{ body: string }, [number | null]>(
      `SELECT body FROM note WHERE kind = 'lesson' AND (project_id IS ? OR project_id IS NULL)
       ${NEWEST} LIMIT ${LESSON_CAP}`,
    )
    .all(projectId)
    .map((r) => r.body);
}

/** Keep the newest LESSON_CAP lessons in each project/global scope. */
export function evictOldestLessons(db: DB, projectId: number | null): number {
  const scope = "kind = 'lesson' AND (project_id IS ? OR (? IS NULL AND project_id IS NULL))";
  return db.run(
    `DELETE FROM note WHERE ${scope}
       AND id NOT IN (SELECT id FROM note WHERE ${scope} ${NEWEST} LIMIT ?)`,
    [projectId, projectId, projectId, projectId, LESSON_CAP],
  ).changes;
}
