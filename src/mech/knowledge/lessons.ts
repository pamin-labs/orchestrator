import { and, desc, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { roleFor, type Ctx } from "../../mech/ctx.ts";
import type { DB } from "../../platform/persistence/database.ts";
import { grp, note } from "../../platform/persistence/schema.ts";
import { said } from "../../platform/text/lang.ts";
import { terms } from "./terms.ts";

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
 * How alike two complaints have to be. Measured across eight languages; the table
 * and the two methods this beat are in the commit.
 *
 * The hard requirement is that *unrelated* complaints never merge — the worst
 * measured pair scores 0.170. Related-but-distinct ones may: 「构建失败」 and 「构建太慢」
 * score 0.429 and sediment together, and the CoS reads all three before writing the
 * rule. The lowest true pair is Korean at 0.310.
 */
export const SIMILARITY_FLOOR = 0.25;

/**
 * Character bigrams, taken *after* segmentation and stop words.
 *
 * Comparing tokens exactly cannot work across languages, and the reason is
 * morphology: Korean 테스트가 and 테스트는 are the same noun with different particles,
 * Russian граничных and граничные the same adjective in two cases, Arabic حالات and
 * الحالات the same noun with the article. Exact matching scores those pairs 0.100,
 * 0.250 and 0.222 — below unrelated complaints in other languages.
 */
/**
 * Bigrams of the *tokenised* text keep both halves: `terms()` still does the ICU
 * segmentation and the rented stop words, so 这个 and 应该 are gone before this sees
 * them, and what is left is compared by character overlap, which 테스트가/테스트는 share.
 *
 * A stemmer was measured and dropped: `@orama/stemmers` covers 28 languages and
 * fixed exactly one of the three, because there is no Snowball stemmer for an
 * agglutinative language and the Arabic one does not strip the article.
 */
const BIGRAM = 2;

function bigrams(text: string): Set<string> {
  // Built by iteration rather than spread: `for...of` walks code points, which is the
  // unit a bigram has to be, and a surrogate pair split down the middle is not one.
  const characters: string[] = [];
  for (const character of terms(text).join(" ")) characters.push(character);
  const out = new Set<string>();
  for (let i = 0; i + BIGRAM <= characters.length; i++) out.add(characters.slice(i, i + BIGRAM).join(""));
  return out;
}

/**
 * Are these the same complaint?
 *
 * Jaccard — shared bigrams over all bigrams either uses — because a *count* of what
 * two complaints share cannot tell two of four from two of twenty. That count, floor
 * two, is what made 「这个接口应该返回错误码」 and 「这个按钮应该显示提示」 one complaint.
 */
export function sameComplaint(a: string, b: string): boolean {
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.size === 0 || right.size === 0) return false;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared++;
  return shared / (left.size + right.size - shared) >= SIMILARITY_FLOOR;
}

/**
 * Called after the boss's words land as a fact. When the same complaint reaches the
 * threshold, hand the set to the CoS and mark them, so the next one starts a new count
 * instead of re-firing on the same three forever.
 */
export async function sediment(ctx: Ctx, projectId: number | null, threshold: number): Promise<number> {
  if (!projectId) return 0;
  const facts = await ctx.db
    .select({ id: note.id, body: note.body })
    .from(note)
    .leftJoin(grp, eq(grp.id, note.grp_id))
    .where(
      and(
        eq(note.kind, "fact"),
        // `=` and not `IS`, as it was: `projectId` is non-null past the guard above,
        // and a fact belongs to a project directly or through its group.
        or(eq(note.project_id, projectId), eq(grp.project_id, projectId)),
        // No builder for a jsonb path. `IS DISTINCT FROM` is what admits a fact
        // that has never been sedimented, whose frontmatter has no such key at
        // all — `->>` yields NULL there, and a plain `<>` against NULL is NULL,
        // which is the row silently dropped. It replaces SQLite's `coalesce`.
        sql`${note.frontmatter_json} ->> 'sedimented' IS DISTINCT FROM '1'`,
      ),
    )
    .orderBy(desc(note.at), desc(note.id))
    .limit(40);
  if (facts.length < threshold) return 0;

  const newest = facts[0]!;
  const kin = facts.filter((f) => f.id === newest.id || sameComplaint(newest.body, f.body));
  if (kin.length < threshold) return 0;

  const ids = kin.map((f) => f.id);
  await ctx.db
    .update(note)
    // `jsonb_set` has no builder either, and the placeholder list the `IN` needed
    // is now `inArray` — this was the one query here building its own SQL text.
    // No `coalesce` around the column: it is NOT NULL DEFAULT '{}'.
    .set({ frontmatter_json: sql`jsonb_set(${note.frontmatter_json}, '{sedimented}', '1'::jsonb)` })
    .where(inArray(note.id, ids));
  await ctx.bus.emit({
    author: "orchestrator",
    kind: "state_change",
    say: said("ev.sediment", { n: kin.length }),
    meta: { notes: ids },
  });
  // The CoS writes it, because a rule the agents must follow has to read like a rule.
  await ctx.sched.enqueue("agent_turn", {
    priority: 3,
    payload: {
      role: roleFor(ctx, "triage_boss_feedback"),
      sediment: kin.map((f) => f.body.slice(0, 400)),
    },
  });
  await ctx.sched.tick();
  return kin.length;
}

export const LESSON_CAP = 20;

/** Newest first; id breaks same-millisecond ties consistently for reader and eviction. */
const NEWEST = [desc(note.at), desc(note.id)] as const;

/**
 * A lesson row belongs to one project or to nobody, and the column is nullable, so
 * the reader's `project_id IS ?` matched the global rows when asked for the global
 * scope — `eq()` is `=` and would never have. Both callers below spell the null
 * case out rather than binding one through, which is the only faithful reading.
 */
const ownedBy = (projectId: number | null) =>
  projectId === null ? isNull(note.project_id) : eq(note.project_id, projectId);

/** What one project's agents are told: its own lessons and every global one. */
export async function lessonsFor(db: DB, projectId: number | null): Promise<string[]> {
  const rows = await db
    .select({ body: note.body })
    .from(note)
    .where(and(eq(note.kind, "lesson"), or(ownedBy(projectId), isNull(note.project_id))))
    .orderBy(...NEWEST)
    .limit(LESSON_CAP);
  return rows.map((r) => r.body);
}

/** Keep the newest LESSON_CAP lessons in each project/global scope. */
export async function evictOldestLessons(db: DB, projectId: number | null): Promise<number> {
  // One scope, not the reader's: eviction counts a project against its own lessons
  // only. The old text said so as `(? IS NULL AND project_id IS NULL)`, a second
  // binding of the same id that could only ever be dead when the first one matched.
  const scope = and(eq(note.kind, "lesson"), ownedBy(projectId));
  const keep = db
    .select({ id: note.id })
    .from(note)
    .where(scope)
    .orderBy(...NEWEST)
    .limit(LESSON_CAP);
  // `.returning()` and not a driver row count: the row count is this function's
  // whole return value, and it is the one form both drivers behind `DB` — the
  // deployment's `bun-sql` and a test's `pglite` — report identically.
  const gone = await db
    .delete(note)
    .where(and(scope, notInArray(note.id, keep)))
    .returning({ id: note.id });
  return gone.length;
}
