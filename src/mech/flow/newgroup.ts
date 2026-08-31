import type { Ctx } from "../../mech/ctx.ts";
import { channel, grp as grpTable } from "../../platform/persistence/schema.ts";
import { addNote } from "../util/rows.ts";
import { outputLanguage } from "../../contracts/config.ts";

/**
 * Starting a requirement: the writes that have to happen together.
 *
 * A row, its channel and the idea on the blackboard, in one transaction; the
 * same idea on the timeline once it commits, because the bus holds the pool and
 * not this transaction's handle. Four places did this by hand and had already
 * drifted — one set `owns_json`, one passed the channel id to the emit, one
 * wrote a different author. None of those was a decision; they are the order the
 * four were written in.
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
  /** The heading a person reads. `name` stays the ascii slug git and the CLI use. */
  title?: string | null;
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

export async function newGroup(ctx: Ctx, g: NewGroup): Promise<{ id: number; channelId: number }> {
  const made = await ctx.bus.transaction(async (tx) => {
    const [grp] = await tx
      .insert(grpTable)
      .values({
        project_id: g.projectId,
        name: g.name,
        title: g.title ?? null,
        // `status` has a schema default of DRAFT, so PLANNING has to be said.
        status: "PLANNING",
        shared_grant: g.sharedGrant?.length ? JSON.stringify(g.sharedGrant) : null,
        // Was `coalesce(?, '[]')` around a bound NULL. `owns_json` is NOT NULL
        // DEFAULT and a bound NULL overrides the default rather than falling back
        // to it, so the empty value is written directly instead. It is `jsonb`, so
        // what goes in is the array itself and never a string of one.
        owns_json: g.owns?.length ? g.owns : [],
        created_at: Date.now(),
      })
      .returning({ id: grpTable.id });
    if (!grp) throw new Error("group insert returned no row");

    // `channel.grp_id` is the only link between the two; a reverse pointer on grp
    // would be a second source of truth for the same edge.
    const [ch] = await tx
      .insert(channel)
      .values({
        project_id: g.projectId,
        grp_id: grp.id,
        kind: "group",
        created_at: Date.now(),
      })
      .returning({ id: channel.id });
    if (!ch) throw new Error("channel insert returned no row");

    // Two bodies, not one. The blackboard note carries what a planner needs to
    // read alongside the ask — attachment paths, which group this was split out of
    // — and the timeline carries the ask itself. Collapsing them puts file paths
    // and provenance into the line the boss reads back as "what I asked for".
    await addNote(tx, {
      projectId: g.projectId,
      grpId: grp.id,
      kind: "fact",
      lang: outputLanguage(ctx.config),
      body: g.note ?? g.idea,
    });
    // Inside, not after. It sat after because the bus held the pool and not this
    // transaction's handle, so the idea would have reached the timeline on
    // another connection whatever happened here. `Bus.emit` joins the open
    // transaction now — and a group whose creation rolled back must not leave
    // its idea on the timeline with no requirement behind it.
    await ctx.bus.emit({
      grpId: grp.id,
      channelId: ch.id,
      author: g.author ?? "boss",
      kind: "boss_say",
      intent: "request",
      body: g.idea,
    });
    return { id: grp.id, channelId: ch.id };
  });
  return made;
}
