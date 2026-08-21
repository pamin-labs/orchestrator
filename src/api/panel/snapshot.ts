import { UsageWindow, type Snapshot } from "../../contracts/panel.ts";
import { valueOr } from "../../contracts/json.ts";
import { costReport } from "../../mech/ops/cost.ts";
import { canStart } from "../../mech/flow/ownership.ts";
import { poolSizes } from "../../platform/scheduling/scheduler.ts";
import { head, position } from "../../mech/flow/mergequeue.ts";
import type { Handler } from "../../http/handler.ts";
import { json } from "../../http/respond.ts";
import type { Ctx } from "../../mech/ctx.ts";
import { ESCALATION_TERMINAL_STATES } from "../../contracts/states.ts";
import { z } from "zod";
import { and, asc, count, desc, eq, gte, inArray, isNotNull, max, ne, notInArray, sql } from "drizzle-orm";
import {
  maxMs,
  agent,
  channel,
  escalation,
  event,
  grp,
  job,
  note,
  project,
  runtime_auth,
  slice,
  task,
  usage_snapshot,
} from "../../platform/persistence/schema.ts";

/**
 * Everything the panel draws, in one payload.
 *
 * A read model, not a route: fifteen queries and no `Request` anywhere except
 * in the two one-line handlers at the bottom. It lives apart from the verbs
 * because it is the one thing here that only reads — nothing in this file can
 * change the fleet, which is worth being able to see at a glance.
 */

export const getState = (async (ctx) => json(await snapshot(ctx))) satisfies Handler;

export const CostQuery = z.object({ project: z.coerce.number().int().positive().optional() });

export const getCost = (async (ctx, _req, _params, query) =>
  json(await costReport(ctx.db, query.project))) satisfies Handler<z.infer<typeof CostQuery>>;

/** The card a group filed, and the drop proposal it may have filed instead. */
const DRAFT_CARD = sql`'{"draft_card": true}'::jsonb`;
const DROP_PROPOSAL = sql`'{"drop_proposal": 1}'::jsonb`;

/**
 * The newest note per group, whichever kind. `DISTINCT ON` and not `GROUP BY`:
 * the statement this replaces selected `body` beside a `max(at)` and leaned on
 * SQLite's bare-column rule to pick the row the aggregate came from. Postgres
 * refuses that outright, and `DISTINCT ON (grp_id) … ORDER BY grp_id, at DESC`
 * is the same intent said in a way both would accept.
 */
const newestPerGroup = [note.grp_id, desc(note.at), desc(note.id)];

