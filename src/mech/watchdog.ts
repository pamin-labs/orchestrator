import type { Ctx } from "../api.ts";
import type { Config } from "../config.ts";
import { say } from "../lang.ts";
import { interrupt, park, unpark } from "./intercept.ts";
import { sweepApproved } from "./start.ts";
import { route } from "./chain.ts";
import { runInvariants } from "./invariants.ts";
import { NEWEST_ROLLOUT, pollUsage } from "./subusage.ts";
import { CODEX_HOME } from "./auth.ts";
import { execIn, killSandbox, renewSandbox, restartServer, runningServer, UTIL, utilSandbox, WORK, type Scope } from "./sandbox.ts";
import { baseRefFor, sandboxGit, treeFiles } from "./checkout.ts";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { buildMap, renderMap, saveMap } from "./repomap.ts";
import { resumeReclaimed, type Job } from "../scheduler.ts";
import { abortJob } from "../runtime/running.ts";
import { probe } from "./net.ts";

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
  now?: () => number;
  /** The only network call on the tick. Tests pass a no-op; see the call site. */
  pollUsage?: typeof pollUsage;
  /** Whether this machine can reach the providers. Injected for the same reason. */
  probe?: typeof probe;
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
 * How often the codex rollout sweep reaches into the containers.
 *
 * A seven-day retention window enforced hourly, not twice a minute. The tick is
 * 30s and `commands.run` is ~1s, so per-tick meant ten seconds of every thirty
 * spent on ten `find`s that delete nothing — and spent inside the containers,
 * against the CPU the agents are capped at.
 */
export const SWEEP_EVERY_MS = 60 * 60 * 1000;

// ponytail: in-memory, like `lastFetch` above. A restart sweeps once more than it
// needed to, which is a `find` that finds nothing.
let lastSweep = 0;

/**
 * How the sandbox server was last seen running, and how hard we have tried.
 *
 * In memory rather than a row, deliberately: the case this serves is "it died
 * while we were watching", which is exactly the case where we have seen it. An
 * orchestrator that boots with the server already down has never seen an argv,
 * says nothing, and leaves it to preflight and the boss's button — which is the
 * right answer, because a command line we did not observe is a guess.
 */
let seenServerArgv: string[] | null = null;
let serverRestarts = 0;
let nextServerTry = 0;

/** Three, then it is a person's problem. */
export const SERVER_RESTART_CAP = 3;

/** Tests, and the boss's button: a deliberate restart clears the automatic count. */
export function resetServerRestarts(): void {
  seenServerArgv = null;
  serverRestarts = 0;
  nextServerTry = 0;
}

/**
 * Whether to restart the sandbox server, as a decision with no side effects.
 *
 * Pulled out of the rule so the one guarantee that matters can be checked without
 * a process to kill: **`present` is never `restart`**. A server that is up and
 * refusing — a bad key, a crash loop — is the case where restarting produces a
 * restart loop, and it is indistinguishable from a healthy one at this level, so
 * the answer at this level is always "not mine".
 */
export function serverAction(
  present: boolean,
  seenArgv: string[] | null,
  restarts: number,
  now: number,
  nextTry: number,
): "none" | "restart" | "give_up" {
  if (present) return "none";
  // Never seen it up, so we do not know the command. Preflight reports it.
  if (!seenArgv?.length) return "none";
  if (now < nextTry) return "none";
  return restarts >= SERVER_RESTART_CAP ? "give_up" : "restart";
}

/** 30s, 2min, 8min. A server that needs three tries needs a person. */
export const serverBackoffMs = (attempt: number): number => 30_000 * 4 ** (attempt - 1);

/** Projects already told about, so the repo-map failure is said once, not per tick. */
const mapWarned = new Set<number>();


/**
 * Backstop, and a shorter shelf life.
 *
 * The executor now gzips a turn log the moment the turn ends, so the sweep only
 * meets files a crash left behind — hence the hour rather than the day. A week is
 * enough: these are read by a person diagnosing something that just happened, and
 * 365 files had grown to 59 MB.
 */
