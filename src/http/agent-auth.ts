import type { DB } from "../platform/persistence/database.ts";

/** Who is calling, resolved from the `x-orch-token` an agent was issued. */
export interface Caller {
  id: number;
  grp_id: number | null;
  project_id: number | null;
  role: string;
}

/** Resolve an agent only from the token injected by its sandbox. */
export function agentOf(db: DB, req: Request): Caller | null {
  const token = req.headers.get("x-orch-token");
  if (!token) return null;
  return (
    db.query<Caller, [string]>("SELECT id, grp_id, project_id, role FROM agent WHERE token = ?").get(token) ?? null
  );
}
