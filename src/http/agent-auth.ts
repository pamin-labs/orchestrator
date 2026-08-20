import { eq } from "drizzle-orm";
import type { DB } from "../platform/persistence/database.ts";
import { agent } from "../platform/persistence/schema.ts";

/** Who is calling, resolved from the `x-orch-token` an agent was issued. */
export interface Caller {
  id: number;
  grp_id: number | null;
  project_id: number | null;
  role: string;
}

/** Resolve an agent only from the token injected by its sandbox. */
export async function agentOf(db: DB, req: Request): Promise<Caller | null> {
  const token = req.headers.get("x-orch-token");
  if (!token) return null;
  const [row] = await db
    .select({ id: agent.id, grp_id: agent.grp_id, project_id: agent.project_id, role: agent.role })
    .from(agent)
    .where(eq(agent.token, token));
  return row ?? null;
}
