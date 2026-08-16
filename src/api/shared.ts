import type { Caller, Ctx } from "../ctx.ts";

/**
 * What every route module needs and nothing a route module owns.
 *
 * `api.ts` used to be one 3900-line file, so "shared" meant "further up the
 * same file". Splitting it by cluster needs these five in one place first: the
 * two handler shapes, the three response constructors, and the four lookups
 * that more than one cluster does.
 */

export type Handler<D = unknown> = (
  ctx: Ctx,
  req: Request,
  params: Record<string, string>,
  /** The request body, already checked against this route's schema. */
  data: D,
) => Promise<Response>;

/**
 * A route only an agent may call, with the agent already resolved.
 *
 * The caller arrives as an argument because the alternative was 21 handlers each
 * opening with the same two lines, and a trust boundary that is retyped 21 times
 * is a trust boundary with 21 chances to be left out. `agentOf` still exists and
 * is still the only thing that reads the token; what changed is that a route
 * cannot be registered under `/orch` without going through it.
 */
export type AgentHandler<D = unknown> = (
  ctx: Ctx,
  req: Request,
  a: Caller,
  params: Record<string, string>,
  /** The request body, already checked against this route's schema. */
  data: D,
) => Promise<Response>;

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
export const text = (s: string, status = 200) =>
  new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
export const bad = (msg: string) => text(msg, 422);

export async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

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
    ctx.db
      .query<Caller, [string]>("SELECT id, grp_id, project_id, role FROM agent WHERE token = ?")
      .get(token) ?? null
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
 */
export function resolveGroup(ctx: Ctx, ref: unknown, fallbackGrp?: number | null): number | null {
  if (typeof ref === "number" && Number.isInteger(ref)) return ref;
  if (typeof ref === "string" && ref.trim()) {
    const n = Number(ref);
    if (Number.isInteger(n)) return n;
    const row = ctx.db
      .query<{ id: number }, [string]>(
        "SELECT id FROM grp WHERE name = ? AND status != 'DISSOLVED' ORDER BY id DESC LIMIT 1",
      )
      .get(ref.trim());
    if (row) return row.id;
  }
  return fallbackGrp ?? null;
}