export const GZIP_AFTER_MS = 60 * 60 * 1000;
export const DROP_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * codex writes a full transcript per session into the CODEX_HOME we hand it.
 * Nothing ever removed them: 78 rollout files and 110 MB in two days, next to a
 * turn-log directory that has had gzip and a retention window since the
 * beginning. Same window here, no compression — these are read by codex itself
 * on resume, and only while the thread is live.
 *
 * Two places now, and this one is the smaller: since 005 `CODEX_HOME` is
 * `/root/.codex` *inside a container*, so what is left on the host is the weekly
 * refresh nudge's own rollouts. The 110 MB grows in the sandboxes, and
 * `sweepSandboxSessions` below is what reaches it.
 */
export function sweepCodexSessions(home: string, now: number): number {
  const root = join(home, "sessions");
  if (!existsSync(root)) return 0;
  let dropped = 0;
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      try {
        const s = statSync(p);
        if (s.isDirectory()) walk(p);
        else if (now - s.mtimeMs > DROP_AFTER_MS) {
          rmSync(p, { force: true });
          dropped++;
        }
      } catch {}
    }
  };
  try {
    walk(root);
  } catch {}
  return dropped;
}

export function sweepTurnLogs(dir: string, now: number): { zipped: number; dropped: number } {
  let zipped = 0;
  let dropped = 0;
  if (!existsSync(dir)) return { zipped, dropped };
  for (const f of readdirSync(dir)) {
    const path = join(dir, f);
    let age: number;
    try {
      age = now - statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (f.endsWith(".gz")) {
      if (age > DROP_AFTER_MS) {
        rmSync(path, { force: true });
        dropped++;
      }
      continue;
    }
    if (!f.endsWith(".jsonl") || age < GZIP_AFTER_MS) continue;
    try {
      writeFileSync(`${path}.gz`, gzipSync(readFileSync(path)));
      rmSync(path, { force: true });
      zipped++;
    } catch {
      // A log that will not compress is not worth failing a watchdog tick over.
    }
  }
  return { zipped, dropped };
}

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

/**
 * Every sandbox there is right now, groups and projects both.
 *
 * Used by the two things that have to reach *into* a container rather than
 * manage it — the codex session sweep and the quota read. Both are best-effort
 * and neither cares which sandbox answers.
 */
function liveScopes(ctx: Ctx): Scope[] {
  const out: Scope[] = [];
  for (const g of ctx.db
    .query<{ id: number }, []>(
      "SELECT id FROM grp WHERE sandbox_id IS NOT NULL AND status NOT IN ('DISSOLVED','PARKED')",
    )
    .all()) {
    out.push({ grp: g.id });
  }
  for (const p of ctx.db.query<{ id: number }, []>("SELECT id FROM project WHERE sandbox_id IS NOT NULL").all()) {
    out.push({ project: p.id });
  }
  return out;
}

/**
 * The tick, and a promise that it always comes back.
 *
 * `runWatchdog` is straight-line async: one `throw` anywhere in it and every rule
 * after that point is skipped — and `invariants.ts` names the watchdog as the
 * `driver` for about twelve states, so a throw at rule 7e silently un-drives the
 * unwedge rule, the sandbox reaper, the TTL renewal, the stale-credential
 * rebuild, the rebase nudge and every clock the boss is waiting on. That is what
 * happened: `Bun.spawn` throws when `cwd` does not exist, `repo_path` stopped
 * being a directory, and the tick died at the first project row.
 *
 * The silence was the other half. `Scheduler.settle` writes `state='failed'` on
 * the job row and emits nothing, and the server enqueues a fresh tick regardless
 * — so it failed every thirty seconds with nothing anywhere saying so.
 *
 * The throw itself is fixed at its source (`makeGitRunner` returns a code now).
 * This is the guarantee that the next one does not get to be quiet: whatever
 * escapes comes back as a finding, in the feed, with the findings collected
 * before it.
 */
export async function runWatchdog(deps: WatchdogDeps): Promise<Finding[]> {
  const findings: Finding[] = [];
  try {
    return await rules(deps, findings);
  } catch (e: any) {
    // `rules` emits at its end, and we never got there — so this one is emitted
    // here, or the outage stays exactly as quiet as it was before.
    const broke: Finding = {
      rule: "watchdog_broke",
      grpId: null,
      severity: "blocker" as const,
      body:
        `看门狗这一轮挂了，后面的规则都没跑：${e?.message ?? e}\n` +
        `每 30 秒都会再试一次，但在修好之前，靠它推的那些状态（卡住的组、过期的沙盒、` +
        `基线变了要 rebase、等你决定的计时）都停在原地。`,
    };
    deps.ctx.bus.emit({
      grpId: null,
      author: "watchdog",
      kind: "escalation",
      intent: "ask",
      severity: "blocker",
      body: broke.body,
      meta: { rule: broke.rule },
    });
    return [...findings, broke];
  }
}

async function rules(deps: WatchdogDeps, findings: Finding[]): Promise<Finding[]> {
  const { ctx, cfg } = deps;
  // These bodies land in the boss's feed and notifications, so they follow
  // output.language. Feedback aimed at an agent stays English: it lands in a prompt
  // next to code and gate output.
  const t = (k: any, a?: any) => say(ctx.config?.language, k, a);
  const now = deps.now ?? (() => Date.now());

  // 19. The machine's own network, before anything that needs it.
  //
  // A laptop closes, a VPN drops. Without this every turn in flight burns its
  // wall clock retrying, rule 1 interrupts each group into PAUSED, and PAUSED is
  // a state nothing leaves on its own — so coming back online means a fleet of
  // paused groups and a park timer filing them away. The gate in the scheduler
  // does the holding; this decides when it is on and deals with what was already
  // running.
  const net = await (deps.probe ?? probe)(ctx.db, now());
  if (net.changed) {
    const held = net.online ? 0 : holdForOffline(ctx, now());
    ctx.bus.emit({
      author: "orchestrator",
      kind: "state_change",
      body: net.online ? t("net.back") : t("net.lost", { n: held }),
    });
    findings.push({
      rule: net.online ? "network_back" : "network_lost",
      grpId: null,
      severity: net.online ? "advisory" : "blocker",
      body: net.online ? t("net.back") : t("net.lost", { n: held }),
    });
    if (net.online) ctx.sched.tick();
  }
  // Everything below this line either talks to the network or drives work that
  // does, so an offline tick stops here. The rules are all restatements of state
  // we recorded ourselves; none of them is worth a two-second DNS timeout each.
  if (!net.online) return emit(ctx, findings, now);

  // Liveness first: one row per state, each saying who pushes it (invariants.ts).
  // The rules below are the other question — not "is anybody driving this" but
  // "is this healthy" — and keeping the two apart is what stops either from
  // becoming a dumping ground.
  runInvariants(ctx);

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
    if (j.grp_id) await interrupt(ctx, j.grp_id, "keep");
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
          `INSERT INTO escalation (grp_id, severity, question, brief, chain_state, created_at)
           VALUES (?, 'blocker', ?, '预算烧穿了，加不加', 'boss', unixepoch() * 1000)`,
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

  // 7d2. Turn logs, compressed then dropped.
  //
  // Ten requirements produced 123 MB of raw NDJSON, median 324 KB a turn and 3 MB
  // at the tail, because a turn's transcript is mostly tool output and all of it is
  // written verbatim. It is worth keeping — every measurement in PROGRESS.md came
  // out of these files — but not worth keeping uncompressed: NDJSON gzips about
  // ten to one, and nothing reads a turn from a week ago without unzipping it
  // first anyway.
  sweepTurnLogs(join(cfg.dataDir, "turns"), now());
  sweepCodexSessions(join(cfg.dataDir, "codex-home"), now());

  // 7d2b. The same sweep, in the containers where the files actually are.
  //
  // Hourly, and in parallel. The first version ran one `execIn` per live sandbox
  // on every 30s tick, serially: `commands.run` is ~1s, so ten groups meant ten
  // seconds of every thirty spent deleting nothing, competing with the agents for
  // the CPU their own containers are capped at. It is a seven-day retention
  // window — it does not need to be enforced twice a minute.
  if (now() - lastSweep >= SWEEP_EVERY_MS) {
    lastSweep = now();
    await Promise.allSettled(
      liveScopes(ctx).map((s) =>
        execIn(ctx, s, `find ${CODEX_HOME}/sessions -type f -mtime +7 -delete 2>/dev/null || true`),
      ),
    );
  }

  // 7d3. How much of the claude subscription is left.
  //
  // codex reports both its windows in every turn; claude's stream reports none,
  // so the only way to put the two side by side in the header is to ask. Rate
  // limited to five minutes inside, and it swallows its own failures — the
  // endpoint is undocumented and nothing here may depend on it.
  // Injectable, because it is the one thing in this tick that talks to the
  // network. `test/watchdog.test.ts` ran it for real: the endpoint hung on its
  // 10s timeout inside a gate sandbox, the test blew bun's 5s limit, and the
  // slice was rejected for a red test that had nothing to do with its change.
  // Two slices lost to it, on two different requirements.
  await (deps.pollUsage ?? pollUsage)(ctx.db, cfg.dataDir, now(), async () => {
    // The fleet's own rollouts live in the sandboxes now; the host copy is only
    // as fresh as the last weekly refresh nudge. Any one live sandbox will do —
    // the quota is the account's, not the container's.
    for (const s of liveScopes(ctx)) {
      const r = await execIn(ctx, s, NEWEST_ROLLOUT).catch(() => null);
      if (r?.code === 0 && r.out.trim()) return r.out;
    }
    return null;
  });

  // 7e. Keep the shared repo map current.
  //
  // Deterministic and cheap — `git ls-files` plus a regex per file — and only
  // written when the render changed, so a quiet repo costs one comparison. This is
  // the thing seven groups were each rediscovering by grep.
  for (const p of ctx.db
    .query<{ id: number; repo_path: string; remote: string | null }, []>(
      "SELECT id, repo_path, remote FROM project",
    )
    .all()) {
    const files = p.remote ? await treeFiles(ctx, p.remote, await baseRefFor(ctx, p.id)) : [];
    // The mirror is the corpus now. Nothing to list means no mirror could be
    // built — said once per project rather than never (the map silently stops
    // being refreshed and seven groups go back to grepping) and rather than
    // every tick (a line every thirty seconds forever is a feed nobody reads).
    if (!files.length) {
      if (!mapWarned.has(p.id)) {
        mapWarned.add(p.id);
        findings.push({
          rule: "repo-map",
          grpId: null,
          severity: "advisory",
          body: `仓库地图没法刷新了：${p.repo_path} 的镜像建不起来（工具容器起不来，或者这个登录读不到这个仓库）。`,
        });
      }
      continue;
    }
    mapWarned.delete(p.id);
    if (saveMap(ctx.db, p.id, renderMap(buildMap(p.repo_path, () => files)))) {
      ctx.bus.emit({ author: "librarian", kind: "state_change", body: `repo map refreshed (${files.length} files)` });
    }
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
    // A rebase that beat the Engineer twice is a design question, not a harder
    // rebase. It only reaches here after failing with the fork spelled out, so the
    // next thing to try is the role that can say whether the slice still makes
    // sense — not the same role with more determination.
    //
    // `conflict` marks a turn that was *told* to rebase (rule 15), not one that
    // failed to. Reading the flag alone turned every successful rebase into a
    // design escalation the moment the queue went quiet: pm-ai-agent got the same
    // "The Engineer could not rebase this branch onto main" eight times, all eight
    // false, and its Architect burned a turn refuting each one. A turn that ended
    // `done` is a stall — that is the branch below, and it was always the right one.
    let payload: any = {};
    try { payload = JSON.parse(j.payload_json); } catch {}
    if (payload?.conflict && j.state === "failed") {
      ctx.sched.enqueue("agent_turn", {
        grp_id: j.grp_id,
        priority: 6,
        payload: {
          role: "architect",
          rejection:
            `The Engineer could not rebase this branch onto main. Decide what it means: is the slice still ` +
            `what we want now that main has moved, does the boundary need re-cutting, or should it be dropped? ` +
            `Say so on the blackboard and mail the group.\n\n${j.error ?? ""}`,
        },
      });
      continue;
    }
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
  for (const e of stranded) route({ ctx, notifyBoss: ctx.notifyBoss }, e.id);

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
    await unpark(ctx, g.id);
    findings.push({ rule: "unparked", grpId: g.id, severity: "advisory", body: t("wd.unparked", { name: g.name }) });
  }

  // 15. The group's base moved while it is still working.
  //
  // `landGroup` tells the groups still in the merge queue to rebase, which covers
  // the case where another group merged. It does not cover the boss pushing to
  // main directly — and that is the common case, since the boss is a person with a
  // terminal. Six groups spent a day building on a base fifteen commits stale, and
  // every one of them would have found out at PR time, one conflict at a time.
  //
  // Told once per base: `rebase_seen` records what the group has already been
  // warned about, so a group that reads the message and keeps working is not
  // nagged every thirty seconds.
  //
  // PR_OPEN counts. Its branch is the one thing that has to merge, and it used to
  // be excluded — so a stale PR sat in the queue until GitHub called it
  // CONFLICTING, which is the late half of the same news.
  for (const g of ctx.db
    .query<{ id: number; name: string; repo: string; seen: string | null; project_id: number }, []>(
      `SELECT g.id, g.name, p.repo_path AS repo, g.rebase_seen AS seen, g.project_id
       FROM grp g JOIN project p ON p.id = g.project_id
       WHERE g.status IN ('RUNNING','PR_OPEN') AND g.sandbox_id IS NOT NULL
         -- Coalesce on the nudge that is already queued, not on a clock. Three
         -- pushes a minute apart were three shas and three rebase turns; a timer
         -- would fix that by making a group wait to be told, and a group whose PR
         -- is blocked on a rebase must not wait at all. If the turn is still
         -- pending it will rebase onto whatever main is when it runs.
         AND NOT EXISTS (SELECT 1 FROM job j WHERE j.grp_id = g.id AND j.state = 'pending'
                           AND j.kind = 'agent_turn' AND j.payload_json LIKE '%"conflict":true%')`,
    )
    .all()) {
    // Against the real base, and asked of GitHub rather than of a checkout on
    // this machine — there is none since 007 step 6. One conditional request per
    // group per tick, and a repeat is a 304, which does not count against the
    // rate limit. Main also moves when somebody pushes from another machine,
    // which is the case a local `rev-parse` could never see.
    const baseRef = await baseRefFor(ctx, g.project_id);
    const branch = baseRef.startsWith("origin/") ? baseRef.slice("origin/".length) : baseRef;
    const head = await ctx.gh?.request<{ commit?: { sha?: string } }>(
      "GET",
      `/repos/${g.repo}/branches/${branch}`,
    );
    const sha = head?.ok ? (head.data?.commit?.sha ?? "") : "";
    if (!sha || sha === g.seen) continue;
    // The clone has to know the object before it can be asked about it. It is a
    // separate `git clone` that never fetched, so `merge-base --is-ancestor`
    // exited non-zero for "I have never heard of that commit" exactly as it does
    // for "you are behind it" — the same code, two different facts, and the
    // rebase nudge could not tell them apart. Fetch first, and then a non-zero
    // answer means what it says.
    const gitIn = sandboxGit(ctx, { grp: g.id });
    const known = await gitIn(WORK, ["cat-file", "-e", `${sha}^{commit}`], WORK);
    if (known.code !== 0) {
      const fetched = await gitIn(WORK, ["fetch", "--quiet", "origin"], WORK);
      // Still unknown after a fetch: the clone cannot see this base at all, which
      // is a checkout problem and not something a rebase turn would fix.
      if (fetched.code !== 0) continue;
      if ((await gitIn(WORK, ["cat-file", "-e", `${sha}^{commit}`], WORK)).code !== 0) continue;
    }
    const merged = await gitIn(WORK, ["merge-base", "--is-ancestor", sha, "HEAD"], WORK);
    if (merged.code === 0) continue; // already on it

    ctx.db.run("UPDATE grp SET rebase_seen = ?, rebase_seen_at = ? WHERE id = ?", [sha, now(), g.id]);
    const remoteBranch = baseRef.startsWith("origin/") ? baseRef.slice("origin/".length) : null;
    const fetchStep = remoteBranch ? `\`git fetch origin ${remoteBranch}\` then ` : "";
    ctx.sched.enqueue("agent_turn", {
      grp_id: g.id,
      priority: 4,
      payload: {
        role: "engineer",
        conflict: true,
        rejection:
          `${baseRef} moved to ${sha.slice(0, 8)} and this branch is behind it. Rebase now rather than at PR time — ` +
          `${fetchStep}\`git rebase ${baseRef}\`, then carry on. ` +
          `If ${baseRef} removed or reshaped something this slice was built on, STOP and say which premise is gone ` +
          `with \`orch ask-boss\`; that reaches the Architect.`,
      },
    });
    findings.push({
      rule: "base_moved",
      grpId: g.id,
      severity: "advisory",
      body: `${baseRef} 动到了 ${sha.slice(0, 8)}，${g.name} 的基线落后了，已经让它先 rebase`,
    });
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

  // 17. A dissolved group's sandbox.
  //
  // Two containers per group — the sandbox and its egress sidecar — and neither
  // goes away on its own until the TTL runs out, which is a day. DISSOLVED means
  // the work is either merged or dropped, so nothing in there is wanted; what is
  // left is memory, CPU and disk held against every group that comes next.
  //
  // `pause` is not the cheap alternative it looks like: measured, it is a real
  // `docker pause`, so the container and its disk both stay (docs/decisions/005).
  // Only kill frees anything.
  for (const g of ctx.db
    .query<{ id: number; name: string }, []>(
      `SELECT id, name FROM grp WHERE status = 'DISSOLVED' AND sandbox_id IS NOT NULL`,
    )
    .all()) {
    await killSandbox(ctx, { grp: g.id });
    findings.push({
      rule: "sandbox_swept",
      grpId: g.id,
      severity: "advisory",
      body: `${g.name} 解散了，沙盒回收`,
    });
  }

  // 17b. A sandbox older than the credential it is supposed to be using.
  //
  // A sidecar is loaded once, when its sandbox is built, and never again — so
  // storing a credential has to kill the running sandboxes, and exactly one of
  // the two ways to store one did. A login from the panel saved the token and
  // stopped, so every group kept a sidecar bound to the credential that was
  // still missing and every turn came back `Authentication credentials are
  // invalid` against a token that was perfectly good.
  //
  // Both callers do the right thing now, and that is still not the fix: the next
  // way to store a credential — an import, a refresh, a CLI — would have to
  // remember, and this is the class of bug where forgetting looks healthy. The
  // durable form is a fact about the row, checked here, true no matter which
  // path stored it, for every project that will ever be added.
  const newestCredential =
    ctx.db.query<{ at: number | null }, []>("SELECT max(updated_at) at FROM runtime_auth").get()?.at ?? 0;
  if (newestCredential) {
    for (const g of ctx.db
      .query<{ id: number; name: string }, [number]>(
        // Not the dissolved ones: the sweep above already took theirs, and
        // killing the same container twice is a finding the boss cannot act on.
        `SELECT id, name FROM grp
         WHERE sandbox_id IS NOT NULL AND status <> 'DISSOLVED' AND coalesce(sandbox_at, 0) < ?`,
      )
      .all(newestCredential)) {
      await killSandbox(ctx, { grp: g.id });
      findings.push({
        rule: "sandbox_stale_credential",
        grpId: g.id,
        severity: "advisory",
        body: `${g.name} 的沙盒绑的是旧凭据，回收了，下一轮重建`,
      });
    }
    for (const p of ctx.db
      .query<{ id: number }, [number]>(
        `SELECT id FROM project WHERE sandbox_id IS NOT NULL AND coalesce(sandbox_at, 0) < ?`,
      )
      .all(newestCredential)) {
      await killSandbox(ctx, { project: p.id });
    }
    // The utility container is the one that matters most here: its sidecar holds
    // the GitHub token, so a rotated login leaves it pushing with the old one —
    // and a push refused for authentication is exactly the boss-bucket failure
    // 007 §6 says must never present as an agent problem.
    const util = utilSandbox(ctx.db);
    if (util.id && util.at < newestCredential) await killSandbox(ctx, UTIL);
  }

  // 18. A live container expiring under whatever is using it.
  //
  // The TTL is what stops a crashed orchestrator leaking containers forever, so
  // it has to be short enough to matter and therefore short enough to reap a
  // group that is simply thinking. Renewing on every tick is the other half of
  // that bargain: while something is watching, nothing expires.
  //
  // One loop over every kind there is, deliberately. This walked `grp` only, and
  // the project containers had to be added when the index moved into one; adding
  // a third loop for the utility container would guarantee the same omission a
  // third time. `renewSandbox` is a no-op for a scope with no container, so the
  // list can be built without asking which of them exist.
  const alive: Scope[] = [
    ...ctx.db
      .query<{ id: number }, []>(
        `SELECT id FROM grp WHERE status IN ('RUNNING','PR_OPEN','PAUSED') AND sandbox_id IS NOT NULL`,
      )
      .all()
      .map((g) => ({ grp: g.id })),
    ...ctx.db
      .query<{ id: number }, []>("SELECT id FROM project WHERE sandbox_id IS NOT NULL")
      .all()
      .map((p) => ({ project: p.id })),
    UTIL,
  ];
  for (const scope of alive) await renewSandbox(ctx, scope);

  // 19. The sandbox server is gone.
  //
  // Narrow on purpose. Three states look identical from the panel and want three
  // different answers: **absent** (restart it), **present but refusing** — a bad
  // key, a crash loop — where a restart only makes a restart loop, and **present
  // and healthy on stale config**, which is not a restart problem at all and is
  // reported by preflight's `allowed_host_paths` check.
  //
  // So this fires on absence and nothing else. Two more guards, because an
  // automatic action that keeps trying is how a crash loop becomes an outage:
  //
  // - only from an argv we have **seen** this process run. How the boss starts it
  //   (uvx, a venv, a wrapper, extra flags) is theirs, and a composed command
  //   line would start a second, differently-configured server beside the wedged
  //   one. Never seen it up means we say nothing — preflight already reports a
  //   server that is not there, and guessing is worse than reporting.
  // - a hard cap. On reaching it this stops and escalates, because N failed
  //   restarts is evidence that restarting is not the answer.
  const server = runningServer();
  if (server?.argv.length) {
    seenServerArgv = server.argv;
    serverRestarts = 0;
  }
  switch (serverAction(!!server, seenServerArgv, serverRestarts, now(), nextServerTry)) {
    case "give_up":
      nextServerTry = now() + REEMIT_MS;
      findings.push({
        rule: "server_gone",
        grpId: null,
        severity: "blocker",
        body:
          `opensandbox-server 起不来了，试了 ${SERVER_RESTART_CAP} 次，不再自动重试。` +
          `手动跑一次看它报什么：${seenServerArgv!.join(" ")}`,
      });
      break;
    case "restart": {
      serverRestarts++;
      nextServerTry = now() + serverBackoffMs(serverRestarts);
      const err = await restartServer(seenServerArgv!);
      findings.push({
        rule: "server_restarted",
        grpId: null,
        severity: err ? "blocker" : "advisory",
        body: err
          ? `opensandbox-server 没了，重启失败（第 ${serverRestarts} 次）：${err}`
          : `opensandbox-server 没了，重启了（第 ${serverRestarts} 次）。挂起的活会自己继续。`,
      });
      break;
    }
  }

  // 16. A question the work has already gone past.
  //
  // `review.ts` files a blocker when a slice fails QA three times, and it is
  // right to: the acceptance criteria are usually wrong. But nothing closes it if
  // the group recovers — the slice is re-run, accepted, the branch goes to PR —
  // and the question sits in 待办 forever asking the boss to unblock a group that
  // is finished. Live: src-mech-watchdog-ts had an open blocker and a merge-ready
  // PR on the same requirement, in the same list.
  //
  // A group at PR_OPEN or DISSOLVED has no caller left to unblock. Answering it
  // would change nothing, so the queue must stop asking.
  for (const e of ctx.db
    .query<{ id: number; grp_id: number; name: string }, []>(
      `SELECT e.id, e.grp_id, g.name FROM escalation e JOIN grp g ON g.id = e.grp_id
       WHERE e.chain_state NOT IN ('answered','revoked') AND g.status IN ('PR_OPEN','DISSOLVED')`,
    )
    .all()) {
    ctx.db.run(
      `UPDATE escalation SET chain_state = 'revoked', answered_by = 'orchestrator',
         answer = ?, answered_at = unixepoch() * 1000 WHERE id = ?`,
      ["这条需求已经走到 PR，问题过期了，没人再等这个答复。", e.id],
    );
    // Whatever asked is long gone, but a waiter left hanging keeps a job row alive.
    const w = ctx.waiters.get(`escalation:${e.id}`);
    ctx.waiters.delete(`escalation:${e.id}`);
    w?.("stale: the group reached PR");
    findings.push({
      rule: "stale_ask",
      grpId: e.grp_id,
      severity: "advisory",
      body: `${e.name} 已经走到 PR，那条还挂着的问题过期了，自动关掉`,
    });
  }

  // 13. The three places that wait on the boss, with a clock on each.
  //
  // DRAFT waiting for approval, a slice waiting to be accepted, and the head of
  // the merge queue are all supposed to wait — that is the design. What was missing
  // is that they wait in silence: three days later the system has still said
  // nothing, and the requirement is as stopped as if it had crashed.
  for (const w of waitingOnBoss(ctx.db, now())) findings.push(w);

  return emit(ctx, findings, now);
}

/**
 * A standing condition is re-detected on every tick, and emitting it every time
 * filled the timeline with the same line dozens of times over — "perf-rewrite is
 * at 102% of its budget", every few seconds, until the feed was worthless. The
 * notifier already backs off; the event log needs the same rule. A repeat is a
 * reminder, not a new problem.
 *
 * The returned list is filtered to the same set, not just the emitted events.
 * It is what the caller pushes to the boss's phone, and leaving it unfiltered
 * meant the timeline was deduplicated while the notifications were not — one
 * stalled group produced a push every thirty seconds, all night.
 */
function emit(ctx: Ctx, findings: Finding[], now: () => number): Finding[] {
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
 * Stop every turn that is in flight, and put the work straight back on the queue.
 *
 * Doing nothing is the trap: the CLI backs off and retries until `turnTimeoutMs`,
 * rule 1 interrupts the group into PAUSED, and a PAUSED group is one nothing
 * resumes — the park timer files it away and the boss finds a fleet to restart by
 * hand once the connection is back.
 *
 * So the job is cancelled and re-queued and **the group's status is not touched**.
 * It stays RUNNING with pending work, the scheduler's offline gate holds that
 * work, and when the gate lifts the queue drains on the next tick. That is the
 * whole of "pause" and "resume": no new state, nothing to remember.
 */
export function holdForOffline(ctx: Ctx, now: number): number {
  const running = ctx.db
    .query<Job & { started_at: number | null }, []>(
      `SELECT id, kind, grp_id, agent_id, slice_id, payload_json, priority, state
       FROM job WHERE state = 'running' AND kind = 'agent_turn'`,
    )
    .all();
  if (running.length === 0) return 0;

  for (const j of running) {
    abortJob(j.id);
    ctx.db.run("UPDATE job SET state = 'cancelled', ended_at = ?, error = ? WHERE id = ?", [
      now,
      "offline: the host lost its network",
      j.id,
    ]);
  }
  // An agent that believes it is mid-turn is skipped forever by everything else.
  ctx.db.run("UPDATE agent SET state = 'idle' WHERE state = 'running'");
  // `resumeReclaimed` exempts an `offline:` error from the one-retry rule for the
  // same reason it exempts `orphaned:`: the turn did nothing wrong.
  return resumeReclaimed(ctx.sched, running.map((j) => ({ ...j, state: "cancelled" as const, error: "offline: the host lost its network" })));
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