export async function snapshot(ctx: Ctx): Promise<Snapshot> {
  const db = ctx.db;
  const [
    credentials,
    projects,
    awaitingBoundary,
    groups,
    dropProposals,
    slices,
    agents,
    tasks,
    channels,
    draftCards,
    lateObjections,
    ideas,
    answerable,
    escalations,
    registered,
    archived,
    usage,
    newest,
  ] = await Promise.all([
    /**
     * Is there a credential at all?
     *
     * The scheduler refuses to dispatch a turn without one, so a fleet in this
     * state is stopped and every view would look idle rather than blocked. One
     * boolean, so the header can carry the mark instead of the boss discovering
     * it in a queue that never moves.
     */
    /**
     * The deeper checks — docker, the sandbox server, the sidecar version — cost
     * host round trips, so *running* them stays on the readiness timer. Reading
     * their result costs nothing, which is why `failing` rides along here.
     */
    db.select({ n: count() }).from(runtime_auth),
    // `base_branch` rides along because it is the one thing add-a-project decided
    // on the boss's behalf, and a decision taken silently has to be visible where
    // its consequence starts — the new project's own page.
    db
      .select({
        id: project.id,
        name: project.name,
        repo_path: project.repo_path,
        remote: project.remote,
        base_branch: project.base_branch,
      })
      .from(project),
    // Why an approved group has not started. The boss pressed the button; showing
    // the same button again reads as "the click did nothing".
    db
      .select({ id: grp.id })
      .from(grp)
      .where(and(eq(grp.status, "DRAFT"), isNotNull(grp.approved_at))),
    db
      .select({
        id: grp.id,
        project_id: grp.project_id,
        name: grp.name,
        branch: grp.branch,
        status: grp.status,
        owns_json: grp.owns_json,
        budget_tokens: grp.budget_tokens,
        spent_tokens: grp.spent_tokens,
        pr_number: grp.pr_number,
        approved_at: grp.approved_at,
      })
      .from(grp)
      .where(ne(grp.status, "DISSOLVED")),
    // A planner found this requirement is already covered. The evidence was checked
    // before the row could exist; the boss decides whether it leaves the board.
    db
      // `grp.id`, not `note.grp_id`: the inner join makes them the same value, and
      // this one is NOT NULL — which is what the panel contract says `grpId` is.
      .selectDistinctOn([note.grp_id], { grpId: grp.id, body: note.body })
      .from(note)
      .innerJoin(grp, eq(grp.id, note.grp_id))
      // Raw on the right: jsonb containment has no Drizzle operator.
      .where(and(ne(grp.status, "DISSOLVED"), sql`${note.frontmatter_json} @> ${DROP_PROPOSAL}`))
      .orderBy(...newestPerGroup),
    db
      .select({
        id: slice.id,
        grp_id: slice.grp_id,
        seq: slice.seq,
        title: slice.title,
        accept_spec: slice.accept_spec,
        difficulty: slice.difficulty,
        status: slice.status,
        gates_json: slice.gates_json,
        spent_tokens: slice.spent_tokens,
        awaiting_at: slice.awaiting_at,
      })
      .from(slice)
      .orderBy(slice.grp_id, slice.seq),
    // docs/project/plan.md §8 asks the desk wall for the current slice, the turn count and the
    // live last line. Two of the three are here; the third is the SSE stream,
    // which the client already holds. Turn count is what tells a stuck agent from
    // a busy one — "in_progress" looks identical either way.
    // The two subqueries are correlated on `agent.id` and both must stay inside
    // this one statement — a per-agent lookup is the N+1 this read model exists to
    // avoid. `sql` supplies the parentheses a scalar operand needs; the builders
    // inside supply every table and column name.
    db
      .select({
        id: agent.id,
        grp_id: agent.grp_id,
        role: agent.role,
        model: agent.model,
        state: agent.state,
        activity: agent.activity,
        session_tokens: agent.session_tokens,
        total_tokens: agent.total_tokens,
        turns: agentTurns(db),
        slice_id: agentSlice(db),
      })
      .from(agent)
      .where(ne(agent.state, "retired")),
    db
      .select({ id: task.id, grp_id: task.grp_id, slice_id: task.slice_id, title: task.title, status: task.status })
      .from(task),
    db
      .select({
        id: channel.id,
        project_id: channel.project_id,
        grp_id: channel.grp_id,
        kind: channel.kind,
        status: channel.status,
      })
      .from(channel),
    // The card each DRAFT group filed. Without this the boss is shown an empty
    // box and asked to approve something they cannot see.
    db
      .selectDistinctOn([note.grp_id], {
        // Same as `dropProposals`: the non-null side of the join.
        grpId: grp.id,
        body: note.body,
        at: note.at,
        // Raw: `->>` renders the value as text, which is what this field has
        // always carried — the paths arrive as one JSON array in a string.
        unknownPaths: sql<string | null>`${note.frontmatter_json}->>'unknownPaths'`,
      })
      .from(note)
      .innerJoin(grp, eq(grp.id, note.grp_id))
      .where(and(eq(grp.status, "DRAFT"), sql`${note.frontmatter_json} @> ${DRAFT_CARD}`))
      .orderBy(...newestPerGroup),
    // An objection that arrived after the card was filed.
    //
    // The comparison is >= rather than >, and that is a fix rather than a
    // detail: a millisecond is not an ordering key, so a card and an objection
    // can share one, and a strict > then drops the objection entirely. That is
    // precisely the failure this clause exists to prevent — approving a card
    // that still reads 反对：无 while somebody has already said otherwise. The
    // boundary has to fall on the side that shows it. Nothing else can land
    // here: a card is a note, not an event, and the only say events considered
    // are other agents'. The Dispatcher does not
    // wait for the Architect — a card nobody filed is worth less than a card with
    // no objection on it — so a real objection can land a minute later, while the
    // card still reads 反对 : 无. Approving that is approving something the boss
    // was never shown. Measured: the late objection was "the locale-inference
    // slice contradicts the acceptance criterion that says behaviour is unchanged".
    db
      .select({ grpId: grp.id, author: event.author, body: event.body })
      .from(event)
      .innerJoin(grp, eq(grp.id, event.grp_id))
      .where(
        and(
          eq(grp.status, "DRAFT"),
          eq(event.kind, "say"),
          ne(event.author, "dispatcher"),
          // Inclusive on purpose; see the comment above this query. The right
          // side is a subquery correlated on the event's own group, which is why
          // it is `sql` — the parentheses are what a scalar operand needs.
          gte(event.at, cardFiledAt(db)),
        ),
      )
      .orderBy(event.seq),
    // What the boss originally said, verbatim. Those 20 seconds on the card are
    // the only guard against a plan that is well-formed but aimed at the wrong
    // thing, and that comparison is impossible without the original next to it.
    // `grp.id` again: `event.grp_id` is nullable and the contract's `grpId` is
    // not, and the join is what makes that true.
    db
      .selectDistinctOn([event.grp_id], { grpId: grp.id, body: event.body })
      .from(event)
      .innerJoin(grp, eq(grp.id, event.grp_id))
      .where(eq(event.kind, "boss_say"))
      .orderBy(event.grp_id, asc(event.seq)),
    // Recently answered by a stand-in, so the boss can take one back. Without a
    // visible undo, delegated answers are a bet nobody would take.
    db
      .select({
        id: escalation.id,
        grp_id: escalation.grp_id,
        question: escalation.question,
        answer: escalation.answer,
        answered_by: escalation.answered_by,
        ref_note_id: escalation.ref_note_id,
      })
      .from(escalation)
      .where(
        and(
          eq(escalation.chain_state, "answered"),
          isNotNull(escalation.answered_by),
          ne(escalation.answered_by, "boss"),
        ),
      )
      // `nulls last` spelled out: `answered_at` is nullable, and Postgres puts
      // NULL *first* under DESC — an answer nobody stamped would head the list
      // the boss reads as "most recent".
      .orderBy(sql`${escalation.answered_at} desc nulls last`, desc(escalation.id))
      .limit(10),
    db
      .select({
        id: escalation.id,
        grp_id: escalation.grp_id,
        severity: escalation.severity,
        question: escalation.question,
        brief: escalation.brief,
        kind: escalation.kind,
        chain_state: escalation.chain_state,
        answered_by: escalation.answered_by,
        answer: escalation.answer,
        created_at: escalation.created_at,
        asker: agent.role,
        asker_project: agent.project_id,
      })
      .from(escalation)
      .leftJoin(agent, eq(agent.id, escalation.agent_id))
      .where(notInArray(escalation.chain_state, [...ESCALATION_TERMINAL_STATES]))
      .orderBy(escalation.created_at, escalation.id),
    db.select({ id: project.id }).from(project),
    // Delivered work, so 收尾 stops meaning "vanished". A group that merged is the
    // only proof the system did what it was asked, and it was leaving no trace
    // anywhere in the panel. Two correlated scalars again, and the second is also
    // the sort key — bound once and used in both places rather than written twice.
    db
      .select({
        id: grp.id,
        project_id: grp.project_id,
        name: grp.name,
        branch: grp.branch,
        pr_number: grp.pr_number,
        spent_tokens: grp.spent_tokens,
        slices: groupSlices(db),
        at: lastEventAt(db),
      })
      .from(grp)
      .where(eq(grp.status, "DISSOLVED"))
      // `nulls last` for the same reason as `answered`: a dissolved group with no
      // events would otherwise sort to the top of 已交付.
      .orderBy(sql`${lastEventAt(db)} desc nulls last`, desc(grp.id))
      .limit(12),
    // How much of each subscription is gone. Not spend — spend is attributable and
    // belongs in 成本. This answers "can this still run tonight", which is the one
    // usage question that changes what the boss does next.
    db
      .select({ runtime: usage_snapshot.runtime, json: usage_snapshot.json, at: usage_snapshot.at })
      .from(usage_snapshot),
    db.select({ s: max(event.seq) }).from(event),
  ]);

  // Two answers that need a row in hand before they can be asked. Both fan out
  // over a handful of ids, and both go out together rather than one at a time.
  const [approvedBlocked, mergeQueue] = await Promise.all([
    Promise.all(awaitingBoundary.map(async (g) => ({ grpId: g.id, reason: (await canStart(db, g.id)).reason ?? "" }))),
    // Only the queue head is offered for merging; the rest carry their place in
    // line so the boss can see why they are waiting.
    Promise.all(
      registered.map(async (p) => {
        const h = await head(db, p.id);
        return h ? [{ projectId: p.id, ...h, place: await position(db, h.grpId) }] : [];
      }),
    ),
  ]);

  return {
    ready: (credentials[0]?.n ?? 0) > 0,
    // Only what is wrong, and only the three strings the boss needs to act:
    // the whole set is the settings page's answer. `ok` is not among them — every
    // row here is a failure by construction. Absent in unit tests and in any
    // process with no readiness timer, which is an empty list, not an error.
    failing: (ctx.checks?.() ?? []).flatMap((c) =>
      c.ok
        ? []
        : [
            {
              name: c.name,
              detail: c.detail,
              said: c.said,
              ...(c.fix === undefined ? {} : { fix: c.fix }),
              ...(c.fixSaid === undefined ? {} : { fixSaid: c.fixSaid }),
            },
          ],
    ),
    projects,
    groups,
    approvedBlocked: approvedBlocked.filter((b) => b.reason),
    dropProposals,
    slices,
    agents,
    tasks,
    channels,
    draftCards,
    lateObjections,
    ideas,
    // `answered_by` is filtered above and the contract says it is a string, so
    // this narrows rather than asserts: the filter means nothing is dropped.
    answered: answerable.flatMap((r) => (r.answered_by === null ? [] : [{ ...r, answered_by: r.answered_by }])),
    escalations,
    mergeQueue: mergeQueue.flat(),
    archived,
    // The panel shows "并行 3/3" from this: without the cap, a queued group looks
    // stuck rather than queued, which is the difference between a bug and a setting.
    limits: {
      maxGroups: ctx.config.maxGroups,
      // Always the map shape for the panel, whatever the config wrote.
      leaseSlots: poolSizes(ctx.config.leaseSlots),
      autoAdvance: !!ctx.config.autoAdvance,
      autoAcceptTiers: ctx.config.autoAcceptTiers,
    },
    // Parsed, not spread. The blob was written by an earlier version of this
    // process, so a field it does not have is a field this one must not claim:
    // spreading the stored value told TypeScript the result was `{runtime, at}`
    // while the panel read six more properties off it.
    usage: usage.map((r): UsageWindow => {
      const parsed = UsageWindow.safeParse({
        ...valueOr(r.json, UsageWindow.partial(), {}),
        runtime: r.runtime,
        at: r.at,
      });
      return parsed.success ? parsed.data : { runtime: r.runtime, at: r.at };
    }),
    lastSeq: newest[0]?.s ?? 0,
  };
}

