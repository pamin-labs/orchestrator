import type { Ctx } from "../../mech/ctx.ts";
import { addNote } from "../util/rows.ts";

/**
 * Starting a requirement: the five writes that have to happen together.
 *
 * A row, its channel, the idea on the blackboard, and the same idea on the
 * timeline. Four places did this by hand and had already drifted — one set
 * `owns_json`, one passed the channel id to the emit, one wrote a different
 * author. None of those was a decision; they are the order the four were written
 * in.
 */
/**
 * Queueing the planning turn is deliberately **not** here. It looks like the fifth
 * write and is not: `postIdea` may have to put an Architect turn ahead of the
 * Dispatcher to cut a boundary first, and folding the enqueue in reversed that
 * order — caught by the test that watches which role runs first.
 *
 * `boss_say` even when an agent is asking, because that is the kind every planner
 * reads as "this is the requirement". A second shape for the same thing would be a
 * second thing for a role prompt to remember.
 */
export interface NewGroup {
  projectId: number;
  name: string;
  /** What is being asked for, in the boss's words or an agent's. */
  idea: string;
  /** What goes on the blackboard, if it differs — attachments, provenance. */
  note?: string;
  /** Who the timeline says asked. The boss unless an agent raised it. */
  author?: string;
  /** Paths this group owns from birth. Only the blocked-path route sets it. */
  owns?: string[];
  /** Shared paths it is allowed to touch anyway. */
  sharedGrant?: string[];
}

export function newGroup(ctx: Ctx, g: NewGroup): { id: number; channelId: number } {
  return ctx.db.transaction(() => {
    const grp = ctx.db
      .query<{ id: number }, [number, string, string | null, string | null]>(
        `INSERT INTO grp (project_id, name, status, shared_grant, owns_json, created_at)
         VALUES (?, ?, 'PLANNING', ?, coalesce(?, '[]'), unixepoch() * 1000) RETURNING id`,
      )
      .get(
        g.projectId,
        g.name,
        g.sharedGrant?.length ? JSON.stringify(g.sharedGrant) : null,
        g.owns?.length ? JSON.stringify(g.owns) : null,
      )!;

    // `channel.grp_id` is the only link between the two; a reverse pointer on grp
    // would be a second source of truth for the same edge.
    const ch = ctx.db
      .query<{ id: number }, [number, number]>(
        "INSERT INTO channel (project_id, grp_id, kind, created_at) VALUES (?, ?, 'group', unixepoch() * 1000) RETURNING id",
      )
      .get(g.projectId, grp.id)!;

    // Two bodies, not one. The blackboard note carries what a planner needs to
    // read alongside the ask — attachment paths, which group this was split out of
    // — and the timeline carries the ask itself. Collapsing them puts file paths
    // and provenance into the line the boss reads back as "what I asked for".
    addNote(ctx.db, {
      projectId: g.projectId,
      grpId: grp.id,
      kind: "fact",
      lang: ctx.config.language,
      body: g.note ?? g.idea,
    });
    ctx.bus.emit({
      grpId: grp.id,
      channelId: ch.id,
      author: g.author ?? "boss",
      kind: "boss_say",
      intent: "request",
      body: g.idea,
    });
    return { id: grp.id, channelId: ch.id };
  })();
}
