import type { Ctx } from "../api.ts";
import { say } from "../lang.ts";
import { createCheckout, remoteUrl } from "./checkout.ts";
import { canStart } from "./ownership.ts";
import { startNextSlice } from "./review.ts";
import { execLines, WORK } from "./sandbox.ts";
import { baseRefFor } from "./checkout.ts";

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

/**
 * Install the project's dependencies, out loud.
 *
 * Streamed rather than awaited in silence: this is the first minute of a
 * requirement and the longest thing that happens before any work, so a panel
 * that shows nothing until it ends looks like a panel that is broken. Each line
 * goes out as a live frame — the same channel a turn's output uses, so the
 * timeline already knows how to render it — and only the tail is kept durably,
 * because an install log is worth watching and not worth storing.
 */
export async function runInstall(
  ctx: Ctx,
  grpId: number,
  cmd: string,
): Promise<{ ok: boolean; tail: string }> {
  const seen: string[] = [];
  ctx.bus.live({ grpId, agentId: null, role: "orchestrator", kind: "status", body: `$ ${cmd}` });
  const stream = execLines(ctx, { grp: grpId }, cmd, {
    cwd: WORK,
    timeoutMs: ctx.config.installTimeoutMs ?? 10_800_000,
  });
  let end = { code: -1, err: "" };
  for (;;) {
    const step = await stream.next();
    if (step.done) {
      end = step.value;
      break;
    }
    seen.push(step.value);
    if (seen.length > 400) seen.shift();
    ctx.bus.live({ grpId, agentId: null, role: "orchestrator", kind: "tool", body: step.value });
  }
  const tail = [...seen.slice(-12), ...(end.err ? [end.err.slice(-400)] : [])].join("\n");
  ctx.bus.emit({
    grpId,
    author: "orchestrator",
    kind: "state_change",
    body: end.code === 0 ? `装好了：${cmd}` : `装失败了（exit ${end.code}）：${cmd}\n${tail}`,
  });
  return { ok: end.code === 0, tail };
}

/**
 * Put back what a fresh container does not have.
 *
 * A sandbox is where the work lives — the clone and everything installed into
 * it — and it is replaceable: the TTL reaps an idle one, a credential change
 * kills it, the server it runs on restarts. `ensureSandbox` already builds
 * another, and until now that was the whole story, so the next turn woke up in
 * an empty container with no checkout and no dependencies and reported that the
 * repository was broken.
 *
 * Called from `ensureSandbox` rather than from each of its callers: a caller
 * that has to remember to restore is a caller that will not, and the ones that
 * matter are three levels down inside a turn.
 *
 * Inline rather than queued, because the turn that triggered the rebuild cannot
 * do anything useful until this finishes. `createCheckout` is idempotent, and
 * the install streams, which is what makes a long one watchable.
 */
export async function restoreWorkspace(ctx: Ctx, grpId: number): Promise<void> {
  const grp = ctx.db
    .query<{ project_id: number; branch: string | null }, [number]>(
      "SELECT project_id, branch FROM grp WHERE id = ?",
    )
    .get(grpId);
  // No branch means the group has not started; `startGroup` owns that path and
  // is in the middle of it.
  if (!grp?.branch || !ctx.git) return;
  const repo = ctx.db
    .query<{ repo_path: string }, [number]>("SELECT repo_path FROM project WHERE id = ?")
    .get(grp.project_id);
  if (!repo) return;
  const remote = await remoteUrl(ctx.git, repo.repo_path);
  if (!remote) return;

  ctx.bus.emit({
    grpId,
    author: "orchestrator",
    kind: "state_change",
    body: `沙盒是新的，把 ${grp.branch} 和依赖装回去`,
  });
  await createCheckout(ctx, { grp: grpId }, {
    remote,
    branch: grp.branch,
    base: await baseRefFor(ctx, grp.project_id),
    git: ctx.git,
    repoPath: repo.repo_path,
  });

  const known = installFor(ctx, grp.project_id);
  if (known) {
    const dep = await runInstall(ctx, grpId, known);
    if (dep.ok) return;
  }
  // No recorded command, or the recorded one stopped working: the same role that
  // works it out the first time works it out again, with the failure in hand.
  ctx.sched.enqueue("agent_turn", {
    grp_id: grpId,
    priority: 9,
    payload: {
      role: "bootstrap",
      ...(known ? { rejection: `沙盒重建后，记下来的安装命令跑不通：${known}` } : {}),
    },
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
        const base = await baseRefFor(ctx, grp.project_id);
        await createCheckout(ctx, { grp: grpId }, { remote, branch, base });
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
          const dep = await runInstall(ctx, grpId, known);
          if (!dep.ok)
            ctx.sched.enqueue("agent_turn", {
              grp_id: grpId,
              priority: 9,
              payload: {
                role: "bootstrap",
                rejection: `记下来的安装命令跑不通了：${known}\n${dep.tail}`,
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
