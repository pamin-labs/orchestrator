import type { z } from "zod";
import type { GroupRef } from "../../contracts/fields.ts";
import type { Ctx } from "../../mech/ctx.ts";
import type { Caller } from "../../http/agent-auth.ts";

/** Authorize an agent against its group, or its project for standing roles. */
export function mayAct(ctx: Ctx, caller: Caller, groupId: number): boolean {
  if (caller.grp_id !== null) return caller.grp_id === groupId;
  if (caller.project_id === null) return false;
  const group = ctx.db.query<{ project_id: number }, [number]>("SELECT project_id FROM grp WHERE id = ?").get(groupId);
  return group?.project_id === caller.project_id;
}

/** Resolve a validated group reference by id or active name. */
export function resolveGroup(
  ctx: Ctx,
  ref: z.infer<typeof GroupRef> | null | undefined,
  fallbackGroupId?: number | null,
): number | null {
  if (typeof ref === "number") return ref;
  const name = ref?.trim();
  if (name) {
    const id = Number(name);
    if (Number.isInteger(id)) return id;
    const group = ctx.db
      .query<{ id: number }, [string]>(
        "SELECT id FROM grp WHERE name = ? AND status != 'DISSOLVED' ORDER BY id DESC LIMIT 1",
      )
      .get(name);
    if (group) return group.id;
  }
  return fallbackGroupId ?? null;
}
