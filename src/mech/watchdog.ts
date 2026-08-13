import type { Ctx } from "../api.ts";
import type { Config } from "../config.ts";
import { say } from "../lang.ts";
import { interrupt, park, settlePausing } from "./intercept.ts";
import { sweepApproved } from "./start.ts";
import type { GitRunner } from "./worktree.ts";

/**
 * Six rules, all deterministic, all cheap. No LLM is consulted.
 *
 * They exist for the failure class nobody reports: an agent that is stuck but
 * does not know it. Nothing is waiting on it, nothing is asking for help, and the
 * only symptom is money leaving. A model asked "are you going in circles?" says
 * no, so the evidence has to come from state we recorded ourselves.
 */

export interface WatchdogDeps {
  ctx: Ctx;
  cfg: Config;
  git: GitRunner;
  now?: () => number;
}

export interface Finding {
  rule: string;
  grpId: number | null;
  body: string;
  severity: "advisory" | "blocker";
}

export const IDLE_TURN_LIMIT = 3;
export const SAME_FILE_LIMIT = 5;
export const PAUSED_NOTIFY_MS = 15 * 60 * 1000;
/** How often one standing finding may reappear in the timeline. */
export const REEMIT_MS = 30 * 60 * 1000;

export async function runWatchdog(deps: WatchdogDeps): Promise<Finding[]> {
  const { ctx, cfg } = deps;
  // These bodies land in the boss's feed and notifications, so they follow
  // output.language. Feedback aimed at an agent stays English: it lands in a prompt
  // next to code and gate output.
  const t = (k: any, a?: any) => say(ctx.config?.language, k, a);
  const now = deps.now ?? (() => Date.now());
  const findings: Finding[] = [];

  // PAUSING -> PAUSED lives here so a crashed turn cannot leave a group stuck.
  settlePausing(ctx);

  // A group the boss approved while a boundary held it. `orch owns` sweeps too,
  // but a blocker can also leave by merging, being split, or being parked and then
  // dissolved — hooking each of those is four places to forget. Polling one column
  // is the same shape as the rate-limit wait above.
  await sweepApproved(ctx);

  // 1. Turn wall-clock timeout.
  const stale = ctx.db
    .query<{ id: number; grp_id: number | null; started_at: number }, [number]>(
      `SELECT id, grp_id, started_at FROM job
       WHERE state = 'running' AND kind = 'agent_turn' AND started_at < ?`,
    )
    .all(now() - cfg.turnTimeoutMs);
  for (const j of stale) {
    findings.push({
      rule: "turn_timeout",
      grpId: j.grp_id,
      severity: "advisory",
      body: t("wd.turn_timeout", { min: Math.round(cfg.turnTimeoutMs / 60000) }),
    });
    if (j.grp_id) await interrupt(ctx, deps.git, j.grp_id, "keep");
  }

  // 2. Consecutive turns that wrote nothing to the blackboard.
  const idle = ctx.db
    .query<{ id: number; grp_id: number | null; role: string; idle_turns: number }, [number]>(
      "SELECT id, grp_id, role, idle_turns FROM agent WHERE idle_turns >= ?",
    )
    .all(IDLE_TURN_LIMIT);
  for (const a of idle) {
    findings.push({
      rule: "no_progress",
      grpId: a.grp_id,
      severity: "advisory",
      body: t("wd.no_progress", { role: a.role, n: a.idle_turns }),
    });
    ctx.db.run("UPDATE agent SET state = 'blocked', idle_turns = 0 WHERE id = ?", [a.id]);
  }

  // 3. The same agent rewriting the same file over and over.
  const looping = ctx.db
    .query<{ id: number; grp_id: number | null; role: string; loop_file: string; loop_count: number }, [number]>(
      "SELECT id, grp_id, role, loop_file, loop_count FROM agent WHERE loop_count >= ? AND loop_file IS NOT NULL",
    )
    .all(SAME_FILE_LIMIT);
  for (const a of looping) {
    findings.push({
      rule: "circling",
      grpId: a.grp_id,
      severity: "advisory",
      // Architect, not the writer: going round in circles on one file is usually
      // a design problem, and asking the writer to try harder does not fix it.
      body: t("wd.circling", { role: a.role, file: a.loop_file, n: a.loop_count }),
    });
    ctx.db.run("UPDATE agent SET loop_count = 0 WHERE id = ?", [a.id]);
  }

  // 4. A lease that keeps failing while the code has not changed.
  const envSuspect = ctx.db
    .query<{ resource: string; grp_id: number | null; head_sha: string | null; c: number }, []>(
      `SELECT resource, grp_id, head_sha, count(*) AS c FROM lease
       WHERE state = 'failed' AND head_sha IS NOT NULL
       GROUP BY resource, grp_id, head_sha HAVING c >= 2`,
    )
    .all();
  for (const l of envSuspect) {
    findings.push({
      rule: "env_suspect",
      grpId: l.grp_id,
      severity: "advisory",
      // Same command, same code, same failure: the environment is the variable,
      // and letting the writer keep editing code is how hours disappear.
      body: t("wd.env_suspect", { resource: l.resource, n: l.c }),
    });
    ctx.db.run("UPDATE lease SET head_sha = NULL WHERE resource = ? AND state = 'failed' AND head_sha = ?", [
      l.resource,
      l.head_sha,
    ]);
  }

  // 5. Budget.
  const budgets = ctx.db
    .query<{ id: number; name: string; budget_tokens: number; spent_tokens: number; status: string }, []>(
      "SELECT id, name, budget_tokens, spent_tokens, status FROM grp WHERE budget_tokens IS NOT NULL",
    )
    .all();
  for (const g of budgets) {
    const frac = g.spent_tokens / g.budget_tokens;
    if (frac >= 1 && g.status !== "PAUSED") {
      findings.push({
        rule: "budget_exhausted",
        grpId: g.id,
        severity: "blocker",
        body: t("wd.budget_exhausted", { name: g.name, tokens: g.spent_tokens }),
      });
      ctx.db.run("UPDATE grp SET status = 'PAUSED', paused_at = unixepoch() * 1000 WHERE id = ?", [g.id]);
      // A notification says it stopped; it does not put a decision in front of
      // anyone. Without a row in the queue the group sat suspended, 继续 did
      // nothing the scheduler would honour, and the only visible state was a
      // paused group with no reason attached. `budget:` prefixes the question so
      // raising the cap can close exactly this row.
      const open = ctx.db
        .query<{ c: number }, [number]>(
          "SELECT count(*) AS c FROM escalation WHERE grp_id = ? AND answer IS NULL AND question LIKE 'budget:%'",
        )
        .get(g.id)!.c;
      if (open === 0) {
        ctx.db.run(
          `INSERT INTO escalation (grp_id, severity, question, chain_state, created_at)
           VALUES (?, 'blocker', ?, 'boss', unixepoch() * 1000)`,
          [
            g.id,
            `budget: ${g.name} 用完了 ${g.budget_tokens} tokens，全组已挂起。` +
              `提高上限它就接着跑，或者就让它停在这里。`,
          ],
        );
      }
    } else if (frac >= 0.8) {
      findings.push({
        rule: "budget_80",
        grpId: g.id,
        severity: "advisory",
        body: t("wd.budget_80", { name: g.name, pct: Math.round(frac * 100) }),
      });
    }
  }

  // 6. Quota came back. PLAN.md §11 says a rate-limited group waits for the reset,
  // and waiting is only useful if something is watching the clock.
  const throttled = ctx.db
    .query<{ id: number; name: string }, [number]>(
      "SELECT id, name FROM grp WHERE status = 'PAUSED' AND rl_resets_at IS NOT NULL AND rl_resets_at <= ?",
    )
    .all(now());
  for (const g of throttled) {
    ctx.db.run("UPDATE grp SET status = 'RUNNING', paused_at = NULL, rl_resets_at = NULL WHERE id = ?", [g.id]);
    ctx.bus.emit({
      grpId: g.id,
      author: "orchestrator",
      kind: "state_change",
      body: t("rl.resumed"),
    });
    findings.push({ rule: "rate_limit_resumed", grpId: g.id, severity: "advisory", body: t("rl.resumed") });
  }

  // 7. Paused too long: notify, then park to stop holding a slot.
  const paused = ctx.db
    .query<{ id: number; name: string; paused_at: number }, []>(
      // `rl_resets_at IS NULL`: a group waiting for quota is not waiting for the boss,
      // and parking it would retire its sessions minutes before it could resume.
      "SELECT id, name, paused_at FROM grp WHERE status = 'PAUSED' AND paused_at IS NOT NULL AND rl_resets_at IS NULL",
    )
    .all();
  for (const g of paused) {
    const waited = now() - g.paused_at;
    if (waited >= cfg.parkAfterPausedMs) {
      park(ctx, g.id, `waited ${Math.round(waited / 60000)} min for you`);
      findings.push({
        rule: "parked",
        grpId: g.id,
        severity: "advisory",
        body: t("wd.parked", { name: g.name, min: Math.round(waited / 60000) }),
      });
    } else if (waited >= PAUSED_NOTIFY_MS) {
      findings.push({
        rule: "waiting_on_you",
        grpId: g.id,
        severity: "blocker",
        body: t("wd.waiting_on_you", { name: g.name, min: Math.round(waited / 60000) }),
      });
    }
  }

  // A standing condition is re-detected on every tick, and emitting it every time
  // filled the timeline with the same line dozens of times over — "perf-rewrite is
  // at 102% of its budget", every few seconds, until the feed was worthless. The
  // notifier already backs off; the event log needs the same rule. A repeat is a
  // reminder, not a new problem.
  for (const f of findings) {
    const last = ctx.db
      .query<{ at: number }, [string, number | null, number | null]>(
        `SELECT max(at) AS at FROM event
         WHERE kind = 'escalation' AND author = 'watchdog'
           AND json_extract(meta_json, '$.rule') = ?
           AND (grp_id IS ? OR (grp_id IS NULL AND ? IS NULL))`,
      )
      .get(f.rule, f.grpId ?? null, f.grpId ?? null);
    if (last?.at && now() - last.at < REEMIT_MS) continue;
    ctx.bus.emit({
      grpId: f.grpId,
      author: "watchdog",
      kind: "escalation",
      intent: "ask",
      severity: f.severity,
      body: f.body,
      meta: { rule: f.rule },
    });
  }
  return findings;
}