/** How many turns this agent has finished. Correlated on the row being selected. */
const agentTurns = (db: Ctx["db"]) =>
  sql<number>`(${db
    .select({ n: count() })
    .from(job)
    .where(
      and(eq(job.agent_id, agent.id), eq(job.kind, "agent_turn"), inArray(job.state, ["done", "failed"])),
    )})`.mapWith(Number);

/** The slice its most recent job was for, which is the slice it is on. */
const agentSlice = (db: Ctx["db"]) =>
  sql<number | null>`(${db
    .select({ slice_id: job.slice_id })
    .from(job)
    .where(and(eq(job.agent_id, agent.id), isNotNull(job.slice_id)))
    .orderBy(desc(job.id))
    .limit(1)})`;

/**
 * When this group's newest DRAFT card was filed. Correlated on the event's group.
 *
 * `max()` and not Drizzle's, on purpose: on a `bigint` column it renders
 * `max("at")::text` so the value survives the trip into JS, and the result is
 * compared against a `bigint` here rather than selected. Postgres has no
 * `bigint >= text`, so the query is a 42883 at runtime and compiles fine.
 */
const cardFiledAt = (db: Ctx["db"]) =>
  sql<number>`(${db
    .select({ at: maxMs(note.at) })
    .from(note)
    .where(and(eq(note.grp_id, event.grp_id), sql`${note.frontmatter_json} @> ${DRAFT_CARD}`))})`.mapWith(Number);

const groupSlices = (db: Ctx["db"]) =>
  sql<number>`(${db.select({ n: count() }).from(slice).where(eq(slice.grp_id, grp.id))})`.mapWith(Number);

const lastEventAt = (db: Ctx["db"]) =>
  sql<number | null>`(${db
    .select({ at: maxMs(event.at) })
    .from(event)
    .where(eq(event.grp_id, grp.id))})`.mapWith(Number);
