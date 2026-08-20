import type { DB } from "../../platform/persistence/database.ts";
import { parseRepo } from "../../contracts/repository.ts";
import { eq } from "drizzle-orm";
import { project } from "../../platform/persistence/schema.ts";

const holds = new Map<string, number>();
export const REPO_HOLD_MS = 10 * 60_000;

export function holdRepository(slug: string, now: number): void {
  holds.set(slug, now + REPO_HOLD_MS);
}

export function clearRepositoryHold(slug: string): boolean {
  return holds.delete(slug);
}

export async function repoHeld(db: DB, projectId: number, now = Date.now()): Promise<boolean> {
  const [row] = await db.select({ remote: project.remote }).from(project).where(eq(project.id, projectId));
  const slug = row?.remote ? parseRepo(row.remote) : null;
  if (!slug) return false;
  const until = holds.get(slug);
  if (until === undefined) return false;
  if (until <= now) {
    holds.delete(slug);
    return false;
  }
  return true;
}

export function resetRepoHolds(): void {
  holds.clear();
}

export function forgetHolds(runtime: string): void {
  if (runtime === "github") holds.clear();
}
