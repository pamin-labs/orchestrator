import type { Ctx } from "../api.ts";
import type { Config } from "../config.ts";
import { say } from "../lang.ts";
import { interrupt, park, settlePausing, unpark } from "./intercept.ts";
import { sweepApproved } from "./start.ts";
import { route } from "./chain.ts";
import { resumeReclaimed, type Job } from "../scheduler.ts";
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
/** How long one of the boss's own decisions may sit before it is worth a word. */
export const NUDGE_AFTER_MS = 4 * 60 * 60 * 1000;
/** And how often to say it again. Nagging every half hour is how a feed is ignored. */
export const NUDGE_REEMIT_MS = 6 * 60 * 60 * 1000;

/**
 * The three approval points, each with a clock.
 *
 * They are meant to wait — a plan the boss has not read should not start, and a
 * slice nobody accepted should not be called delivered. What was missing is that
 * they waited in silence, so "waiting for you since Tuesday" and "arrived a minute
 * ago" looked exactly alike, and a forgotten requirement is as stopped as a
 * crashed one.
 */
function waitingOnBoss(db: WatchdogDeps["ctx"]["db"], now: number): Finding[] {
  const out: Finding[] = [];
  const hours = (ms: number) => Math.round(ms / 3_600_000);

  for (const g of db
    .query<{ id: number; name: string; at: number }, [number]>(
      `SELECT g.id, g.name, max(n.at) AS at FROM grp g JOIN note n ON n.grp_id = g.id
       WHERE g.status = 'DRAFT' AND g.approved_at IS NULL
         AND json_extract(n.frontmatter_json, '$.draft_card') = 1
       GROUP BY g.id HAVING max(n.at) < ?`,
    )
    .all(now - NUDGE_AFTER_MS)) {
    out.push({
      rule: "waiting_card",
      grpId: g.id,
      severity: "advisory",
      body: `${g.name} 的计划卡等你批 ${hours(now - g.at)} 小时了`,
    });
  }

  for (const s of db
    .query<{ grp_id: number; name: string; seq: number; awaiting_at: number }, [number]>(
      `SELECT s.grp_id, g.name, s.seq, s.awaiting_at FROM slice s JOIN grp g ON g.id = s.grp_id
       WHERE s.status = 'awaiting_boss' AND s.awaiting_at IS NOT NULL AND s.awaiting_at < ?`,
    )
    .all(now - NUDGE_AFTER_MS)) {
    out.push({
      rule: "waiting_slice",
      grpId: s.grp_id,
      severity: "advisory",
      body: `${s.name} S${s.seq} 等你查收 ${hours(now - s.awaiting_at)} 小时了`,
    });
  }

  // Only the head: the queue is strictly serial, so everything behind it is
  // waiting on this one merge, and that count is the whole reason to care.
  for (const q of db
    .query<{ id: number; name: string; at: number; behind: number }, [number]>(
      `SELECT g.id, g.name, g.merge_seq_at AS at,
              (SELECT count(*) FROM grp o WHERE o.project_id = g.project_id
                 AND o.status = 'PR_OPEN' AND o.merge_seq > g.merge_seq) AS behind
       FROM grp g WHERE g.status = 'PR_OPEN' AND g.merge_seq_at IS NOT NULL AND g.merge_seq_at < ?
         AND NOT EXISTS (SELECT 1 FROM grp o WHERE o.project_id = g.project_id
                           AND o.status = 'PR_OPEN' AND o.merge_seq < g.merge_seq)`,
    )
    .all(now - NUDGE_AFTER_MS)) {
    out.push({
      rule: "waiting_merge",
      grpId: q.id,
      severity: q.behind > 0 ? "blocker" : "advisory",
      body:
        `${q.name} 的 PR 排在队首 ${hours(now - q.at)} 小时了` +
        (q.behind > 0 ? `，后面还堵着 ${q.behind} 个` : ""),
    });
  }
  return out;
}

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

  // 8. A live group with nothing queued.
  //
  // Every way a turn can end is terminal — failed, done, cancelled — and nothing
  // re-queues. So whenever a turn ends without arranging the next one, the group
  // stays RUNNING, its slice stays `running`, `startNextSlice` counts it busy, and
  // the desk wall reads 在跑 0 with no error anywhere. A `claude --settings` path
  // bug took six groups down this way; a Dispatcher that finished without filing a
  // card left a seventh in PLANNING the same afternoon. The queue being empty under
  // a live group IS the fault, whatever the last turn's exit code said. One
  // automatic retry, then the boss.
  const stalled = ctx.db
    .query<Job, []>(
      `SELECT j.id, j.kind, j.grp_id, j.agent_id, j.slice_id, j.payload_json, j.priority, j.state, j.error
       FROM job j JOIN grp g ON g.id = j.grp_id
       WHERE g.status IN ('RUNNING', 'PLANNING') AND j.kind = 'agent_turn'
         AND j.id = (SELECT max(id) FROM job WHERE grp_id = j.grp_id AND kind = 'agent_turn')
         AND NOT EXISTS (SELECT 1 FROM job k WHERE k.grp_id = j.grp_id AND k.state IN ('pending','running'))`,
    )
    .all();
  for (const j of stalled) {
    // Same one-shot guard as a restart: a turn that fails again after being put
    // back is not going to succeed on the third try either.
    if (resumeReclaimed(ctx.sched, [j]) > 0) continue;
    findings.push({
      rule: "stalled",
      grpId: j.grp_id,
      severity: "blocker",
      body: t("wd.stalled", { why: (j as any).error ?? "" }),
    });
  }
  // No tick here: the server ticks on the same timer that enqueued this watchdog,
  // so the re-queued turn goes out a beat later either way.

  // 9. Work queued for a group that is gone.
  //
  // Dropping and splitting both cancel what was pending, but a mail arriving a
  // moment later enqueues another one, and no status a dissolved group has is
  // dispatchable. It sits pending forever, counted in every "what is queued" view
  // the boss reads.
  const orphanQueued = ctx.db.run(
    `UPDATE job SET state = 'cancelled', ended_at = ?, error = 'the group was dissolved'
     WHERE state = 'pending' AND grp_id IN (SELECT id FROM grp WHERE status = 'DISSOLVED')`,
    [now()],
  );
  if (orphanQueued.changes > 0) {
    ctx.bus.emit({
      author: "orchestrator",
      kind: "state_change",
      body: `cancelled ${orphanQueued.changes} job(s) queued for a dissolved group`,
    });
  }

  // 11. A question stranded below the boss on a group that cannot answer it.
  //
  // route() sends these to the boss now, but only at the moment they are routed —
  // a group can stop *after* a question was handed to its PM, and every one filed
  // before that fix is still sitting where it was. The symptom is the worst kind:
  // a stopped group, and a 待办 count of zero.
  const stranded = ctx.db
    .query<{ id: number }, []>(
      // Blockers only, same reason route() lifts only blockers: an advisory that
      // nobody answers costs nothing, and a clearance denial is a JSON blob about
      // a tool call rather than a decision anyone can take.
      `SELECT e.id FROM escalation e JOIN grp g ON g.id = e.grp_id
       WHERE e.answer IS NULL AND e.severity = 'blocker'
         AND e.chain_state NOT IN ('boss', 'answered', 'revoked')
         AND g.status NOT IN ('PLANNING', 'RUNNING', 'PR_OPEN')`,
    )
    .all();
  for (const e of stranded) route({ ctx, git: deps.git, notifyBoss: ctx.notifyBoss }, e.id);

  // 10. The group it was waiting on has landed.
  //
  // `orch blocked` hands a defect outside a group's boundary to whoever can fix
  // it and stops the caller. Without this the caller waits forever: nothing else
  // in the system knows that one group's merge is another group's green light.
  const waiting = ctx.db
    .query<{ id: number; name: string; blocked_on: number }, []>(
      `SELECT g.id, g.name, g.blocked_on FROM grp g JOIN grp b ON b.id = g.blocked_on
       WHERE g.blocked_on IS NOT NULL AND b.status = 'DISSOLVED'`,
    )
    .all();
  for (const g of waiting) {
    ctx.db.run(
      "UPDATE grp SET status = 'RUNNING', paused_at = NULL, blocked_on = NULL WHERE id = ?",
      [g.id],
    );
    ctx.bus.emit({
      grpId: g.id,
      author: "orchestrator",
      kind: "state_change",
      body: t("group.unblocked", { target: String(g.blocked_on) }),
    });
    // Rule 8 above requeues a live group with an empty queue, so the turn itself
    // comes from there — this only has to make the group live again.
    findings.push({ rule: "unblocked", grpId: g.id, severity: "advisory", body: t("group.unblocked", { target: String(g.blocked_on) }) });
  }

  // 7. Paused too long: notify, then park to stop holding a slot.
  const paused = ctx.db
    .query<{ id: number; name: string; paused_at: number }, []>(
      // `rl_resets_at IS NULL`: a group waiting for quota is not waiting for the boss,
      // and parking it would retire its sessions minutes before it could resume.
      // `blocked_on IS NULL` for the same reason: it is waiting on another group,
      // not on anyone here, and parking would retire the sessions that are about to
      // be woken.
      `SELECT id, name, paused_at FROM grp
       WHERE status = 'PAUSED' AND paused_at IS NOT NULL AND rl_resets_at IS NULL AND blocked_on IS NULL`,
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

  // 12. A parked group whose question got answered after it stopped.
  //
  // `answer()` un-pauses PAUSED groups and silently skips PARKED ones, so a group
  // that waited long enough to be parked stayed parked even once the boss answered
  // the very thing it was waiting for — the boss answers, and watches nothing
  // happen. Parking is the only state the system puts a group into and never takes
  // it out of again: 唤醒 is a button and nothing else.
  //
  // Answered *after* it stopped, not merely "no open blocker": most parked groups
  // never had a blocker at all, and reviving those would undo the parking on the
  // same tick that did it.
  const revivable = ctx.db
    .query<{ id: number; name: string }, []>(
      `SELECT g.id, g.name FROM grp g WHERE g.status = 'PARKED' AND g.paused_at IS NOT NULL
         AND EXISTS (SELECT 1 FROM escalation e
                     WHERE e.grp_id = g.id AND e.severity = 'blocker'
                       AND e.answer IS NOT NULL AND e.answered_at > g.paused_at)
         AND NOT EXISTS (SELECT 1 FROM escalation e
                         WHERE e.grp_id = g.id AND e.answer IS NULL AND e.severity = 'blocker')`,
    )
    .all();
  for (const g of revivable) {
    if (!deps.ctx.git) break;
    await unpark(ctx, deps.ctx.git, g.id);
    findings.push({ rule: "unparked", grpId: g.id, severity: "advisory", body: t("wd.unparked", { name: g.name }) });
  }

  // 14. Parked and forgotten. It will not come back on its own and it will not ask
  // again, so the one thing owed is a reminder that says how long — 唤醒 and 不做了
  // are both one click from the requirement page.
  for (const g of ctx.db
    .query<{ id: number; name: string; paused_at: number }, [number]>(
      "SELECT id, name, paused_at FROM grp WHERE status = 'PARKED' AND paused_at IS NOT NULL AND paused_at < ?",
    )
    .all(now() - NUDGE_AFTER_MS)) {
    findings.push({
      rule: "waiting_parked",
      grpId: g.id,
      severity: "advisory",
      body: `${g.name} 封存了 ${Math.round((now() - g.paused_at) / 3_600_000)} 小时，唤醒还是不做了？`,
    });
  }

  // 13. The three places that wait on the boss, with a clock on each.
  //
  // DRAFT waiting for approval, a slice waiting to be accepted, and the head of
  // the merge queue are all supposed to wait — that is the design. What was missing
  // is that they wait in silence: three days later the system has still said
  // nothing, and the requirement is as stopped as if it had crashed.
  for (const w of waitingOnBoss(ctx.db, now())) findings.push(w);

  // A standing condition is re-detected on every tick, and emitting it every time
  // filled the timeline with the same line dozens of times over — "perf-rewrite is
  // at 102% of its budget", every few seconds, until the feed was worthless. The
  // notifier already backs off; the event log needs the same rule. A repeat is a
  // reminder, not a new problem.
  //
  // The returned list is filtered to the same set, not just the emitted events.
  // It is what the caller pushes to the boss's phone, and leaving it unfiltered
  // meant the timeline was deduplicated while the notifications were not — one
  // stalled group produced a push every thirty seconds, all night.
  const fresh: Finding[] = [];
  for (const f of findings) {
    const last = ctx.db
      .query<{ at: number }, [string, number | null, number | null]>(
        `SELECT max(at) AS at FROM event
         WHERE kind = 'escalation' AND author = 'watchdog'
           AND json_extract(meta_json, '$.rule') = ?
           AND (grp_id IS ? OR (grp_id IS NULL AND ? IS NULL))`,
      )
      .get(f.rule, f.grpId ?? null, f.grpId ?? null);
    const window = f.rule.startsWith("waiting_") ? NUDGE_REEMIT_MS : REEMIT_MS;
    if (last?.at && now() - last.at < window) continue;
    fresh.push(f);
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
  return fresh;
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
