import type { Agent, Answered, Archived, Escalation, GroupNote, GroupSaid } from "../../contracts/panel.ts";
import { UsageWindow, type Snapshot } from "../../contracts/panel.ts";
import { jsonOr } from "../../contracts/json.ts";
import { costReport } from "../../mech/ops/cost.ts";
import { canStart } from "../../mech/flow/ownership.ts";
import { poolSizes } from "../../platform/scheduling/scheduler.ts";
import { head, position } from "../../mech/flow/mergequeue.ts";
import type { Handler } from "../../http/handler.ts";
import { json } from "../../http/respond.ts";
import type { Ctx } from "../../mech/ctx.ts";
import { ESCALATION_TERMINAL_STATES, stateParam } from "../../contracts/states.ts";
import { z } from "zod";
import { and, count, eq, isNotNull, max, ne, notInArray, sql } from "drizzle-orm";
import { orm } from "../../platform/persistence/orm.ts";
import {
  channel,
  event,
  grp,
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

export const getState = (async (ctx) => json(snapshot(ctx))) satisfies Handler;

export const CostQuery = z.object({ project: z.coerce.number().int().positive().optional() });

export const getCost = (async (ctx, _req, _params, query) => json(costReport(ctx.db, query.project))) satisfies Handler<
  z.infer<typeof CostQuery>
>;

export function snapshot(ctx: Ctx): Snapshot {
  const db = ctx.db;
  const q = orm(db);
  return {
    /**
     * Is there a credential at all?
     *
     * The scheduler refuses to dispatch a turn without one, so a fleet in this
     * state is stopped and every view would look idle rather than blocked. One
     * boolean, so the header can carry the mark instead of the boss discovering
     * it in a queue that never moves. The deeper checks — docker, the sandbox
     * server, the sidecar version — cost network and stay in the settings page.
     */
    ready: (q.select({ n: count() }).from(runtime_auth).get()?.n ?? 0) > 0,
    // `base_branch` rides along because it is the one thing add-a-project decided
    // on the boss's behalf, and a decision taken silently has to be visible where
    // its consequence starts — the new project's own page.
    projects: q
      .select({
        id: project.id,
        name: project.name,
        repo_path: project.repo_path,
        remote: project.remote,
        base_branch: project.base_branch,
      })
      .from(project)
      .all(),
    groups: q
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
      .where(ne(grp.status, "DISSOLVED"))
      .all(),
    // Why an approved group has not started. The boss pressed the button; showing
    // the same button again reads as "the click did nothing".
    approvedBlocked: q
      .select({ id: grp.id })
      .from(grp)
      .where(and(eq(grp.status, "DRAFT"), isNotNull(grp.approved_at)))
      .all()
      .map((g) => ({ grpId: g.id, reason: canStart(db, g.id).reason ?? "" }))
      .filter((b) => b.reason),
    // A planner found this requirement is already covered. The evidence was checked
    // before the row could exist; the boss decides whether it leaves the board.
    dropProposals: q
      // `grp.id`, not `note.grp_id`: the inner join makes them the same value, and
      // this one is NOT NULL — which is what the panel contract says `grpId` is.
      .select({ grpId: grp.id, body: note.body })
      .from(note)
      .innerJoin(grp, eq(grp.id, note.grp_id))
      // Raw on the right: `json_extract` has no Drizzle operator.
      .where(
        and(notInArray(grp.status, ["DISSOLVED"]), sql`json_extract(${note.frontmatter_json}, '$.drop_proposal') = 1`),
      )
      .groupBy(note.grp_id)
      // Raw: SQLite's bare-column rule, which picks the row the aggregate came
      // from. Newest proposal per group, in one query rather than one per group.
      .having(sql`${note.at} = max(${note.at})`)
      .all(),
    slices: q
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
      .orderBy(slice.grp_id, slice.seq)
      .all(),
    // docs/project/plan.md §8 asks the desk wall for the current slice, the turn count and the
    // live last line. Two of the three are here; the third is the SSE stream,
    // which the client already holds. Turn count is what tells a stuck agent from
    // a busy one — "in_progress" looks identical either way.
    // Raw: `turns` and `slice_id` are scalar subqueries correlated on `a.id`, and
    // both must stay inside this one statement — a per-agent lookup is the N+1 this
    // read model exists to avoid.
    agents: db
      .query<Agent, []>(
        `SELECT a.id, a.grp_id, a.role, a.model, a.state, a.activity, a.session_tokens,
                a.total_tokens,
                (SELECT count(*) FROM job j WHERE j.agent_id = a.id AND j.kind = 'agent_turn'
                  AND j.state IN ('done','failed')) AS turns,
                (SELECT j.slice_id FROM job j WHERE j.agent_id = a.id AND j.slice_id IS NOT NULL
                  ORDER BY j.id DESC LIMIT 1) AS slice_id
         FROM agent a WHERE a.state != 'retired'`,
      )
      .all(),
    tasks: q
      .select({ id: task.id, grp_id: task.grp_id, slice_id: task.slice_id, title: task.title, status: task.status })
      .from(task)
      .all(),
    channels: q
      .select({
        id: channel.id,
        project_id: channel.project_id,
        grp_id: channel.grp_id,
        kind: channel.kind,
        status: channel.status,
      })
      .from(channel)
      .all(),
    // The card each DRAFT group filed. Without this the boss is shown an empty
    // box and asked to approve something they cannot see.
    draftCards: q
      .select({
        // Same as `dropProposals`: the non-null side of the join.
        grpId: grp.id,
        body: note.body,
        at: note.at,
        // Raw: `json_extract`, here in the select list rather than the filter.
        unknownPaths: sql<string | null>`json_extract(${note.frontmatter_json}, '$.unknownPaths')`,
      })
      .from(note)
      .innerJoin(grp, eq(grp.id, note.grp_id))
      .where(and(eq(grp.status, "DRAFT"), sql`json_extract(${note.frontmatter_json}, '$.draft_card') = 1`))
      .groupBy(note.grp_id)
      // Newest card per group; see `dropProposals` for why the HAVING is raw.
      .having(sql`${note.at} = max(${note.at})`)
      .all(),
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
    // Raw: the `>=` above is against a subquery correlated on `e.grp_id`, and the
    // comparison itself is the fix this comment describes. It stays as written.
    lateObjections: db
      .query<GroupSaid, []>(
        `SELECT e.grp_id AS grpId, e.author, e.body FROM event e
         JOIN grp g ON g.id = e.grp_id
         WHERE g.status = 'DRAFT' AND e.kind = 'say' AND e.author != 'dispatcher'
           -- Inclusive on purpose; see the comment above this query.
           AND e.at >= (SELECT max(n.at) FROM note n
                       WHERE n.grp_id = e.grp_id
                         AND json_extract(n.frontmatter_json, '$.draft_card') = 1)
         ORDER BY e.seq`,
      )
      .all(),
    // What the boss originally said, verbatim. Those 20 seconds on the card are
    // the only guard against a plan that is well-formed but aimed at the wrong
    // thing, and that comparison is impossible without the original next to it.
    // Raw: `event.grp_id` is nullable and the contract's `grpId` is not. The
    // `IS NOT NULL` in the WHERE is what makes that true, and no builder type can
    // carry a guarantee that lives in a filter. Nothing to join against here.
    ideas: db
      .query<GroupNote, []>(
        `SELECT grp_id AS grpId, body FROM event
         WHERE kind = 'boss_say' AND grp_id IS NOT NULL
         GROUP BY grp_id HAVING seq = min(seq)`,
      )
      .all(),
    // Recently answered by a stand-in, so the boss can take one back. Without a
    // visible undo, delegated answers are a bet nobody would take.
    // Raw, and the type mismatch it hides is worth naming: `Answered` declares
    // `grp_id` and `answer` non-null, and this query guarantees neither — only
    // `answered_by` is filtered. A standing agent's escalation has no group, and
    // `chain_state = 'answered'` does not imply an `answer` was written. The
    // contract is what is wrong; converting would only move the assertion.
    answered: db
      .query<Answered, []>(
        `SELECT id, grp_id, question, answer, answered_by, ref_note_id, answered_at
         FROM escalation
         WHERE chain_state = 'answered' AND answered_by IS NOT NULL AND answered_by != 'boss'
         ORDER BY answered_at DESC, id DESC LIMIT 10`,
      )
      .all(),
    // Raw: `json_each` over a bound state array, which has no builder form.
    escalations: db
      .query<Escalation, [string]>(
        `SELECT e.id, e.grp_id, e.severity, e.question, e.brief, e.kind, e.chain_state, e.answered_by, e.answer,
                e.created_at, a.role AS asker, a.project_id AS asker_project
         FROM escalation e LEFT JOIN agent a ON a.id = e.agent_id
         WHERE e.chain_state NOT IN (SELECT value FROM json_each(?)) ORDER BY e.created_at, e.id`,
      )
      .all(stateParam(ESCALATION_TERMINAL_STATES)),
    // Only the queue head is offered for merging; the rest carry their place in
    // line so the boss can see why they are waiting.
    mergeQueue: q
      .select({ id: project.id })
      .from(project)
      .all()
      .flatMap((p) => {
        const h = head(db, p.id);
        return h ? [{ projectId: p.id, ...h, place: position(db, h.grpId) }] : [];
      }),
    // Delivered work, so 收尾 stops meaning "vanished". A group that merged is the
    // only proof the system did what it was asked, and it was leaving no trace
    // anywhere in the panel.
    // Raw: `slices` and `at` are scalar subqueries correlated on `g.id`, and the
    // ORDER BY sorts on the second of them.
    archived: db
      .query<Archived, []>(
        `SELECT g.id, g.project_id, g.name, g.branch, g.pr_number, g.spent_tokens,
                (SELECT count(*) FROM slice s WHERE s.grp_id = g.id) AS slices,
                (SELECT max(e.at) FROM event e WHERE e.grp_id = g.id) AS at
         FROM grp g WHERE g.status = 'DISSOLVED' ORDER BY at DESC, g.id DESC LIMIT 12`,
      )
      .all(),
    // The panel shows "并行 3/3" from this: without the cap, a queued group looks
    // stuck rather than queued, which is the difference between a bug and a setting.
    limits: {
      maxGroups: ctx.config.maxGroups,
      // Always the map shape for the panel, whatever the config wrote.
      leaseSlots: poolSizes(ctx.config.leaseSlots),
      autoAdvance: !!ctx.config.autoAdvance,
      autoAcceptTiers: ctx.config.autoAcceptTiers,
    },
    // How much of each subscription is gone. Not spend — spend is attributable and
    // belongs in 成本. This answers "can this still run tonight", which is the one
    // usage question that changes what the boss does next.
    usage: q
      .select({ runtime: usage_snapshot.runtime, json: usage_snapshot.json, at: usage_snapshot.at })
      .from(usage_snapshot)
      .all()
      // Parsed, not spread. The blob was written by an earlier version of this
      // process, so a field it does not have is a field this one must not claim:
      // spreading a `JSON.parse` told TypeScript the result was `{runtime, at}`
      // while the panel read six more properties off it.
      .map((r): UsageWindow => {
        const parsed = UsageWindow.safeParse({
          ...jsonOr(r.json, UsageWindow.partial(), {}),
          runtime: r.runtime,
          at: r.at,
        });
        return parsed.success ? parsed.data : { runtime: r.runtime, at: r.at };
      }),
    lastSeq:
      q
        .select({ s: max(event.seq) })
        .from(event)
        .get()?.s ?? 0,
  };
}
