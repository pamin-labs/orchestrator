import type { Ctx } from "../../mech/ctx.ts";
import { attempt } from "../../platform/persistence/database.ts";
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

/** The `(project_id, name)` unique index, by the name PostgreSQL gave it. */
const NAME_TAKEN = "grp_project_id_name_unique";

/** What every caller trims to, and what a suffix has to fit inside. */
const MAX_NAME = 40;

/**
 * How many names to try before giving up and reporting the collision.
 *
 * A project with fifty groups slugging identically is not a race this should
 * paper over, and each attempt is a rolled-back transaction. Reached in
 * practice: never — the first retry is already free of everything that existed
 * when the first attempt read.
 */
const MAX_TRIES = 50;

/** `<name>-2`, trimmed from the front so the suffix survives the cap. */
const suffixed = (name: string, n: number): string =>
  `${name.slice(0, MAX_NAME - String(n).length - 1).replace(/-+$/, "")}-${n}`;

/**
 * Whether this error is that one constraint, walking the cause chain.
 *
 * Drizzle wraps the driver's error in a `DrizzleQueryError` whose own message is
 * the statement, so the constraint only ever appears on a `cause`. Keyed on the
 * constraint and not on `23505` alone: a duplicate channel or event is a
 * different defect, and retrying it under a new group name would hide it.
 */
function nameTaken(error: unknown): boolean {
  for (let e: unknown = error, hops = 0; e instanceof Error && hops < 4; e = e.cause, hops++) {
    if ("constraint" in e && e.constraint === NAME_TAKEN) return true;
  }
  return false;
}

/**
 * A group under the first free name.
 *
 * `name` is unique per project because it is a branch and a lookup key, but it is
 * *derived* — `slug()` over prose nobody coordinates — so two requirements about
 * rate limiting produce the same three words. That was a 500 from the insert, and
 * the boss's second ticket about an area simply failed to file.
 */
/** Retried rather than pre-checked: a read-then-insert is the same race with more
 *  code, and the constraint is the only thing that actually knows. */
export async function newGroup(ctx: Ctx, g: NewGroup): Promise<{ id: number; channelId: number }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await insertGroup(ctx, g, attempt === 1 ? g.name : suffixed(g.name, attempt));
    } catch (error) {
      if (attempt >= MAX_TRIES || !nameTaken(error)) throw error;
    }
  }
}

async function insertGroup(ctx: Ctx, g: NewGroup, name: string): Promise<{ id: number; channelId: number }> {
  // A savepoint when the caller already has a transaction open, so a name
  // collision undoes this attempt and not the caller's whole unit of work.
  const made = await attempt(ctx.db, async (tx) => {
    const [grp] = await tx
      .insert(grpTable)
      .values({
        project_id: g.projectId,
        name,
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
