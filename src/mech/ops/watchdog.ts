import { jsonOr } from "../../contracts/json.ts";
import { errText, hours, minutes } from "../../platform/process/text.ts";
import type { Ctx } from "../../mech/ctx.ts";
import type { Config } from "../../platform/config/load.ts";
import { say, type SayKey } from "../../platform/text/lang.ts";
import { hold, interrupt, park, release, unpark } from "../flow/intercept.ts";
import { sweepApproved } from "../flow/start.ts";
import { raise } from "../flow/escalate.ts";
import { route } from "../flow/chain.ts";
import { runInvariants } from "./invariants.ts";
import { NEWEST_ROLLOUT, pollUsage } from "./subusage.ts";
import { CODEX_HOME } from "../sandbox/auth.ts";
import {
  execIn,
  EXEC_FANOUT,
  killSandbox,
  renewSandbox,
  pidAlive,
  restartServer,
  runningServer,
  UTIL,
  utilSandbox,
  WORK,
  type Scope,
} from "../sandbox/sandbox.ts";
import { baseBranch, baseRefFor, listTree, sandboxGit, treeHeads } from "../git/checkout.ts";
import { serverLogPath } from "../sandbox/server.ts";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { buildMap, indexExcludes, renderMap, saveMap } from "../knowledge/repomap.ts";
import { resumeReclaimed, type Job } from "../../platform/scheduling/scheduler.ts";
import { abortJob } from "../../platform/process/running-turns.ts";
import { probe } from "../sandbox/net.ts";
import { activeTracer } from "../../platform/observability/traces.ts";
import { SpanStatusCode } from "@opentelemetry/api";
import { readSetting, writeSetting } from "../../platform/persistence/database.ts";
import { Cron } from "croner";
import pMap from "p-map";
import { z } from "zod";
import {
  ACTIVE_JOB_STATES,
  ANSWERLESS_GRP_STATES,
  DISPATCHABLE_GRP_STATES,
  ESCALATION_TERMINAL_STATES,
  stateParam,
  type GrpState,
} from "../../contracts/states.ts";

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
  /** Is the sandbox server up. The only subprocess on the tick, and the most
   *  expensive thing in it. Injected for the same reason as the two above. */
  runningServer?: typeof runningServer;
}

export interface Finding {
  rule: string;
  grpId: number | null;
  body: string;
  severity: "advisory" | "blocker";
}

export const IDLE_TURN_LIMIT = 3;
export const SAME_FILE_LIMIT = 5;
const PAUSED_NOTIFY_MS = 15 * 60 * 1000;
/** How often one standing finding may reappear in the timeline. */
export const REEMIT_MS = 30 * 60 * 1000;
/** How long one of the boss's own decisions may sit before it is worth a word. */
const NUDGE_AFTER_MS = 4 * 60 * 60 * 1000;
/** And how often to say it again. Nagging every half hour is how a feed is ignored. */
const NUDGE_REEMIT_MS = 6 * 60 * 60 * 1000;

/**
 * How the sandbox server was last seen running, and how hard we have tried.
 *
 * In memory rather than a row: the case this serves is "it died while we were
 * watching". An orchestrator that boots with the server already down has never
 * seen an argv, says nothing, and leaves it to preflight and the boss's button —
 * a command line we did not observe is a guess.
 */
let seenServerArgv: string[] | null = null;
/** Its pid, so the steady state is a `kill(pid, 0)` rather than a forked `ps`. */
let seenServerPid: string | null = null;
let serverRestarts = 0;
let nextServerTry = 0;

/** Three, then it is a person's problem. */
export const SERVER_RESTART_CAP = 3;

/** Tests, and the boss's button: a deliberate restart clears the automatic count. */
export function resetServerRestarts(): void {
  seenServerArgv = null;
  seenServerPid = null;
  serverRestarts = 0;
  nextServerTry = 0;
}

/**
 * Whether to restart the sandbox server, as a decision with no side effects.
 *
 * Pulled out of the rule so the one guarantee that matters can be checked without
 * a process to kill: **`present` is never `restart`**. A server that is up and
 * refusing — a bad key, a crash loop — is indistinguishable from a healthy one at
 * this level, and restarting it produces a restart loop.
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

/**
 * Is the sandbox server there, and remember how to restart it if it is.
 *
 * The steady state — up, and seen before — is one `kill(pid, 0)` and no
 * subprocess. `ps` runs only when that says the pid is gone, which is also the
 * only moment its argv is worth re-reading. A reused pid reads as alive: the
 * conservative side, since the alternative is restarting a live server.
 */
function serverPresent(deps: WatchdogDeps): boolean {
  if (seenServerPid !== null && pidAlive(seenServerPid)) return true;
  const server = (deps.runningServer ?? runningServer)();
  if (!server?.argv.length) return !!server;
  seenServerArgv = server.argv;
  seenServerPid = server.pid;
  return true;
}

