import type { Ctx } from "../../mech/ctx.ts";
import type { DB } from "../../platform/persistence/database.ts";
import { say } from "../../platform/text/lang.ts";
import { terms as sharedTerms } from "./terms.ts";

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

/**
 * How much of what two complaints say has to be the same thing.
 *
 * Jaccard: shared terms over all terms either uses. Measured across the three
 * languages the boss writes in, the closest true pair scored **0.375** and the
 * furthest false one **0.222** — 「文档不清楚，缺少例子」 against 「部署脚本不清楚，缺少说明」,
 * which share a shape and not a subject. The full table is in the commit.
 */
export const SIMILARITY_FLOOR = 0.3;

/**
 * Are these the same complaint?
 *
 * This counted *shared terms*, floor two, so two sharing two common words were one
 * complaint however much else they said: 「这个接口应该返回错误码」 matched 「这个按钮应该显示提
 * 示」 on 这个 + 应该. A count cannot tell two words out of four from two out of twenty.
 * A fraction can, and that is the whole change.
 */
/**
 * Deliberately not BM25, which is installed and was the easier reach. IDF assumes
 * the query is rare in the corpus, and here the thing being looked for *is* the
 * corpus: three complaints that are all the same complaint give their shared terms
 * an IDF near zero and score 0 against each other. Measured, on the case this
 * function exists for.
 */
/**
 * No library either. Every candidate at this seam works on character n-grams —
 * `dice-coefficient`, `string-similarity-js`, `sorensen-dice` — which is the approach
 * this branch removed for being wrong on kana; or on numeric vectors
 * (`ml-distance`), which needs the vocabulary built first. `talisman` has it over
 * sequences and has not published since 2022, past the line in
 * `docs/standards/dependencies.md`.
 */
export function sameComplaint(a: string, b: string): boolean {
  const left = new Set(sharedTerms(a));
  const right = new Set(sharedTerms(b));
  if (left.size === 0 || right.size === 0) return false;
  let shared = 0;
  for (const term of left) if (right.has(term)) shared++;
  return shared / (left.size + right.size - shared) >= SIMILARITY_FLOOR;
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