/**
 * Update the loop/idle counters from a finished turn.
 *
 * "Wrote nothing" means no file changed, no task moved and no note was written —
 * three things we can check without asking the agent how it feels about its
 * progress.
 */
export function recordTurnOutcome(
  ctx: Ctx,
  agentId: number,
  filesTouched: string[],
  wroteNote: boolean,
  movedTask: boolean,
): void {
  const productive = filesTouched.length > 0 || wroteNote || movedTask;
  if (productive) ctx.db.run("UPDATE agent SET idle_turns = 0 WHERE id = ?", [agentId]);
  else ctx.db.run("UPDATE agent SET idle_turns = idle_turns + 1 WHERE id = ?", [agentId]);

  // One file, alone, repeatedly: the signature of an agent guessing.
  const single = filesTouched.length === 1 ? filesTouched[0]! : null;
  if (!single) {
    ctx.db.run("UPDATE agent SET loop_file = NULL, loop_count = 0 WHERE id = ?", [agentId]);
    return;
  }
  const prev = ctx.db
    .query<{ loop_file: string | null }, [number]>("SELECT loop_file FROM agent WHERE id = ?")
    .get(agentId)?.loop_file;
  if (prev === single) ctx.db.run("UPDATE agent SET loop_count = loop_count + 1 WHERE id = ?", [agentId]);
  else ctx.db.run("UPDATE agent SET loop_file = ?, loop_count = 1 WHERE id = ?", [single, agentId]);
}
