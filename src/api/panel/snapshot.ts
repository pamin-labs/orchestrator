import type {
  Agent,
  Answered,
  Archived,
  Channel,
  DraftCard,
  Escalation,
  Group,
  GroupNote,
  GroupSaid,
  Project,
  Slice,
  Task,
} from "./shapes.ts";
import { UsageWindow, type Snapshot } from "./shapes.ts";
import { jsonOr } from "../../mech/util/text.ts";
import { costReport } from "../../mech/ops/cost.ts";
import { canStart } from "../../mech/flow/ownership.ts";
import { poolSizes } from "../../scheduler.ts";
import { head, position } from "../../mech/flow/mergequeue.ts";
import { json, type Handler } from "../shared.ts";
import type { Ctx } from "../../ctx.ts";
import { ESCALATION_TERMINAL_STATES, stateParam } from "../../states.ts";
import { z } from "zod";

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
    ready: (db.query<{ n: number }, []>("SELECT count(*) AS n FROM runtime_auth").get()?.n ?? 0) > 0,
    // `base_branch` rides along because it is the one thing add-a-project decided
    // on the boss's behalf, and a decision taken silently has to be visible where
    // its consequence starts — the new project's own page.
    projects: db.query<Project, []>("SELECT id, name, repo_path, remote, base_branch FROM project").all(),
    groups: db
      .query<Group, []>(
        `SELECT id, project_id, name, branch, status, owns_json, budget_tokens,
                spent_tokens, pr_number, approved_at FROM grp WHERE status != 'DISSOLVED'`,
      )
      .all(),
    // Why an approved group has not started. The boss pressed the button; showing
    // the same button again reads as "the click did nothing".
    approvedBlocked: db
      .query<{ id: number }, []>("SELECT id FROM grp WHERE status = 'DRAFT' AND approved_at IS NOT NULL")
      .all()
      .map((g) => ({ grpId: g.id, reason: canStart(db, g.id).reason ?? "" }))
      .filter((b) => b.reason),
    // A planner found this requirement is already covered. The evidence was checked
    // before the row could exist; the boss decides whether it leaves the board.
    dropProposals: db
      .query<GroupNote, []>(
        `SELECT n.grp_id AS grpId, n.body FROM note n
         JOIN grp g ON g.id = n.grp_id
         WHERE g.status NOT IN ('DISSOLVED') AND json_extract(n.frontmatter_json, '$.drop_proposal') = 1
         GROUP BY n.grp_id HAVING n.at = max(n.at)`,
      )
      .all(),
    slices: db
      .query<Slice, []>(
        `SELECT id, grp_id, seq, title, accept_spec, difficulty, status, gates_json,
                spent_tokens, awaiting_at FROM slice ORDER BY grp_id, seq`,
      )
      .all(),
    // PLAN.md §8 asks the desk wall for the current slice, the turn count and the
    // live last line. Two of the three are here; the third is the SSE stream,
    // which the client already holds. Turn count is what tells a stuck agent from
    // a busy one — "in_progress" looks identical either way.
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
    tasks: db.query<Task, []>("SELECT id, grp_id, slice_id, title, status FROM task").all(),
    channels: db.query<Channel, []>("SELECT id, project_id, grp_id, kind, status FROM channel").all(),
    // The card each DRAFT group filed. Without this the boss is shown an empty
    // box and asked to approve something they cannot see.
    draftCards: db
      .query<DraftCard, []>(
        `SELECT n.grp_id AS grpId, n.body, n.at,
                json_extract(n.frontmatter_json, '$.unknownPaths') AS unknownPaths FROM note n
         JOIN grp g ON g.id = n.grp_id
         WHERE g.status = 'DRAFT' AND json_extract(n.frontmatter_json, '$.draft_card') = 1
         GROUP BY n.grp_id HAVING n.at = max(n.at)`,
      )
      .all(),
    // An objection that arrived after the card was filed. The Dispatcher does not
    // wait for the Architect — a card nobody filed is worth less than a card with
    // no objection on it — so a real objection can land a minute later, while the
    // card still reads 反对 : 无. Approving that is approving something the boss
    // was never shown. Measured: the late objection was "the locale-inference
    // slice contradicts the acceptance criterion that says behaviour is unchanged".
    lateObjections: db
      .query<GroupSaid, []>(
        `SELECT e.grp_id AS grpId, e.author, e.body FROM event e
         JOIN grp g ON g.id = e.grp_id
         WHERE g.status = 'DRAFT' AND e.kind = 'say' AND e.author != 'dispatcher'
           AND e.at > (SELECT max(n.at) FROM note n
                       WHERE n.grp_id = e.grp_id
                         AND json_extract(n.frontmatter_json, '$.draft_card') = 1)
         ORDER BY e.seq`,
      )
      .all(),
    // What the boss originally said, verbatim. Those 20 seconds on the card are
    // the only guard against a plan that is well-formed but aimed at the wrong
    // thing, and that comparison is impossible without the original next to it.
    ideas: db
      .query<GroupNote, []>(
        `SELECT grp_id AS grpId, body FROM event
         WHERE kind = 'boss_say' AND grp_id IS NOT NULL
         GROUP BY grp_id HAVING seq = min(seq)`,
      )
      .all(),
    // Recently answered by a stand-in, so the boss can take one back. Without a
    // visible undo, delegated answers are a bet nobody would take.
    answered: db
      .query<Answered, []>(
        `SELECT id, grp_id, question, answer, answered_by, ref_note_id, answered_at
         FROM escalation
         WHERE chain_state = 'answered' AND answered_by IS NOT NULL AND answered_by != 'boss'
         ORDER BY answered_at DESC LIMIT 10`,
      )
      .all(),
    escalations: db
      .query<Escalation, [string]>(
        `SELECT e.id, e.grp_id, e.severity, e.question, e.brief, e.kind, e.chain_state, e.answered_by, e.answer,
                e.created_at, a.role AS asker, a.project_id AS asker_project
         FROM escalation e LEFT JOIN agent a ON a.id = e.agent_id
         WHERE e.chain_state NOT IN (SELECT value FROM json_each(?)) ORDER BY e.created_at`,
      )
      .all(stateParam(ESCALATION_TERMINAL_STATES)),
    // Only the queue head is offered for merging; the rest carry their place in
    // line so the boss can see why they are waiting.
    mergeQueue: db
      .query<{ id: number }, []>("SELECT id FROM project")
      .all()
      .flatMap((p) => {
        const h = head(db, p.id);
        return h ? [{ projectId: p.id, ...h, place: position(db, h.grpId) }] : [];
      }),
    // Delivered work, so 收尾 stops meaning "vanished". A group that merged is the
    // only proof the system did what it was asked, and it was leaving no trace
    // anywhere in the panel.
    archived: db
      .query<Archived, []>(
        `SELECT g.id, g.project_id, g.name, g.branch, g.pr_number, g.spent_tokens,
                (SELECT count(*) FROM slice s WHERE s.grp_id = g.id) AS slices,
                (SELECT max(e.at) FROM event e WHERE e.grp_id = g.id) AS at
         FROM grp g WHERE g.status = 'DISSOLVED' ORDER BY at DESC LIMIT 12`,
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
    usage: db
      .query<{ runtime: string; json: string; at: number }, []>("SELECT runtime, json, at FROM usage_snapshot")
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
    lastSeq: ctx.db.query<{ s: number | null }, []>("SELECT max(seq) AS s FROM event").get()?.s ?? 0,
  };
}
