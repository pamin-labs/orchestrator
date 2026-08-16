import type { z } from "zod";
import type { GroupRef } from "./fields.ts";
import type { Caller, Ctx } from "../ctx.ts";

export type { AgentHandler, Handler } from "../http/handler.ts";
export { bad, json, message } from "../http/respond.ts";

/**
 * What every route module needs and nothing a route module owns.
 *
 * `api.ts` used to be one 3900-line file, so "shared" meant "further up the
 * same file". Splitting it by cluster needs these five in one place first: the
 * two handler shapes and the four lookups
 * that more than one cluster does.
 */

/**
 * May this caller act on that group?
 *
 * The token says who is calling; several routes then take a `group_id` from the
 * body and never compared the two. Any Architect could rewrite any group's
 * `owns_json` — which `canStart` reads to gate dispatch, so one call stalls a
 * whole fleet — and any Dispatcher could flip another group to DRAFT and cancel
 * its queued turns.
 *
 * Not a flat "same group": standing roles have no group and are *supposed* to
 * reach across a project. So the scope is whichever the caller has — its group
 * if it is in one, its project if it is not.
 */
export function mayAct(ctx: Ctx, me: Caller, grpId: number): boolean {
  if (me.grp_id !== null) return me.grp_id === grpId;
  if (me.project_id === null) return false;
  const g = ctx.db.query<{ project_id: number }, [number]>("SELECT project_id FROM grp WHERE id = ?").get(grpId);
  return g?.project_id === me.project_id;
}

/**
 * Who is calling.
 *
 * The token comes from the environment the spawner injected, never from the
 * request body — the server listens on localhost TCP, so anything else on
 * 127.0.0.1 could otherwise claim to be any agent by sending an id.
 */
export function agentOf(ctx: Ctx, req: Request): Caller | null {
  const token = req.headers.get("x-orch-token");
  if (!token) return null;
  return (
    ctx.db.query<Caller, [string]>("SELECT id, grp_id, project_id, role FROM agent WHERE token = ?").get(token) ?? null
  );
}

/** What the boss first asked for, for this group. */
export function firstIdea(ctx: Ctx, grpId: number): string {
  return (
    ctx.db
      .query<{ body: string }, [number]>(
        "SELECT body FROM event WHERE grp_id = ? AND kind = 'boss_say' ORDER BY seq LIMIT 1",
      )
      .get(grpId)?.body ?? ""
  );
}

/** A fresh token for a newly hired agent. */
export function mintToken(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

/**
 * A group, by id or by name.
 *
 * Agents reach for the name they can see — one was observed running
 * `orch draft greet -` — and refusing that teaches nothing. Accepting both costs
 * one query and removes a whole class of confusion.
 *
 * Takes `GroupRef`, not `unknown`. Every caller passes a field zod has already
 * decided is `z.union([z.number().int().positive(), z.string().min(1)])`, and
 * the old signature threw that away at the door and rebuilt it inside with
 * `typeof ref === "number" && Number.isInteger(ref)` — a check the schema had
 * already made, written where nothing kept the two in step. `unknown` on a
 * parameter is a claim that the caller could pass anything, and it made the
 * compiler stop checking the ten places that cannot.
 */
export function resolveGroup(
  ctx: Ctx,
  ref: z.infer<typeof GroupRef> | null | undefined,
  fallbackGrp?: number | null,
): number | null {
  if (typeof ref === "number") return ref;
  // A name, unless it spells a number — `orch draft 12` means the group with
  // that id. `.min(1)` allows "   ", which is not a name and not an id.
  const name = ref?.trim();
  if (name) {
    const n = Number(name);
    if (Number.isInteger(n)) return n;
    const row = ctx.db
      .query<{ id: number }, [string]>(
        "SELECT id FROM grp WHERE name = ? AND status != 'DISSOLVED' ORDER BY id DESC LIMIT 1",
      )
      .get(name);
    if (row) return row.id;
  }
  return fallbackGrp ?? null;
}