/** 30s, 2min, 8min. A server that needs three tries needs a person. */
export const serverBackoffMs = (attempt: number): number => 30_000 * 4 ** (attempt - 1);

/** Projects already told about, so the repo-map failure is said once, not per tick. */
const mapWarned = new Set<number>();

/**
 * Backstop, and a shorter shelf life.
 *
 * The executor gzips a turn log the moment the turn ends, so the sweep only meets
 * files a crash left behind — hence the hour rather than the day. A week is
 * enough: these are read by a person diagnosing something that just happened.
 */
export const GZIP_AFTER_MS = 60 * 60 * 1000;
export const DROP_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Compress one turn log and drop the raw file. Reports whether it did.
 *
 * The sweep below is the *backstop* for the executor's own copy of this, so the
 * two have to agree on the name the compressed file gets — otherwise the backstop
 * compresses an already-compressed log and `DROP_AFTER_MS` never sees the result.
 */
export function gzipTurnLog(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    writeFileSync(`${path}.gz`, gzipSync(readFileSync(path)));
    rmSync(path, { force: true });
    return true;
  } catch {
    // A log that will not compress is not worth failing a turn, or a tick, over.
    return false;
  }
}

/**
 * codex writes a full transcript per session into the CODEX_HOME we hand it, and
 * nothing ever removed them. Same window as the turn logs, no compression — these
 * are read by codex itself on resume, and only while the thread is live.
 *
 * The smaller of two places: since 005 `CODEX_HOME` is `/root/.codex` *inside a
 * container*, so the host keeps only the weekly refresh nudge's own rollouts.
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
    if (gzipTurnLog(path)) zipped++;
  }
  return { zipped, dropped };
}

/**
 * The three approval points, each with a clock.
 *
 * They are meant to wait — a plan the boss has not read should not start. What
 * was missing is that they waited in silence, so "waiting for you since Tuesday"
 * and "arrived a minute ago" looked alike, and a forgotten requirement is as
 * stopped as a crashed one.
 */
