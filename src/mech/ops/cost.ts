import { and, count, desc, eq, gt, sql, sum } from "drizzle-orm";
import type { DB } from "../../platform/persistence/database.ts";
import { agent, event, grp, slice } from "../../platform/persistence/schema.ts";
import type { CostReport } from "../../contracts/cost.ts";
import { valueOr } from "../../contracts/json.ts";
import { z } from "zod";

/**
 * Where the tokens went.
 *
 * Tokens, not dollars, and every ordering here says so. On a subscription the
 * dollar figure is notional — claude's CLI reports what the turn would have cost at
 * API rates, codex reports nothing — and neither is what the month costs. So
 * ranking by `usd` put every codex role at the bottom with a $0 that reads as free
 * work.
 */
/**
 * Four dimensions, each answering a question the boss actually has: which
 * requirement was expensive, which role is expensive, whether the difficulty tags
 * are honest, and — since the work runs across two accounts — which account is
 * being spent.
 */

/**
 * `sum()` over a `bigint` column is `numeric`, which the driver hands back as a
 * string — measured, not assumed: 5000000007 arrives as `"5000000007"`. Converted
 * here rather than cast in SQL, because a cast means a raw `sql` template at every
 * aggregate and `Number` is exact far past any token count.
 */
const tokens = (value: string | null): number => Number(value ?? 0);

/**
 * What one turn reported, as the event carries it.
 *
 * `meta_json` is `jsonb` and comes back parsed, so the four usage counters and the
 * account are read here instead of in four `json_extract` calls. Everything is
 * optional: `tool_summary` is also emitted for tool narration, with no meta at all.
 */
const TurnMetaSchema = z.object({
  usage: z
    .object({
      input: z.number().optional(),
      output: z.number().optional(),
      cacheRead: z.number().optional(),
      cacheCreate: z.number().optional(),
    })
    .optional(),
  cacheRatio: z.number().optional(),
  /** Wall clock of the provider call. */
  ms: z.number().optional(),
  /** What the provider's own stream weighed, and how much of it was tool output. */
  transcript: z.object({ bytes: z.number().optional(), toolBytes: z.number().optional() }).optional(),
  model: z.string().optional(),
  runtime: z.string().optional(),
  rotate: z.string().optional(),
});

/**
 * Which account paid, from the turn event.
 *
 * Recorded on the event since this change; rows written before it fall back to
 * the model name, which is what the whole split used to be. A prefix match is
 * right until someone renames a model, and it was silently deciding a column.
 */
const runtimeOf = (meta: z.infer<typeof TurnMetaSchema>): string =>
  meta.runtime ?? (meta.model?.startsWith("gpt") === true ? "codex" : "claude");

/** The four counters a turn reports, summed. */
const turnTokens = (meta: z.infer<typeof TurnMetaSchema>): number => {
  const u = meta.usage;
  if (!u) return 0;
  return (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheCreate ?? 0);
};

/** `MM-DD HH`, in the orchestrator's own timezone — which is what the boss reads. */
/** The top of the hour `at` falls in, in the boss's local time — the same
 *  bucketing `hourLabel` does, as an instant the panel can format. */
const hourStart = (at: number): number => new Date(at).setMinutes(0, 0, 0);

