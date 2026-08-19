import { eq } from "drizzle-orm";
import type { DB } from "../../platform/persistence/database.ts";
import { orm } from "../../platform/persistence/orm.ts";
import { grp } from "../../platform/persistence/schema.ts";
import type { z } from "zod";
import type { GroupRef } from "../../contracts/fields.ts";
import type { Ctx } from "../../mech/ctx.ts";
import type { Caller } from "../../http/agent-auth.ts";

/** Authorize an agent against its group, or its project for standing roles. */
export function mayAct(db: DB, caller: Caller, groupId: number): boolean {
  if (caller.grp_id !== null) return caller.grp_id === groupId;
  if (caller.project_id === null) return false;
  const group = orm(db).select({ project_id: grp.project_id }).from(grp).where(eq(grp.id, groupId)).get();
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