function waitingOnBoss(db: WatchdogDeps["ctx"]["db"], now: number): Finding[] {
  const out: Finding[] = [];

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
        `${q.name} 的 PR 排在队首 ${hours(now - q.at)} 小时了` + (q.behind > 0 ? `，后面还堵着 ${q.behind} 个` : ""),
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
 * The newest codex rollout anywhere in the fleet, for the quota read.
 *
 * Any one live sandbox will do — the quota is the account's, not the container's
 * — so this takes the first that answers and stops. A container that has gone
 * away is skipped rather than failing the read: this is a header number, and
 * nothing may depend on it.
 */
export async function newestRollout(ctx: Ctx): Promise<string | null> {
  for (const s of liveScopes(ctx)) {
    const r = await execIn(ctx, s, NEWEST_ROLLOUT).catch(() => null);
    if (r?.code === 0 && r.out.trim()) return r.out;
  }
  return null;
}

/**
 * The tick, and a promise that it always comes back.
 *
 * `runWatchdog` is straight-line async, and `invariants.ts` names the watchdog as
 * the `driver` for about twelve states — so one `throw` silently un-drives the
 * unwedge rule, the sandbox reaper, the TTL renewal and every clock the boss waits
 * on. Whatever escapes comes back as a finding, with the ones collected before it.
 */
export async function runWatchdog(deps: WatchdogDeps): Promise<Finding[]> {
  const findings: Finding[] = [];
  try {
    return await rules(deps, findings);
  } catch (e) {
    // Through `emit`, not `bus.emit`: a throw in a straight-line tick recurs every
    // 30 seconds, and `emit` keys on (rule, grpId) for half an hour. The findings
    // collected before the throw go with it — `rules` emits at its end and never
    // got there, so without this they never reach the feed.
    return emit(
      deps.ctx,
      [
        ...findings,
        {
          rule: "watchdog_broke",
          grpId: null,
          severity: "blocker",
          body:
            `看门狗这一轮挂了，后面的规则都没跑：${errText(e)}\n` +
            `每 30 秒都会再试一次，但在修好之前，靠它推的那些状态（卡住的组、过期的沙盒、` +
            `基线变了要 rebase、等你决定的计时）都停在原地。`,
        },
      ],
      deps.now ?? (() => Date.now()),
    );
  }
}

/**
 * One rule, its own span, and its failure kept off the other twenty-three.
 *
 * The finding names the rule, so the boss reads "rule 15 broke, the other 24 ran"
 * rather than "the watchdog broke", and `emit` dedups it for `REEMIT_MS`. The span
 * is here rather than at each rule because this is the one place every rule passes
 * through — twenty-four call sites otherwise, and the twenty-fifth would not.
 */
/**
 * Runs on every tick. Deliberately not the pattern `* * * * * *`: parsing
 * twenty-three cron patterns per tick to be told "yes" is work for nothing.
 */
const EVERY_TICK = null;

/** Hourly, for a seven-day retention window. */
const HOURLY = new Cron("0 * * * *");

type Cadence = typeof EVERY_TICK | Cron;

const RAN_KEY = (rule: string) => `watchdog.ran.${rule}`;

/**
 * Due when the cadence's next run after the last one has arrived.
 *
 * Never having run counts as due: a new rule takes effect on the tick it ships.
 * `nextRun` is croner's documented way to ask this of a pattern — a `Cron` built
 * without a callback schedules nothing, so these are parsed patterns, not timers.
 */
function due(db: WatchdogDeps["ctx"]["db"], rule: string, cadence: Cadence, now: number): boolean {
  if (cadence === EVERY_TICK) return true;
  const stored = readSetting(db, RAN_KEY(rule));
  // Tested before the conversion, because `Number(null)` is 0: reading the absent
  // row as a number made a rule that had never run look like one that ran at the
  // epoch. The absent row has to be checked as absent.
  if (stored === null) return true;
  const last = Number(stored);
  if (!Number.isFinite(last)) return true;
  return (cadence.nextRun(new Date(last))?.getTime() ?? Infinity) <= now;
}

/**
 * What one rule declares about itself, beside its own body.
 *
 * `id` and `name` answer to different readers and neither can replace the other:
 * the id is a stored fact — ADR 007 cites "rule 15", and `emit` dedups on
 * `rule_broke:<id>` — while the name is what the panel shows. Declared at the call
 * site rather than in a hoisted table, so the bodies stay where they are.
 */
interface Rule {
  id: string;
  name: string;
  every: Cadence;
}

/** Bound to this tick's database and clock, so `findings` leaves the call sites. */
function stepper(deps: WatchdogDeps, now: () => number, findings: Finding[]) {
  const db = deps.ctx.db;
  return async function step(rule: Rule, run: () => Promise<void>): Promise<void> {
    if (!due(db, rule.id, rule.every, now())) return;
    try {
      await activeTracer().startActiveSpan(`watchdog.${rule.name}`, async (span) => {
        try {
          await run();
        } catch (e) {
          // On the span as well as in the findings: catching outside the callback
          // ended the span green, so a rule that threw looked like one that worked.
          span.setStatus({ code: SpanStatusCode.ERROR, message: errText(e) });
          findings.push({
            // Keyed on the id, not the name: `emit` dedups these for `REEMIT_MS`,
            // so the key is a stored fact and renaming a rule must not reset it.
            rule: `rule_broke:${rule.id}`,
            grpId: null,
            severity: "blocker",
            body: `看门狗第 ${rule.id} 条（${rule.name}）挂了，这一轮其余的照跑：${errText(e)}`,
          });
        } finally {
          span.end();
        }
      });
    } finally {
      // After the run and whatever its outcome: a rule that throws every time would
      // otherwise never record, and would retry on every tick.
      if (rule.every !== EVERY_TICK) {
        writeSetting(db, RAN_KEY(rule.id), String(now()));
      }
    }
  };
}

type Translate = (key: SayKey, args?: Parameters<typeof say>[2]) => string;

/** Stop network-dependent rules while offline and requeue interrupted turns once. */
async function networkReady(
  deps: WatchdogDeps,
  findings: Finding[],
  now: () => number,
  t: Translate,
): Promise<boolean> {
  const net = await (deps.probe ?? probe)(deps.ctx.db, now());
  if (!net.changed) return net.online;
  const held = net.online ? 0 : holdForOffline(deps.ctx, now());
  const body = net.online ? t("net.back") : t("net.lost", { n: held });
  deps.ctx.bus.emit({ author: "orchestrator", kind: "state_change", body });
  findings.push({
    rule: net.online ? "network_back" : "network_lost",
    grpId: null,
    severity: net.online ? "advisory" : "blocker",
    body,
  });
  if (net.online) deps.ctx.sched.tick();
  return net.online;
}

interface BaseGroup {
  id: number;
  name: string;
  repo: string;
  seen: string | null;
  project_id: number;
}

async function nudgeMovedBases(ctx: Ctx, findings: Finding[], now: () => number): Promise<void> {
  const groups = ctx.db
    .query<BaseGroup, []>(
      `SELECT g.id, g.name, p.repo_path AS repo, g.rebase_seen AS seen, g.project_id
       FROM grp g JOIN project p ON p.id = g.project_id
       WHERE g.status IN ('RUNNING','PR_OPEN') AND g.sandbox_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM job j WHERE j.grp_id = g.id AND j.state = 'pending'
                           AND j.kind = 'agent_turn' AND j.payload_json LIKE '%"conflict":true%')`,
    )
    .all();
  // One request per *project*, not per group. Every group in a project asks the
  // same repository for the same branch, so ten groups on one project made ten
  // identical calls against one rate limit on every tick — and the answer they
  // were racing to fetch was the same string.
  const heads = new Map<number, BaseHead | null>();
  for (const group of groups) {
    if (!heads.has(group.project_id)) heads.set(group.project_id, await remoteBaseHead(ctx, group));
  }
  for (const group of groups) await nudgeMovedBase(ctx, group, heads.get(group.project_id) ?? null, findings, now);
}

async function nudgeMovedBase(
  ctx: Ctx,
  group: BaseGroup,
  head: BaseHead | null,
  findings: Finding[],
  now: () => number,
): Promise<void> {
  // The comparison stays per group: the base is a fact about the project, and
  // whether it *moved* is a fact about what this group last saw.
  if (!head || head.sha === group.seen) return;
  const movement = head;
  const git = sandboxGit(ctx, { grp: group.id });
  if (!(await knowsCommit(git, movement.sha))) return;
  if ((await git(WORK, ["merge-base", "--is-ancestor", movement.sha, "HEAD"], WORK)).code === 0) return;
  // Enqueue first, record after: `rebase_seen` is the claim that this movement was
  // handled, and a throw between the two left the claim standing with no nudge sent.
  queueRebase(ctx, group, movement, findings);
  ctx.db.run("UPDATE grp SET rebase_seen = ?, rebase_seen_at = ? WHERE id = ?", [movement.sha, now(), group.id]);
}

interface BaseHead {
  baseRef: string;
  sha: string;
}

/** Where a project's base branch points now. Nothing group-specific in it. */
async function remoteBaseHead(ctx: Ctx, group: BaseGroup): Promise<BaseHead | null> {
  const baseRef = await baseRefFor(ctx, group.project_id);
  const branch = baseRef.startsWith("origin/") ? baseRef.slice("origin/".length) : baseRef;
  const head = await ctx.gh?.request(
    "GET",
    `/repos/${group.repo}/branches/${branch}`,
    z.object({ commit: z.object({ sha: z.string().optional() }).optional() }),
  );
  const sha = head?.ok ? (head.data?.commit?.sha ?? "") : "";
  return sha ? { baseRef, sha } : null;
}

type GitIn = ReturnType<typeof sandboxGit>;

async function knowsCommit(git: GitIn, sha: string): Promise<boolean> {
  if ((await git(WORK, ["cat-file", "-e", `${sha}^{commit}`], WORK)).code === 0) return true;
  if ((await git(WORK, ["fetch", "--quiet", "origin"], WORK)).code !== 0) return false;
  return (await git(WORK, ["cat-file", "-e", `${sha}^{commit}`], WORK)).code === 0;
}

function queueRebase(
  ctx: Ctx,
  group: BaseGroup,
  movement: { baseRef: string; sha: string },
  findings: Finding[],
): void {
  const { baseRef, sha } = movement;
  const remoteBranch = baseRef.startsWith("origin/") ? baseRef.slice("origin/".length) : null;
  const fetchStep = remoteBranch ? `\`git fetch origin ${remoteBranch}\` then ` : "";
  ctx.sched.enqueue("agent_turn", {
    grp_id: group.id,
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
    grpId: group.id,
    severity: "advisory",
    body: `${baseRef} 动到了 ${sha.slice(0, 8)}，${group.name} 的基线落后了，已经让它先 rebase`,
  });
}

async function rules(deps: WatchdogDeps, findings: Finding[]): Promise<Finding[]> {
  const { ctx, cfg } = deps;
  // Boss-facing findings follow output.language; agent feedback stays English.
  const t = (k: SayKey, a?: Parameters<typeof say>[2]) => say(ctx.config.language, k, a);
  const now = deps.now ?? (() => Date.now());
  const step = stepper(deps, now, findings);
  if (!(await networkReady(deps, findings, now, t))) return emit(ctx, findings, now);

  // Liveness first: one row per state, each saying who pushes it (invariants.ts).
  // The rules below are the other question — "is this healthy" — and keeping the
  // two apart is what stops either becoming a dumping ground. Through `step` like
  // every rule below: these two run *before* all twenty-four, so a throw here
  // escaped to `runWatchdog` and skipped every one of them.
  await step({ id: "0a", name: "invariants", every: EVERY_TICK }, async () => {
    runInvariants(ctx);
  });

  // A group the boss approved while a boundary held it. `orch owns` sweeps too, but
  // a blocker can also leave by merging, being split, or being parked and then
  // dissolved — hooking each of those is four places to forget.
  await step({ id: "0b", name: "approved", every: EVERY_TICK }, async () => {
    await sweepApproved(ctx);
  });

  // 1. Turn wall-clock timeout.
  await step({ id: "1", name: "turn_timeout", every: EVERY_TICK }, async () => {
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
        body: t("wd.turn_timeout", { min: minutes(cfg.turnTimeoutMs) }),
      });
      if (j.grp_id) await interrupt(ctx, j.grp_id, "keep");
    }
  });

  // 2. Consecutive turns that wrote nothing to the blackboard.
  await step({ id: "2", name: "no_progress", every: EVERY_TICK }, async () => {
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
  });

  // 3. The same agent rewriting the same file over and over.
  await step({ id: "3", name: "circling", every: EVERY_TICK }, async () => {
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
  });

  // 4. A lease that keeps failing while the code has not changed.
  await step({ id: "4", name: "env_suspect", every: EVERY_TICK }, async () => {
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
  });

  // 5. Budget.
  await step({ id: "5", name: "budget", every: EVERY_TICK }, async () => {
    const budgets = ctx.db
      .query<{ id: number; name: string; budget_tokens: number; spent_tokens: number; status: GrpState }, []>(
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
        hold(ctx, g.id, { reason: "budget", settled: true });
        // A notification says it stopped; it does not put a decision in front of
        // anyone. Without a row in the queue the group sat suspended, 继续 did
        // nothing the scheduler would honour, and the only visible state was a
        // paused group with no reason attached. `budget:` prefixes the question so
        // raising the cap can close exactly this row.
        raise(ctx.db, {
          grpId: g.id,
          brief: "预算烧穿了，加不加",
          chain: "boss",
          dedupe: { prefix: "budget:", scope: "group", grpId: g.id },
          question:
            `budget: ${g.name} 用完了 ${g.budget_tokens} tokens，全组已挂起。` +
            `提高上限它就接着跑，或者就让它停在这里。`,
        });
      } else if (frac >= 0.8) {
        findings.push({
          rule: "budget_80",
          grpId: g.id,
          severity: "advisory",
          body: t("wd.budget_80", { name: g.name, pct: Math.round(frac * 100) }),
        });
      }
    }
  });

  // 6. Quota came back. docs/project/plan.md §11 says a rate-limited group waits for the reset,
  // and waiting is only useful if something is watching the clock.
  await step({ id: "6", name: "rate_limit_resumed", every: EVERY_TICK }, async () => {
    const throttled = ctx.db
      .query<{ id: number; name: string }, [number]>(
        "SELECT id, name FROM grp WHERE status = 'PAUSED' AND rl_resets_at IS NOT NULL AND rl_resets_at <= ?",
      )
      .all(now());
    for (const g of throttled) {
      release(ctx, g.id);
      ctx.bus.emit({
        grpId: g.id,
        author: "orchestrator",
        kind: "state_change",
        body: t("rl.resumed"),
      });
      findings.push({ rule: "rate_limit_resumed", grpId: g.id, severity: "advisory", body: t("rl.resumed") });
    }
  });

  // 7d2. Turn logs, compressed then dropped. Worth keeping — every measurement in
  // docs/project/progress.md came out of these files — but not uncompressed.
  await step({ id: "7d2", name: "turn_logs_swept", every: EVERY_TICK }, async () => {
    sweepTurnLogs(join(cfg.dataDir, "turns"), now());
    sweepCodexSessions(join(cfg.dataDir, "codex-home"), now());
  });

  // 7d2b. The same sweep, in the containers where the files actually are. Hourly
  // and in parallel: `commands.run` is ~1s, and a seven-day retention window does
  // not need enforcing twice a minute. The cadence is declared beside the rule and
  // enforced by `step`, so it survives a restart and is not shared with a second
  // tick.
  await step({ id: "7d2b", name: "container_sessions_swept", every: HOURLY }, async () => {
    await pMap(
      liveScopes(ctx),
      (s) => execIn(ctx, s, `find ${CODEX_HOME}/sessions -type f -mtime +7 -delete 2>/dev/null || true`),
      // `stopOnError: false` is what `allSettled` meant here: one container that
      // refuses must not cancel the sweep of the other nine.
      { concurrency: EXEC_FANOUT, stopOnError: false },
    );
  });

  // 7d3. How much of the claude subscription is left. codex reports both its
  // windows in every turn; claude's stream reports none, so the only way to put
  // the two side by side in the header is to ask. Rate limited to five minutes
  // inside, and it swallows its own failures — the endpoint is undocumented and
  // nothing here may depend on it. Injectable, because it is the one thing in this
  // tick that talks to the network.
  await step({ id: "7d3", name: "subscription_usage", every: EVERY_TICK }, async () => {
    await (deps.pollUsage ?? pollUsage)(ctx, cfg.dataDir, now(), () => newestRollout(ctx));
  });

  // 7e. Keep the shared repo map current.
  //
  // Deterministic and cheap — `git ls-files` plus a regex per file — and only
  // written when the render changed, so a quiet repo costs one comparison. This is
  // the thing seven groups were each rediscovering by grep.
  await step({ id: "7e", name: "repo_map", every: EVERY_TICK }, async () => {
    for (const p of ctx.db
      .query<{ id: number; repo_path: string; remote: string | null }, []>("SELECT id, repo_path, remote FROM project")
      .all()) {
      const { files, why } = p.remote
        ? await listTree(ctx, p.remote, await baseBranch(ctx, p.id))
        : { files: [], why: "这个项目没记下 remote，没有可以镜像的地址" };
      // Said once per project: never means the map silently stops being refreshed,
      // and every tick is a feed nobody reads. Said with git's own words, because
      // naming possible causes in prose is a guess printed as a diagnosis.
      if (!files.length) {
        if (!mapWarned.has(p.id)) {
          mapWarned.add(p.id);
          findings.push({
            rule: "repo-map",
            grpId: null,
            severity: "advisory",
            body: `仓库地图没法刷新了：${p.repo_path} —— ${why ?? "没有原因可说，这本身就是个 bug"}`,
          });
        }
        continue;
      }
      mapWarned.delete(p.id);
      // Symbols need file *contents*, and the only copy is in the project's own
      // container: the mirror is `--filter=blob:none`, so reading through it is a
      // network fetch per file, and this machine has no checkout at all. One exec
      // for the whole corpus, and whole files rather than the indexer's head — the
      // last declaration in a truncated file falls outside its `export_statement`
      // and is lost, and no larger cap fixes it. Empty is a legitimate answer
      // (indexing off, or no container yet) and means a paths-only map.

      // ponytail: the whole corpus crosses the exec every tick (0.8 MB → 4.0 MB
      // here). Gate the exec on the tree's head sha if a large repo makes it hurt.
      const heads = await treeHeads(ctx, { project: p.id }, null).catch(() => new Map<string, string>());
      const named = await buildMap(
        p.repo_path,
        () => files,
        indexExcludes(ctx.db, p.id),
        (rel) => heads.get(rel),
      );
      if (saveMap(ctx.db, p.id, renderMap(named))) {
        ctx.bus.emit({
          author: "librarian",
          kind: "state_change",
          body: `repo map refreshed (${files.length} files, ${heads.size} read for symbols)`,
        });
      }
    }
  });

  // 8. A live group with nothing queued. Every way a turn can end is terminal and
  // nothing re-queues, so a turn that ends without arranging the next one leaves
  // the group RUNNING with no error anywhere. The queue being empty under a live
  // group IS the fault, whatever the last turn's exit code said. One automatic
  // retry, then the boss.
  await step({ id: "8", name: "stalled", every: EVERY_TICK }, async () => {
    const stalled = ctx.db
      .query<Job, [string]>(
        `SELECT j.id, j.kind, j.grp_id, j.agent_id, j.slice_id, j.payload_json, j.priority, j.state, j.error
         FROM job j JOIN grp g ON g.id = j.grp_id
         WHERE g.status IN ('RUNNING', 'PLANNING') AND j.kind = 'agent_turn'
           AND j.id = (SELECT max(id) FROM job WHERE grp_id = j.grp_id AND kind = 'agent_turn')
           AND NOT EXISTS (SELECT 1 FROM job k WHERE k.grp_id = j.grp_id
                           AND k.state IN (SELECT value FROM json_each(?)))`,
      )
      .all(stateParam(ACTIVE_JOB_STATES));
    for (const j of stalled) {
      // A rebase that beat the Engineer twice is a design question, not a harder
      // rebase, so the next thing to try is the role that can say whether the slice
      // still makes sense. `conflict` marks a turn that was *told* to rebase (rule
      // 15), not one that failed to — hence `state === 'failed'` as well: a turn
      // that ended `done` is a stall, which is the branch below.
      const payload = jsonOr(j.payload_json, z.looseObject({ conflict: z.boolean().optional() }), {});
      if (payload.conflict === true && j.state === "failed") {
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
        body: t("wd.stalled", { why: j.error ?? "" }),
      });
    }
    // No tick here: the server ticks on the same timer that enqueued this watchdog,
    // so the re-queued turn goes out a beat later either way.
  });

  // 9. Work queued for a group that is gone. Dropping and splitting both cancel
  // what was pending, but a mail arriving a moment later enqueues another one, and
  // no status a dissolved group has is dispatchable — so it sits pending forever,
  // counted in every "what is queued" view the boss reads.
  await step({ id: "9", name: "orphan_jobs", every: EVERY_TICK }, async () => {
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
  });

  // 11. A question stranded below the boss on a group that cannot answer it.
  // route() sends these to the boss, but only at the moment they are routed — a
  // group can stop *after* a question was handed to its PM. The symptom is the
  // worst kind: a stopped group, and a 待办 count of zero.
  await step({ id: "11", name: "stranded_question", every: EVERY_TICK }, async () => {
    const stranded = ctx.db
      .query<{ id: number }, [string, string, string]>(
        // Blockers only, same reason route() lifts only blockers: an advisory that
        // nobody answers costs nothing, and a clearance denial is a JSON blob about
        // a tool call rather than a decision anyone can take.
        `SELECT e.id FROM escalation e JOIN grp g ON g.id = e.grp_id
         WHERE e.answer IS NULL AND e.severity = 'blocker'
           AND e.chain_state != 'boss'
           AND e.chain_state NOT IN (SELECT value FROM json_each(?))
           AND g.status NOT IN (SELECT value FROM json_each(?))
           AND g.status NOT IN (SELECT value FROM json_each(?))`,
      )
      .all(
        stateParam(ESCALATION_TERMINAL_STATES),
        stateParam(DISPATCHABLE_GRP_STATES),
        // Rule 16 revokes these. Without the second clause this routes them to the
        // boss — notification and all — and rule 16 kills the question afterwards.
        stateParam(ANSWERLESS_GRP_STATES),
      );
    for (const e of stranded) route({ ctx, ...(ctx.notifyBoss ? { notifyBoss: ctx.notifyBoss } : {}) }, e.id);
  });

  // 10. The group it was waiting on has landed. `orch blocked` stops the caller,
  // and without this it waits forever: nothing else in the system knows that one
  // group's merge is another group's green light.
  await step({ id: "10", name: "unblocked", every: EVERY_TICK }, async () => {
    const waiting = ctx.db
      .query<{ id: number; name: string; blocked_on: number }, []>(
        `SELECT g.id, g.name, g.blocked_on FROM grp g JOIN grp b ON b.id = g.blocked_on
         WHERE g.blocked_on IS NOT NULL AND b.status = 'DISSOLVED'`,
      )
      .all();
    for (const g of waiting) {
      release(ctx, g.id);
      ctx.bus.emit({
        grpId: g.id,
        author: "orchestrator",
        kind: "state_change",
        body: t("group.unblocked", { target: String(g.blocked_on) }),
      });
      // Rule 8 above requeues a live group with an empty queue, so the turn itself
      // comes from there — this only has to make the group live again.
      findings.push({
        rule: "unblocked",
        grpId: g.id,
        severity: "advisory",
        body: t("group.unblocked", { target: String(g.blocked_on) }),
      });
    }
  });

  // 7. Paused too long: notify, then park to stop holding a slot.
  await step({ id: "7", name: "paused_too_long", every: EVERY_TICK }, async () => {
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
        park(ctx, g.id, `waited ${minutes(waited)} min for you`);
        findings.push({
          rule: "parked",
          grpId: g.id,
          severity: "advisory",
          body: t("wd.parked", { name: g.name, min: minutes(waited) }),
        });
      } else if (waited >= PAUSED_NOTIFY_MS) {
        findings.push({
          rule: "waiting_on_you",
          grpId: g.id,
          severity: "blocker",
          body: t("wd.waiting_on_you", { name: g.name, min: minutes(waited) }),
        });
      }
    }
  });

  // 12. A parked group whose question got answered after it stopped. `answer()`
  // un-pauses PAUSED groups and silently skips PARKED ones, and parking is the only
  // state the system never takes a group out of on its own. Answered *after* it
  // stopped, not merely "no open blocker": most parked groups never had a blocker,
  // and reviving those would undo the parking on the same tick that did it.
  await step({ id: "12", name: "unparked", every: EVERY_TICK }, async () => {
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
  });

  // 15. A live branch is told once per remote base to rebase before PR time.
  await step({ id: "15", name: "base_moved", every: EVERY_TICK }, () => nudgeMovedBases(ctx, findings, now));

  // 14. Parked and forgotten. It will not come back on its own and will not ask
  // again, so the one thing owed is a reminder that says how long.
  await step({ id: "14", name: "waiting_parked", every: EVERY_TICK }, async () => {
    for (const g of ctx.db
      .query<{ id: number; name: string; paused_at: number }, [number]>(
        "SELECT id, name, paused_at FROM grp WHERE status = 'PARKED' AND paused_at IS NOT NULL AND paused_at < ?",
      )
      .all(now() - NUDGE_AFTER_MS)) {
      findings.push({
        rule: "waiting_parked",
        grpId: g.id,
        severity: "advisory",
        body: `${g.name} 封存了 ${hours(now() - g.paused_at)} 小时，唤醒还是不做了？`,
      });
    }
  });

  // 17. A dissolved group's sandbox. Two containers per group — the sandbox and
  // its egress sidecar — and neither goes away on its own until the TTL runs out,
  // which is a day. `pause` is not the cheap alternative it looks like: it is a
  // real `docker pause`, so the container and its disk both stay (docs/adr/005).
  // Only kill frees anything.
  await step({ id: "17", name: "sandbox_swept", every: EVERY_TICK }, async () => {
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
  });

  // 17b. A sandbox older than the credential it is supposed to be using.
  //
  // A sidecar is loaded once, when its sandbox is built, and never again, so
  // storing a credential has to kill the running sandboxes. Not left to the
  // callers: the next way to store one — an import, a refresh, a CLI — would have
  // to remember, and this is the class of bug where forgetting looks healthy. The
  // durable form is a fact about the row, checked here, whichever path stored it.
  await step({ id: "17b", name: "sandbox_stale_credential", every: EVERY_TICK }, async () => {
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
      // The utility container matters most: its sidecar holds the GitHub token, so
      // a rotated login leaves it pushing with the old one — and a push refused for
      // authentication is the boss-bucket failure 007 §6 says must never present as
      // an agent problem.
      const util = utilSandbox(ctx.db);
      if (util.id && util.at < newestCredential) await killSandbox(ctx, UTIL);
    }
  });

  // 18. A live container expiring under whatever is using it. The TTL is what
  // stops a crashed orchestrator leaking containers forever, so it is short enough
  // to reap a group that is simply thinking; renewing every tick is the other half
  // of that bargain. One loop over every kind there is, deliberately — a third loop
  // for the utility container would guarantee the same omission a third time.
  // `renewSandbox` is a no-op for a scope with no container.
  await step({ id: "18", name: "sandbox_expiring", every: EVERY_TICK }, async () => {
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
  });

  // 19. The sandbox server is gone. Fires on **absence** and nothing else: a
  // server that is present but refusing would only be restarted into a restart
  // loop. Two more guards, because an automatic action that keeps trying is how a
  // crash loop becomes an outage — only from an argv we have **seen** this process
  // run, and a hard cap, because N failed restarts is evidence that restarting is
  // not the answer.
  await step({ id: "19", name: "sandbox_server", every: EVERY_TICK }, async () => {
    const present = serverPresent(deps);
    if (present) serverRestarts = 0;
    switch (serverAction(present, seenServerArgv, serverRestarts, now(), nextServerTry)) {
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
        const err = await restartServer(seenServerArgv!, serverLogPath(ctx));
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
      case "none":
        break;
    }
  });

  // 16. A question the work has already gone past. `review.ts` files a blocker
  // when a slice fails QA three times, and nothing closes it if the group then
  // recovers. A group at PR_OPEN or DISSOLVED has no caller left to unblock —
  // answering would change nothing, so the queue must stop asking.
  await step({ id: "16", name: "stale_ask", every: EVERY_TICK }, async () => {
    for (const e of ctx.db
      .query<{ id: number; grp_id: number; name: string }, [string, string]>(
        `SELECT e.id, e.grp_id, g.name FROM escalation e JOIN grp g ON g.id = e.grp_id
         WHERE e.chain_state NOT IN (SELECT value FROM json_each(?))
           AND g.status IN (SELECT value FROM json_each(?))`,
      )
      .all(stateParam(ESCALATION_TERMINAL_STATES), stateParam(ANSWERLESS_GRP_STATES))) {
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
  });

  // 13. The three places that wait on the boss, with a clock on each. They are
  // supposed to wait; what was missing is that they waited in silence.
  await step({ id: "13", name: "boss_clocks", every: EVERY_TICK }, async () => {
    for (const w of waitingOnBoss(ctx.db, now())) findings.push(w);
  });

  return emit(ctx, findings, now);
}

/**
 * A standing condition is re-detected on every tick, and a repeat is a reminder
 * rather than a new problem — so the event log backs off the way the notifier
 * already does. The returned list is filtered to the same set, not just the
 * emitted events: it is what the caller pushes to the boss's phone.
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
 * Doing nothing is the trap: the CLI retries until `turnTimeoutMs`, rule 1
 * interrupts the group into PAUSED, and nothing resumes a PAUSED group. So the job
 * is cancelled and re-queued and **the group's status is not touched** — the
 * scheduler's offline gate holds the work, and the queue drains when it lifts.
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
  return resumeReclaimed(
    ctx.sched,
    running.map((j) => ({ ...j, state: "cancelled" as const, error: "offline: the host lost its network" })),
  );
}

/**
 * Update the loop/idle counters from a finished turn.
 *
 * "Wrote nothing" means no file changed, no task moved and no note was written —
 * three things we can check without asking the agent how it is getting on.
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