const hourLabel = (at: number): string => {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}`;
};

/** How many requirements the ranking offers. Was a literal inside the query. */
const GROUP_LIMIT = 50;

export async function costReport(db: DB, projectId?: number): Promise<CostReport> {
  // The filter is a condition rather than `(?1 IS NULL OR project_id = ?1)`, which
  // is how SQL says "optional" when it has no way to leave a clause out.
  const inProject = <T extends typeof grp.project_id | typeof agent.project_id>(column: T) =>
    projectId === undefined ? undefined : eq(column, projectId);

  const byGroup = await db
    .select({ grpId: grp.id, label: grp.name, tokens: grp.spent_tokens })
    .from(grp)
    .where(inProject(grp.project_id))
    .orderBy(desc(grp.spent_tokens))
    .limit(GROUP_LIMIT);

  const agents = await db
    .select({
      id: agent.id,
      grpId: agent.grp_id,
      role: agent.role,
      label: agent.role,
      model: agent.model,
      runtime: agent.runtime,
      tokens: agent.total_tokens,
    })
    .from(agent)
    .where(inProject(agent.project_id))
    .orderBy(desc(agent.total_tokens));

  const byRole = (
    await db
      .select({ label: agent.role, tokens: sum(agent.total_tokens) })
      .from(agent)
      .where(inProject(agent.project_id))
      .groupBy(agent.role)
      .orderBy(desc(sum(agent.total_tokens)))
  ).map((r) => ({ label: r.label, tokens: tokens(r.tokens) }));

  // The project filter was missing here, so one project's cost panel showed every
  // project's difficulty mix — and the difficulty tag is the cost knob the whole
  // panel exists to inform.
  const byDifficulty = (
    await db
      .select({ label: slice.difficulty, tokens: sum(slice.spent_tokens) })
      .from(slice)
      .innerJoin(grp, eq(grp.id, slice.grp_id))
      .where(inProject(grp.project_id))
      .groupBy(slice.difficulty)
      .orderBy(desc(sum(slice.spent_tokens)))
  ).map((r) => ({ label: r.label, tokens: tokens(r.tokens) }));

  const byRuntime = (
    await db
      .select({ label: agent.runtime, tokens: sum(agent.total_tokens) })
      .from(agent)
      .where(inProject(agent.project_id))
      .groupBy(agent.runtime)
      .orderBy(desc(sum(agent.total_tokens)))
  ).map((r) => ({ label: r.label, tokens: tokens(r.tokens) }));

  const [totalRow] = await db
    .select({ tokens: sum(grp.spent_tokens) })
    .from(grp)
    .where(inProject(grp.project_id));
  const total = { label: "total", tokens: tokens(totalRow?.tokens ?? null) };

  // What a finished requirement costs is the number to compare against doing it by
  // hand — docs/project/plan.md §13 risk ② turns on exactly this ratio.
  const [deliveredRow] = await db
    .select({ count: count(), tokens: sum(grp.spent_tokens) })
    .from(grp)
    .where(and(eq(grp.status, "DISSOLVED"), inProject(grp.project_id)));
  const delivered = { count: deliveredRow?.count ?? 0, tokens: tokens(deliveredRow?.tokens ?? null) };

  return {
    delivered,
    byGroup,
    agents,
    byRole,
    byDifficulty,
    byRuntime,
    byHour: await byHour(db),
    total,
    cacheRatio: await recentCacheRatio(db),
    rotations: await recentRotations(db),
    turns: await recentTurnShape(db),
  };
}

/**
 * The last 24 hours, split by account.
 *
 * From the turn events rather than a new table: the executor already emits one per
 * turn with the usage and the account, and the event row has no agent to join back
 * to. Bucketed here rather than in SQL because the hour label is the *boss's* local
 * hour, and a database in a UTC container would silently relabel every bar.
 */
async function byHour(db: DB): Promise<CostReport["byHour"]> {
  const rows = await db
    .select({ at: event.at, meta_json: event.meta_json })
    .from(event)
    .where(
      and(
        eq(event.kind, "tool_summary"),
        sql`jsonb_exists(${event.meta_json}, 'usage')`,
        gt(event.at, Date.now() - 24 * 3600 * 1000),
      ),
    );

  const buckets = new Map<string, CostReport["byHour"][number]>();
  for (const row of rows) {
    const meta = valueOr(row.meta_json, TurnMetaSchema, {});
    const hour = hourLabel(row.at);
    const bucket = buckets.get(hour) ?? { hour, at: hourStart(row.at), claude: 0, codex: 0 };
    if (runtimeOf(meta) === "codex") bucket.codex += turnTokens(meta);
    else bucket.claude += turnTokens(meta);
    buckets.set(hour, bucket);
  }
  // On the instant, not on the label: `MM-DD` sorts December above January, and
  // a 24-hour window can cross a year.
  return [...buckets.values()].sort((a, b) => a.at - b.at);
}

/**
 * What a turn looks like lately: how long, how heavy, and how much of it was a
 * tool talking back.
 *
 * Three numbers that were each recorded somewhere and never in the same row.
 * Duration lived in a span, tokens in this report, and the size of tool output
 * nowhere at all — so "tool results are 90% of a transcript", the largest claim
 * anyone here has made about what a turn costs, could be neither confirmed nor
 * contradicted after the day it was measured.
 */
/** Medians, not means: one turn that read a 4 MB file is exactly the turn a mean
 *  would let define the picture, and it is also the turn worth finding. */
async function recentTurnShape(db: DB, limit = 50): Promise<CostReport["turns"]> {
  const metas = await recentTurns(db, limit);
  const ms = metas.flatMap((m) => (m.ms === undefined ? [] : [m.ms]));
  const bytes = metas.flatMap((m) => (m.transcript?.bytes ? [m.transcript.bytes] : []));
  const toolShare = metas.flatMap((m) =>
    m.transcript?.bytes ? [(m.transcript.toolBytes ?? 0) / m.transcript.bytes] : [],
  );
  return {
    counted: metas.length,
    medianMs: median(ms),
    medianBytes: median(bytes),
    medianToolShare: median(toolShare),
  };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * The recent turns that reported a cache ratio, newest first.
 *
 * `jsonb_exists` rather than the old `LIKE '%cacheRatio%'`: the column is `jsonb`
 * now, so there is no text to match against, and a key test is what the LIKE was
 * always approximating. Drizzle has no helper for the `?` operator, and spelling it
 * as the function avoids the placeholder ambiguity the operator would carry.
 */
async function recentTurns(db: DB, limit: number): Promise<z.infer<typeof TurnMetaSchema>[]> {
  const rows = await db
    .select({ meta_json: event.meta_json })
    .from(event)
    // `usage`, which is what `byHour` two functions up already asks: one predicate
    // for "this row is a turn" rather than two. `cacheRatio` was the older one and
    // it excluded exactly the rows a turn written before it was recorded — and now
    // also the rows this samples for duration and weight, which a provider can
    // report without a cache figure at all.
    .where(and(eq(event.kind, "tool_summary"), sql`jsonb_exists(${event.meta_json}, 'usage')`))
    .orderBy(desc(event.seq))
    .limit(limit);
  return rows.map((r) => valueOr(r.meta_json, TurnMetaSchema, {}));
}

/**
 * Averaged over recent turns. A sudden drop means someone broke the prompt
 * assembly — which is invisible in every other way: the agents still work, the
 * tests still pass, and each turn quietly costs several times more.
 */
export async function recentCacheRatio(db: DB, limit = 50): Promise<number | null> {
  const vals: number[] = [];
  for (const meta of await recentTurns(db, limit)) if (meta.cacheRatio !== undefined) vals.push(meta.cacheRatio);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/**
 * How many of the recent turns started a session instead of resuming one, and which
 * trigger did it.
 *
 * A separate number from the ratio above because a low cache ratio can mean the
 * prompt assembly broke or that nobody is resuming anything, and those have
 * different fixes. Measured on this repo before it existed: 10 of 13 claude jobs
 * opened cold, roughly 17k of prefix rebuilt each time, with no way to tell whether
 * the cause was a moving prefix, the rotation ceiling, or send-backs.
 */
async function recentRotations(db: DB, limit = 50): Promise<{ turns: number; byReason: Record<string, number> }> {
  const metas = await recentTurns(db, limit);
  const byReason: Record<string, number> = {};
  for (const meta of metas) if (meta.rotate) byReason[meta.rotate] = (byReason[meta.rotate] ?? 0) + 1;
  return { turns: metas.length, byReason };
}
