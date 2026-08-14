import type { Ctx } from "../api.ts";
import { say } from "../lang.ts";
import { createCheckout, remoteUrl } from "./checkout.ts";
import { canStart } from "./ownership.ts";
import { startNextSlice } from "./review.ts";
import { execIn, WORK } from "./sandbox.ts";
import { defaultBase } from "./worktree.ts";

/** `project.config_json.install`, or null. Same reader shape as `gatesFor`. */
function installFor(ctx: Ctx, projectId: number): string | null {
  const row = ctx.db
    .query<{ config_json: string }, [number]>("SELECT config_json FROM project WHERE id = ?")
    .get(projectId);
  try {
    const v = JSON.parse(row?.config_json ?? "{}").install;
    return typeof v === "string" && v.trim() ? v : null;
  } catch {
    return null;
  }
}

/**
 * The only way a group starts working.
 *
 * Approval used to be the sole entry, so a group the boundary check refused was
 * simply dropped: the boss's click went nowhere, and nothing re-ran when the
 * thing blocking it went away. Splitting the decision ("may it start?") from the
 * act ("start it") is what lets the second one happen later, without the boss.
 */

/**
 * Wind a group up without merging it: it should not be done.
 *
 * The boss's 不做了, and the CoS triaging a complaint as `reject` — one path, or
 * the two disagree about what "dropped" means. Rejecting used to only cancel the
 * queue, so the group kept its ACTIVE status and went on holding its paths against
 * every other group forever.
 *
 * No retro turn. A group that is being dropped has, by definition, nobody who
 * wants its output, and the reason it is being dropped is the sentence that was
 * just written to its blackboard — spending an Opus turn to restate that teaches
 * the agents that retros are paperwork. The worktree and every event stay:
 * archiving must never mean deleting.
 *
 * `owns` is deliberately left alone. `canStart` only counts ACTIVE groups, so
 * DISSOLVED already releases the paths, and blanking the column would erase what
 * this group was allowed to touch from the record.
 */
export function dropGroup(ctx: Ctx, grpId: number, why: string): void {
  ctx.sched.cancelPending(grpId, "dropped");
  ctx.db.run("UPDATE grp SET status = 'DISSOLVED', merge_seq = NULL WHERE id = ?", [grpId]);
  ctx.db.run("UPDATE agent SET state = 'retired', session_id = NULL, token = NULL WHERE grp_id = ?", [grpId]);
  ctx.db.run("UPDATE channel SET status = 'archived' WHERE grp_id = ?", [grpId]);
  // Anything it had asked the boss dies with it, or the question outlives the
  // requirement and sits in 待办 forever.
  ctx.db.run(
    `UPDATE escalation SET chain_state = 'revoked', answered_at = unixepoch() * 1000
     WHERE grp_id = ? AND answer IS NULL`,
    [grpId],
  );
  ctx.bus.emit({
    grpId,
    author: "boss",
    kind: "state_change",
    body: say(ctx.config?.language, "group.dropped", { why: why ? `：${why}` : "" }),
  });
}

/** Sandbox, checkout, RUNNING, first slice. Returns an error message, or null. */
export async function startGroup(ctx: Ctx, grpId: number): Promise<string | null> {
  const grp = ctx.db
    .query<{ name: string; project_id: number; branch: string | null }, [number]>(
      "SELECT name, project_id, branch FROM grp WHERE id = ?",
    )
    .get(grpId);
  if (grp && !grp.branch && ctx.git) {
    const repo = ctx.db
      .query<{ repo_path: string }, [number]>("SELECT repo_path FROM project WHERE id = ?")
      .get(grp.project_id);
    if (repo) {
      try {
        const remote = await remoteUrl(ctx.git, repo.repo_path);
        if (!remote) return "project has no `origin` remote; a group clones from it";
        const branch = `orch/${grp.name}`;
        const base = await defaultBase(ctx.git, repo.repo_path);
        await createCheckout(ctx, { grp: grpId }, { remote, branch, base: `origin/${base}` });
        ctx.db.run("UPDATE grp SET branch = ? WHERE id = ?", [branch, grpId]);
        ctx.bus.emit({
          grpId,
          author: "orchestrator",
          kind: "state_change",
          body: say(ctx.config?.language, "group.worktree", { branch }),
        });

        // Dependencies, before the first engineer turn — still a role, not a
        // table of stacks. bun, pnpm, poetry, uv, pdm, mise, a Makefile target:
        // nobody enumerates those, and the repo says which one it is. What
        // changed is where it runs: the agent installs inside its own sandbox,
        // so there is nothing left for the orchestrator to do on its behalf.
        const known = installFor(ctx, grp.project_id);
        if (known) {
          const dep = await execIn(ctx, { grp: grpId }, known, { cwd: WORK, timeoutMs: 900_000 });
          if (dep.code !== 0)
            ctx.sched.enqueue("agent_turn", {
              grp_id: grpId,
              priority: 9,
              payload: {
                role: "bootstrap",
                rejection: `记下来的安装命令跑不通了：${known}\n${(dep.err || dep.out).slice(-400)}`,
              },
            });
        } else {
          ctx.sched.enqueue("agent_turn", { grp_id: grpId, priority: 9, payload: { role: "bootstrap" } });
        }
      } catch (e: any) {
        // Refuse to start rather than let the group run without its own checkout.
        return `could not prepare the group's checkout: ${e?.message ?? e}`;
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
    const err = await startGroup(ctx, g.id);
    if (err === null) {
      started.push(g.id);
      continue;
    }
    // Withdraw the intent and say so. Worktree failures are almost always
    // permanent — a full disk, a branch name already taken, no write permission —
    // and this runs on the watchdog tick, so leaving the intent set retried it
    // every thirty seconds forever, returning an error to nobody.
    ctx.db.run("UPDATE grp SET approved_at = NULL WHERE id = ?", [g.id]);
    ctx.db.run(
      `INSERT INTO escalation (grp_id, severity, question, brief, chain_state, created_at)
       VALUES (?, 'blocker', ?, '批准没能落地', 'boss', unixepoch() * 1000)`,
      [g.id, `批准没能落地：${err}。修好之后再批一次。`],
    );
    ctx.bus.emit({
      grpId: g.id,
      author: "orchestrator",
      kind: "escalation",
      intent: "ask",
      severity: "blocker",
      body: `批准没能落地：${err}`,
    });
  }
  return started;
}
