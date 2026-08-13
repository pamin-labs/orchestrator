import type { Ctx } from "../api.ts";
import { say } from "../lang.ts";
import { canStart } from "./ownership.ts";
import { startNextSlice } from "./review.ts";
import { createWorktree } from "./worktree.ts";

/**
 * The only way a group starts working.
 *
 * Approval used to be the sole entry, so a group the boundary check refused was
 * simply dropped: the boss's click went nowhere, and nothing re-ran when the
 * thing blocking it went away. Splitting the decision ("may it start?") from the
 * act ("start it") is what lets the second one happen later, without the boss.
 */

/** Worktree, RUNNING, first slice. Returns an error message, or null on success. */
export async function startGroup(ctx: Ctx, grpId: number): Promise<string | null> {
  // The worktree lives under workRoot (outside $HOME) because the sandbox is
  // deny-only: denying $HOME is how writes get confined at all.
  const grp = ctx.db
    .query<{ name: string; project_id: number; worktree: string | null }, [number]>(
      "SELECT name, project_id, worktree FROM grp WHERE id = ?",
    )
    .get(grpId);
  if (grp && !grp.worktree && ctx.git) {
    const repo = ctx.db
      .query<{ repo_path: string }, [number]>("SELECT repo_path FROM project WHERE id = ?")
      .get(grp.project_id);
    if (repo) {
      try {
        const wt = await createWorktree(ctx.git, {
          repoPath: repo.repo_path,
          workRoot: ctx.config.workRoot,
          group: grp.name,
        });
        ctx.db.run("UPDATE grp SET worktree = ?, branch = ? WHERE id = ?", [wt.worktree, wt.branch, grpId]);
        ctx.bus.emit({
          grpId,
          author: "orchestrator",
          kind: "state_change",
          body: say(ctx.config?.language, "group.worktree", { branch: wt.branch }),
        });
      } catch (e: any) {
        // Refuse to start rather than run the group in the main checkout, where
        // it would write straight into the boss's working tree.
        return `could not create a worktree: ${e?.message ?? e}`;
      }
    }
  }

  ctx.db.run("UPDATE grp SET status = 'RUNNING', approved_at = NULL WHERE id = ?", [grpId]);
  ctx.bus.emit({ grpId, author: "boss", kind: "state_change", body: say(ctx.config?.language, "group.approved") });
  // Approving a plan that then sits still is the most confusing failure there is:
  // it looks like the system ignored you.
  startNextSlice(ctx, grpId);
  ctx.sched.tick();
  return null;
}

/**
 * Groups the boss already approved that a boundary was holding back.
 *
 * Called from `orch owns` (the Architect just re-cut, which may free a *different*
 * group than the one it touched) and from the watchdog, which is the backstop for
 * every other way a blocker leaves — merged, split, parked and then dissolved.
 * Returns the ids that started.
 */
export async function sweepApproved(ctx: Ctx): Promise<number[]> {
  const waiting = ctx.db
    .query<{ id: number }, []>("SELECT id FROM grp WHERE status = 'DRAFT' AND approved_at IS NOT NULL")
    .all();
  const started: number[] = [];
  for (const g of waiting) {
    if (!canStart(ctx.db, g.id).ok) continue;
    if ((await startGroup(ctx, g.id)) === null) started.push(g.id);
  }
  return started;
}
