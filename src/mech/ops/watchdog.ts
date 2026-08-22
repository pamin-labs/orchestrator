import { msg, plural } from "@lingui/core/macro";
import {
  and,
  count,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  max,
  ne,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DB } from "../../platform/persistence/database.ts";
import {
  maxMs,
  agent,
  escalation,
  event,
  grp,
  job,
  lease,
  note,
  project,
  runtime_auth,
  slice,
} from "../../platform/persistence/schema.ts";
import { valueOr } from "../../contracts/json.ts";
import { errText, hours, minutes } from "../../platform/process/text.ts";
import { answered, roleFor, type Ctx } from "../../mech/ctx.ts";
import type { Config } from "../../platform/config/load.ts";
import type { Said } from "../../contracts/said.ts";
import { hold, interrupt, park, release, unpark } from "../flow/intercept.ts";
import { sweepApproved } from "../flow/start.ts";
import { escalationKey, raise } from "../flow/escalate.ts";
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
import { buildMap, indexExcludes, loadMap, saveMap } from "../knowledge/repomap.ts";
import { resumeReclaimed } from "../../platform/scheduling/scheduler.ts";
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
  type GrpState,
} from "../../contracts/states.ts";
import { outputLanguage } from "../../contracts/config.ts";

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
  /**
   * Named, not rendered. ADR 035 §3: the panel is the only reader of the event
   * body, so it renders this in its own locale — and `executor.ts` renders the
   * same key in `output.language` for the notifier, which does reach a webhook.
   */
  say: Said;
  severity: "advisory" | "blocker";
}

/**
 * What the watchdog calls stuck, and how often it repeats itself.
 *
 * Every one of these was a literal while `watchdogIntervalMs` sat beside them in
 * the settings page — so the boss could change how often the rules ran and nothing
 * about what they decided.
 */
const limits = (ctx: Pick<Ctx, "config">) => ctx.config.watchdog;

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
async function waitingOnBoss(db: WatchdogDeps["ctx"]["db"], now: number, nudgeAfterMs: number): Promise<Finding[]> {
  const out: Finding[] = [];
  const cutoff = now - nudgeAfterMs;

  // Containment, not `->> = '1'`: the card is written as JSON `true`, and SQLite's
  // `json_extract(...) = 1` matched that only because it rendered a boolean as 1.
  for (const g of await db
    .select({ id: grp.id, name: grp.name, at: maxMs(note.at) })
    .from(grp)
    .innerJoin(note, eq(note.grp_id, grp.id))
    .where(
      and(
        eq(grp.status, "DRAFT"),
        isNull(grp.approved_at),
        sql`${note.frontmatter_json} @> '{"draft_card": true}'::jsonb`,
      ),
    )
    .groupBy(grp.id)
    .having(lt(maxMs(note.at), cutoff))) {
    out.push({
      rule: "waiting_card",
      grpId: g.id,
      severity: "advisory",
      say: msg`${{ name: g.name }}'s plan card has been waiting ${{ hours: hours(now - (g.at ?? now)) }}h for you`,
    });
  }

  for (const s of await db
    .select({ grp_id: slice.grp_id, name: grp.name, seq: slice.seq, awaiting_at: slice.awaiting_at })
    .from(slice)
    .innerJoin(grp, eq(grp.id, slice.grp_id))
    .where(and(eq(slice.status, "awaiting_boss"), isNotNull(slice.awaiting_at), lt(slice.awaiting_at, cutoff)))) {
    out.push({
      rule: "waiting_slice",
      grpId: s.grp_id,
      severity: "advisory",
      say: msg`${{ name: s.name }} S${{ seq: s.seq }} has been waiting ${{ hours: hours(now - (s.awaiting_at ?? now)) }}h for you`,
    });
  }

  // Only the head: the queue is strictly serial, so everything behind it is
  // waiting on this one merge, and that count is the whole reason to care.
  const ahead = alias(grp, "ahead");
  const heads = await db
    .select({ id: grp.id, name: grp.name, at: grp.merge_seq_at, project_id: grp.project_id, seq: grp.merge_seq })
    .from(grp)
    .where(
      and(
        eq(grp.status, "PR_OPEN"),
        isNotNull(grp.merge_seq_at),
        lt(grp.merge_seq_at, cutoff),
        notExists(
          db
            .select({ id: ahead.id })
            .from(ahead)
            .where(
              and(
                eq(ahead.project_id, grp.project_id),
                eq(ahead.status, "PR_OPEN"),
                lt(ahead.merge_seq, grp.merge_seq),
              ),
            ),
        ),
      ),
    );
  for (const q of heads) {
    // Counted per head rather than as a correlated subquery in the select list:
    // the filter above leaves at most one head per project, so this is one small
    // query per project and needs no raw SQL to say so. `merge_seq > head` already
    // excludes the head itself, and a head with no place in the order has nothing
    // countably behind it — `o.merge_seq > NULL` matched no row before either.
    const [row] =
      q.seq === null
        ? []
        : await db
            .select({ behind: count() })
            .from(grp)
            .where(and(eq(grp.project_id, q.project_id), eq(grp.status, "PR_OPEN"), gt(grp.merge_seq, q.seq)));
    const behind = row?.behind ?? 0;
    out.push({
      rule: "waiting_merge",
      grpId: q.id,
      severity: behind > 0 ? "blocker" : "advisory",
      say:
        behind > 0
          ? msg`${{ name: q.name }}'s PR has been at the head of the merge queue for ${{ hours: hours(now - (q.at ?? now)) }}h, with ${{ n: behind }} behind it`
          : msg`${{ name: q.name }}'s PR has been at the head of the merge queue for ${{ hours: hours(now - (q.at ?? now)) }}h`,
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
/**
 * A group whose container is not ours to touch: over, or deliberately set down.
 *
 * Written out inside the query before, so the two states that mean "leave it
 * alone" were a string nothing checked against the lifecycle vocabulary.
 */
const UNREACHABLE_GRP_STATES = ["DISSOLVED", "PARKED"] as const satisfies readonly GrpState[];

async function liveScopes(db: DB): Promise<Scope[]> {
  const out: Scope[] = [];
  for (const g of await db
    .select({ id: grp.id })
    .from(grp)
    .where(and(isNotNull(grp.sandbox_id), notInArray(grp.status, [...UNREACHABLE_GRP_STATES])))) {
    out.push({ grp: g.id });
  }
  for (const p of await db.select({ id: project.id }).from(project).where(isNotNull(project.sandbox_id))) {
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
  for (const s of await liveScopes(ctx.db)) {
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
    return await emit(
      deps.ctx,
      [
        ...findings,
        {
          rule: "watchdog_broke",
          grpId: null,
          severity: "blocker",
          say: msg`the watchdog threw this tick and the rules after it did not run: ${{ why: errText(e) }}\nIt retries every 30s, but until it is fixed everything it drives — stalled groups, expired sandboxes, the rebase after a base moves, the clocks on what is waiting for you — stays where it is.`,
        },
      ],
      deps.now ?? (() => Date.now()),
    );
  }
}

/**
 * Runs on every tick. Deliberately not the pattern `* * * * * *`: parsing
 * twenty-three cron patterns per tick to be told "yes" is work for nothing.
 */
const EVERY_TICK = null;

/** Hourly, for a seven-day retention window. */
const HOURLY = new Cron("0 * * * *");

/**
 * A plain interval, for a rule whose period is a setting rather than a clock time.
 *
 * `HOURLY` wants to land on the hour; the repo-map check just wants to stop
 * asking every thirty seconds. A cron pattern built from milliseconds would be a
 * translation with nothing to gain.
 */
type Every = { everyMs: number };

type Cadence = typeof EVERY_TICK | Cron | Every;

const RAN_KEY = (rule: string) => `watchdog.ran.${rule}`;

/** The repo map's stamp, in the database because process memory forgets on restart. */
const MAP_KEY = (projectId: number) => `watchdog.repo_map.${projectId}`;

/**
 * Everything the repo map is a function of, in one 41-byte round trip.
 *
 * The project checkout is only ever a clean checkout of the base branch — agents
 * work in group containers — so its HEAD is a faithful stamp of the contents the
 * map reads. The exclude list and the repository's name are the map's other two
 * inputs and neither moves HEAD, so both go in. Empty means the container could
 * not be read, which the caller must treat as "unknown", never as "unchanged".
 */
type MapProject = { id: number; repo_path: string; remote: string | null };

/**
 * One project's map, rebuilt only when something it is made of moved.
 *
 * The stamp comes first because both round trips below used to happen before the
 * rule knew whether anything had changed, and the second one carries every
 * tracked file's contents out of the container. An idle project paid four
 * container execs and 0.8 MB every thirty seconds for a map identical to the
 * stored one.
 */
/**
 * Why the map could not be refreshed — a key per case, not one key with a
 * fragment rendered into it: a value carrying prose we wrote is one sentence in
 * two languages, which `contracts/said.ts` refuses. `{why}` is only ever git's
 * own words. Its own function so the three cases do not sit inside `refreshMap`,
 * where they read as branches of the rule rather than as one answer.
 */
const mapFailure = (repo: string, remote: boolean, why: string | null): Said =>
  !remote
    ? msg`the repo map cannot be refreshed: ${{ repo }} has no remote recorded, so there is nothing to mirror`
    : why
      ? msg`the repo map cannot be refreshed: ${{ repo }} — ${{ why }}`
      : msg`the repo map cannot be refreshed: ${{ repo }}, and git gave no reason, which is itself a bug`;

async function refreshMap(ctx: Ctx, p: MapProject, findings: Finding[]): Promise<void> {
  const stamp = p.remote ? await mapStamp(ctx, p.id, p.repo_path) : "";
  // An unreadable stamp used to mean "do the work anyway", on the reasoning that a
  // container which will not answer must not freeze the map. Measured over 2,766
  // ticks: it froze nothing and cost **6,351 seconds** — 95% of the whole watchdog
  // tick. The container that cannot answer `rev-parse` is the same one
  // `treeHeads` reads file contents from, so every one of those rebuilds produced
  // a *paths-only* map and stored it over a better one, at 5.3s a tick, for as
  // long as the container stayed down.
  // Once, if there is nothing stored yet — a paths-only map beats no map, and it
  // is the repetition that cost the 6,351 seconds, not the first build.
  if (p.remote && !stamp && (await loadMap(ctx.db, p.id)).length > 0) {
    if (mapWarned.has(p.id)) return;
    mapWarned.add(p.id);
    findings.push({
      rule: "repo-map",
      grpId: null,
      severity: "advisory",
      say: msg`the repo map is stuck on its last version: ${{ repo: p.repo_path }}'s container cannot read HEAD, and a rebuild would only produce a map with no symbols in it`,
    });
    return;
  }
  if (stamp && (await readSetting(ctx.db, MAP_KEY(p.id))) === stamp) return;
  const { files, why } = p.remote
    ? await listTree(ctx, p.remote, await baseBranch(ctx, p.id))
    : { files: [], why: null };
  // Said once per project: never means the map silently stops being refreshed,
  // and every tick is a feed nobody reads. Said with git's own words, because
  // naming possible causes in prose is a guess printed as a diagnosis.
  if (!files.length) {
    if (mapWarned.has(p.id)) return;
    mapWarned.add(p.id);
    findings.push({
      rule: "repo-map",
      grpId: null,
      severity: "advisory",
      say: mapFailure(p.repo_path, !!p.remote, why),
    });
    return;
  }
  mapWarned.delete(p.id);
  // Symbols need file *contents*, and the only copy is in the project's own
  // container. Whole files, not the indexer's head: a parser needs the whole
  // declaration, so a truncated file silently loses its last one and no larger
  // cap fixes that. Empty is legitimate and means a paths-only map. This is the
  // 0.8 MB the stamp exists to spend only when it buys something.
  const heads = await treeHeads(ctx, { project: p.id }, null).catch(() => new Map<string, string>());
  const named = await buildMap(
    p.repo_path,
    () => files,
    await indexExcludes(ctx.db, p.id),
    (rel) => heads.get(rel),
  );
  if (await saveMap(ctx.db, p.id, named)) {
    await ctx.bus.emit({
      author: roleFor(ctx, "compress_context"),
      kind: "state_change",
      say: msg`repo map refreshed (${plural({ files: files.length }, { one: "# file", other: "# files" })}, ${{ read: heads.size }} read for symbols)`,
    });
  }
  // After the map is stored, never before: a tick that refreshed nothing must not
  // record that it did.
  if (stamp) await writeSetting(ctx.db, MAP_KEY(p.id), stamp);
}

async function mapStamp(ctx: Ctx, projectId: number, repoPath: string): Promise<string> {
  const head = await sandboxGit(ctx, { project: projectId })(["rev-parse", "HEAD"], WORK);
  if (head.code !== 0) return "";
  return Bun.hash([head.out.trim(), repoPath, ...(await indexExcludes(ctx.db, projectId))].join("\n")).toString(16);
}

/**
 * Due when the cadence's next run after the last one has arrived.
 *
 * Never having run counts as due: a new rule takes effect on the tick it ships.
 * `nextRun` is croner's documented way to ask this of a pattern — a `Cron` built
 * without a callback schedules nothing, so these are parsed patterns, not timers.
 */
async function due(db: WatchdogDeps["ctx"]["db"], rule: string, cadence: Cadence, now: number): Promise<boolean> {
  if (cadence === EVERY_TICK) return true;
  const stored = await readSetting(db, RAN_KEY(rule));
  // Tested before the conversion, because `Number(null)` is 0: reading the absent
  // row as a number made a rule that had never run look like one that ran at the
  // epoch. The absent row has to be checked as absent.
  if (stored === null) return true;
  const last = Number(stored);
  if (!Number.isFinite(last)) return true;
  if ("everyMs" in cadence) return now - last >= cadence.everyMs;
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

/**
 * One rule, its own span, and its failure kept off the other twenty-three.
 *
 * Bound to this tick's database and clock, so `findings` leaves the call sites.
 * The finding names the rule — the boss reads "rule 15 broke, the other 24 ran" —
 * and `emit` dedups it for `REEMIT_MS`. The span is here because this is the one
 * place every rule passes through; the twenty-fifth call site would not have one.
 */
function stepper(deps: WatchdogDeps, now: () => number, findings: Finding[]) {
  const db = deps.ctx.db;
  return async function step(rule: Rule, run: () => Promise<void>): Promise<void> {
    if (!(await due(db, rule.id, rule.every, now()))) return;
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
            say: msg`watchdog rule ${{ rule: rule.id }} (${{ ruleName: rule.name }}) threw; the rest of the tick ran: ${{ why: errText(e) }}`,
          });
        } finally {
          span.end();
        }
      });
    } finally {
      // After the run and whatever its outcome: a rule that throws every time would
      // otherwise never record, and would retry on every tick.
      if (rule.every !== EVERY_TICK) {
        await writeSetting(db, RAN_KEY(rule.id), String(now()));
      }
    }
  };
}

/** Stop network-dependent rules while offline and requeue interrupted turns once. */
async function networkReady(deps: WatchdogDeps, findings: Finding[], now: () => number): Promise<boolean> {
  const net = await (deps.probe ?? probe)(deps.ctx.db, now(), undefined, deps.ctx.config);
  if (!net.changed) return net.online;
  const held = net.online ? 0 : await holdForOffline(deps.ctx, now());
  const what = net.online
    ? msg`network is back, held work resumes`
    : msg`the host lost its network; ${plural({ n: held }, { one: "# turn", other: "# turns" })} held and re-queued, requirements left running`;
  // The finding is the only announcement. There was a `bus.emit` here as well,
  // with the same sentence and no dedup, so the feed carried the line twice in
  // the same second — once from `orchestrator` as a state change, once from
  // `watchdog` as the finding. `emit` below keys on the rule and backs off for
  // `REEMIT_MS`; the direct call did neither, and a standing outage re-announced
  // itself on the transition into every retry.
  findings.push({
    rule: net.online ? "network_back" : "network_lost",
    grpId: null,
    severity: net.online ? "advisory" : "blocker",
    say: what,
  });
  if (net.online) await deps.ctx.sched.tick();
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
  const groups = await ctx.db
    .select({ id: grp.id, name: grp.name, repo: project.repo_path, seen: grp.rebase_seen, project_id: grp.project_id })
    .from(grp)
    .innerJoin(project, eq(project.id, grp.project_id))
    .where(
      and(
        inArray(grp.status, ["RUNNING", "PR_OPEN"]),
        isNotNull(grp.sandbox_id),
        // Containment rather than the old `LIKE '%"conflict":true%'`: the column is
        // `jsonb`, so there is no text to match, and the LIKE was reading a
        // serialisation it did not control.
        notExists(
          ctx.db
            .select({ id: job.id })
            .from(job)
            .where(
              and(
                eq(job.grp_id, grp.id),
                eq(job.state, "pending"),
                eq(job.kind, "agent_turn"),
                sql`${job.payload_json} @> '{"conflict":true}'::jsonb`,
              ),
            ),
        ),
      ),
    );
  // One request per *project*, not per group: ten groups on one project spent ten
  // identical calls of one rate limit every tick, fetching the same string.
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
  if ((await git(["merge-base", "--is-ancestor", movement.sha, "HEAD"], WORK)).code === 0) return;
  // Enqueue first, record after: `rebase_seen` is the claim that this movement was
  // handled, and a throw between the two left the claim standing with no nudge sent.
  await queueRebase(ctx, group, movement, findings);
  await ctx.db.update(grp).set({ rebase_seen: movement.sha, rebase_seen_at: now() }).where(eq(grp.id, group.id));
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
  if ((await git(["cat-file", "-e", `${sha}^{commit}`], WORK)).code === 0) return true;
  if ((await git(["fetch", "--quiet", "origin"], WORK)).code !== 0) return false;
  return (await git(["cat-file", "-e", `${sha}^{commit}`], WORK)).code === 0;
}

async function queueRebase(
  ctx: Ctx,
  group: BaseGroup,
  movement: { baseRef: string; sha: string },
  findings: Finding[],
): Promise<void> {
  const { baseRef, sha } = movement;
  const remoteBranch = baseRef.startsWith("origin/") ? baseRef.slice("origin/".length) : null;
  const fetchStep = remoteBranch ? `\`git fetch origin ${remoteBranch}\` then ` : "";
  await ctx.sched.enqueue("agent_turn", {
    grp_id: group.id,
    priority: 4,
    payload: {
      role: roleFor(ctx, "write_code"),
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
    say: msg`${{ base: baseRef }} moved to ${{ sha: sha.slice(0, 8) }}; ${{ name: group.name }} is behind it and has been told to rebase first`,
  });
}

async function rules(deps: WatchdogDeps, findings: Finding[]): Promise<Finding[]> {
  const { ctx, cfg } = deps;
  const now = deps.now ?? (() => Date.now());
  const step = stepper(deps, now, findings);
  if (!(await networkReady(deps, findings, now))) return await emit(ctx, findings, now);

  // Liveness first: one row per state, each saying who pushes it (invariants.ts).
  // The rules below are the other question — "is this healthy" — and keeping the
  // two apart is what stops either becoming a dumping ground. Through `step` like
  // every rule below: these two run *before* all twenty-four, so a throw here
  // escaped to `runWatchdog` and skipped every one of them.
  await step({ id: "0a", name: "invariants", every: EVERY_TICK }, async () => {
    await runInvariants(ctx);
  });

  // A group the boss approved while a boundary held it. `orch owns` sweeps too, but
  // a blocker can also leave by merging, being split, or being parked and then
  // dissolved — hooking each of those is four places to forget.
  await step({ id: "0b", name: "approved", every: EVERY_TICK }, async () => {
    await sweepApproved(ctx);
  });

  // 1. Turn wall-clock timeout.
  await step({ id: "1", name: "turn_timeout", every: EVERY_TICK }, async () => {
    const stale = await ctx.db
      .select({ id: job.id, grp_id: job.grp_id, started_at: job.started_at })
      .from(job)
      .where(and(eq(job.state, "running"), eq(job.kind, "agent_turn"), lt(job.started_at, now() - cfg.turnTimeoutMs)));
    for (const j of stale) {
      findings.push({
        rule: "turn_timeout",
        grpId: j.grp_id,
        severity: "advisory",
        say: msg`turn ran past ${{ min: minutes(cfg.turnTimeoutMs) }} min and was killed`,
      });
      if (j.grp_id) await interrupt(ctx, j.grp_id, "keep");
    }
  });

  // 2. Consecutive turns that wrote nothing to the blackboard.
  await step({ id: "2", name: "no_progress", every: EVERY_TICK }, async () => {
    const idle = await ctx.db
      .select({ id: agent.id, grp_id: agent.grp_id, role: agent.role, idle_turns: agent.idle_turns })
      .from(agent)
      .where(gte(agent.idle_turns, limits(ctx).idleTurns));
    for (const a of idle) {
      findings.push({
        rule: "no_progress",
        grpId: a.grp_id,
        severity: "advisory",
        say: msg`${{ role: a.role }} finished ${plural({ n: a.idle_turns }, { one: "# turn", other: "# turns" })} without changing a file, a task or a note`,
      });
      await ctx.db.update(agent).set({ state: "blocked", idle_turns: 0 }).where(eq(agent.id, a.id));
    }
  });

  // 3. The same agent rewriting the same file over and over.
  await step({ id: "3", name: "circling", every: EVERY_TICK }, async () => {
    const looping = await ctx.db
      .select({
        id: agent.id,
        grp_id: agent.grp_id,
        role: agent.role,
        loop_file: agent.loop_file,
        loop_count: agent.loop_count,
      })
      .from(agent)
      .where(and(gte(agent.loop_count, limits(ctx).sameFile), isNotNull(agent.loop_file)));
    for (const a of looping) {
      findings.push({
        rule: "circling",
        grpId: a.grp_id,
        severity: "advisory",
        // Architect, not the writer: going round in circles on one file is usually
        // a design problem, and asking the writer to try harder does not fix it.
        // `loop_file` is still typed nullable — the predicate is a runtime fact and
        // not a type — so this reads it rather than asserting past it.
        say: msg`${{ role: a.role }} has rewritten ${{ file: a.loop_file ?? "" }} ${plural({ n: a.loop_count }, { one: "# turn", other: "# turns" })} running — probably a design problem, sending it to the Architect`,
      });
      await ctx.db.update(agent).set({ loop_count: 0 }).where(eq(agent.id, a.id));
    }
  });

  // 4. A lease that keeps failing while the code has not changed.
  await step({ id: "4", name: "env_suspect", every: EVERY_TICK }, async () => {
    const envSuspect = await ctx.db
      .select({ resource: lease.resource, grp_id: lease.grp_id, head_sha: lease.head_sha, c: count() })
      .from(lease)
      .where(and(eq(lease.state, "failed"), isNotNull(lease.head_sha)))
      .groupBy(lease.resource, lease.grp_id, lease.head_sha)
      .having(gte(count(), 2));
    for (const l of envSuspect) {
      findings.push({
        rule: "env_suspect",
        grpId: l.grp_id,
        severity: "advisory",
        // Same command, same code, same failure: the environment is the variable,
        // and letting the writer keep editing code is how hours disappear.
        say: msg`${{ resource: l.resource }} failed ${{ n: l.c }}x with no code change in between — treat the environment as the suspect`,
      });
      await ctx.db
        .update(lease)
        .set({ head_sha: null })
        .where(
          and(
            eq(lease.resource, l.resource),
            eq(lease.state, "failed"),
            l.head_sha === null ? isNull(lease.head_sha) : eq(lease.head_sha, l.head_sha),
          ),
        );
    }
  });

  // 5. Budget.
  await step({ id: "5", name: "budget", every: EVERY_TICK }, async () => {
    const budgets = await ctx.db
      .select({
        id: grp.id,
        name: grp.name,
        budget_tokens: grp.budget_tokens,
        spent_tokens: grp.spent_tokens,
        status: grp.status,
      })
      .from(grp)
      .where(isNotNull(grp.budget_tokens));
    for (const g of budgets) {
      // Nullable by type, never null here — the predicate above says so, and a
      // division by a missing budget would read as an exhausted one.
      if (g.budget_tokens === null) continue;
      const frac = g.spent_tokens / g.budget_tokens;
      if (frac >= 1 && g.status !== "PAUSED") {
        findings.push({
          rule: "budget_exhausted",
          grpId: g.id,
          severity: "blocker",
          say: msg`${{ name: g.name }} spent its whole budget (${{ tokens: g.spent_tokens }} tokens) and is suspended`,
        });
        await hold(ctx.db, g.id, { reason: "budget", settled: true });
        // A notification says it stopped; it does not put a decision in front of
        // anyone. Without a row in the queue the group sat suspended, `Resume` did
        // nothing the scheduler would honour, and the only visible state was a
        // paused group with no reason attached. The key is what `raiseBudget` in
        // `api/panel/group.ts` closes, so the sentence is only a sentence: it used
        // to carry a literal `budget: ` prefix for a `LIKE` to find.
        await raise(ctx.db, {
          grpId: g.id,
          lang: outputLanguage(ctx.config),
          brief: msg`out of budget — raise it or not`,
          chain: "boss",
          key: escalationKey.budget,
          dedupe: { scope: "group", grpId: g.id },
          question: msg`${{ name: g.name }} has spent all ${{ tokens: g.budget_tokens }} of its tokens and the whole group is suspended. Raise the cap and it carries on, or leave it stopped here.`,
        });
      } else if (frac >= 0.8) {
        findings.push({
          rule: "budget_80",
          grpId: g.id,
          severity: "advisory",
          say: msg`${{ name: g.name }} is at ${{ pct: Math.round(frac * 100) }}% of its budget`,
        });
      }
    }
  });

  // 6. Quota came back. docs/project/plan.md §11 says a rate-limited group waits for the reset,
  // and waiting is only useful if something is watching the clock.
  await step({ id: "6", name: "rate_limit_resumed", every: EVERY_TICK }, async () => {
    const throttled = await ctx.db
      .select({ id: grp.id, name: grp.name })
      .from(grp)
      .where(and(eq(grp.status, "PAUSED"), isNotNull(grp.rl_resets_at), lte(grp.rl_resets_at, now())));
    for (const g of throttled) {
      await release(ctx, g.id);
      await ctx.bus.emit({
        grpId: g.id,
        author: "orchestrator",
        kind: "state_change",
        say: msg`quota is back, resuming`,
      });
      findings.push({
        rule: "rate_limit_resumed",
        grpId: g.id,
        severity: "advisory",
        say: msg`quota is back, resuming`,
      });
    }
  });

  // 7d2. Turn logs, compressed then dropped. Worth keeping — every measurement in
  // docs/project/progress.md came out of these files — but not uncompressed.
  await step({ id: "7d2", name: "turn_logs_swept", every: EVERY_TICK }, async () => {
    sweepTurnLogs(join(cfg.dataDir, "turns"), now());
    sweepCodexSessions(join(cfg.dataDir, "codex-home"), now());
  });

  // 7d2b. The same sweep, in the containers where the files actually are. Hourly
  // and in parallel: a seven-day retention window does not need enforcing twice a
  // minute. The cadence is declared beside the rule and enforced by `step`, so it
  // survives a restart and is not shared with a second tick.
  await step({ id: "7d2b", name: "container_sessions_swept", every: HOURLY }, async () => {
    await pMap(
      await liveScopes(ctx.db),
      (s) => execIn(ctx, s, `find ${CODEX_HOME}/sessions -type f -mtime +7 -delete 2>/dev/null || true`),
      // `stopOnError: false` is what `allSettled` meant here: one container that
      // refuses must not cancel the sweep of the other nine.
      { concurrency: EXEC_FANOUT, stopOnError: false },
    );
  });

  // 7d3. How much of the claude subscription is left. codex reports both windows
  // in every turn; claude's stream reports none, so the only way to put the two
  // side by side is to ask. It swallows its own failures — the endpoint is
  // undocumented and nothing here may depend on it — and is injectable, being the
  // one thing in this tick that talks to the network.
  await step({ id: "7d3", name: "subscription_usage", every: EVERY_TICK }, async () => {
    await (deps.pollUsage ?? pollUsage)(ctx, cfg.dataDir, now(), () => newestRollout(ctx));
  });

  // 7e. Keep the shared repo map current.
  //
  // Deterministic and cheap — `git ls-files` plus one tree-sitter parse per file,
  // grammars loaded once per process — and only written when the render changed,
  // so a quiet repo costs one comparison. Seven groups were grepping for this.
  await step({ id: "7e", name: "repo_map", every: { everyMs: cfg.watchdog.repoMapEveryMs } }, async () => {
    for (const p of await ctx.db
      .select({ id: project.id, repo_path: project.repo_path, remote: project.remote })
      .from(project)) {
      await refreshMap(ctx, p, findings);
    }
  });

  // 8. A live group with nothing queued. Every way a turn can end is terminal and
  // nothing re-queues, so a turn that ends without arranging the next one leaves
  // the group RUNNING with no error anywhere. The queue being empty under a live
  // group IS the fault, whatever the last turn's exit code said. One automatic
  // retry, then the boss.
  await step({ id: "8", name: "stalled", every: EVERY_TICK }, async () => {
    // Every state a turn can be dispatched from, not a list retyped here. It said
    // RUNNING and PLANNING, which was the same set until PR feedback stopped moving
    // groups out of PR_OPEN — and a PM turn that dies answering a review would then
    // have been covered by nothing at all.
    const newest = alias(job, "newest");
    const queued = alias(job, "queued");
    const stalled = await ctx.db
      .select({
        id: job.id,
        kind: job.kind,
        grp_id: job.grp_id,
        agent_id: job.agent_id,
        slice_id: job.slice_id,
        payload_json: job.payload_json,
        priority: job.priority,
        state: job.state,
        error: job.error,
      })
      .from(job)
      .innerJoin(grp, eq(grp.id, job.grp_id))
      .where(
        and(
          inArray(grp.status, [...DISPATCHABLE_GRP_STATES]),
          eq(job.kind, "agent_turn"),
          eq(
            job.id,
            ctx.db
              .select({ id: max(newest.id) })
              .from(newest)
              .where(and(eq(newest.grp_id, job.grp_id), eq(newest.kind, "agent_turn"))),
          ),
          notExists(
            ctx.db
              .select({ id: queued.id })
              .from(queued)
              .where(and(eq(queued.grp_id, job.grp_id), inArray(queued.state, [...ACTIVE_JOB_STATES]))),
          ),
        ),
      );
    for (const j of stalled) {
      // A rebase that beat the Engineer twice is a design question, not a harder
      // rebase, so the next thing to try is the role that can say whether the slice
      // still makes sense. `conflict` marks a turn that was *told* to rebase (rule
      // 15), not one that failed to — hence `state === 'failed'` as well: a turn
      // that ended `done` is a stall, which is the branch below.
      const payload = valueOr(j.payload_json, z.looseObject({ conflict: z.boolean().optional() }), {});
      if (payload.conflict === true && j.state === "failed") {
        await ctx.sched.enqueue("agent_turn", {
          grp_id: j.grp_id,
          priority: 6,
          payload: {
            role: roleFor(ctx, "cut_boundary"),
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
      if ((await resumeReclaimed(ctx.sched, [j])) > 0) continue;
      findings.push({
        rule: "stalled",
        grpId: j.grp_id,
        severity: "blocker",
        // `{why}` is exception text, not a sentence of ours: `payloadError` in
        // `scheduling/scheduler.ts` writes `invalid <kind> payload: <error.message>`,
        // where the prefix is scaffolding that gives the message a context and the
        // message is the content. Naming it would mean changing what the
        // `jobs.error` column holds, which the scheduler and the CLI both read.
        say: msg`group is RUNNING with an empty queue, and one re-queue did not revive it. Last failure: ${{ why: j.error ?? "" }}`,
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
    // `returning` rather than a row count: it is the one form both drivers under
    // `DB` report the same way, and the ids cost nothing on a set this size.
    const orphanQueued = await ctx.db
      .update(job)
      .set({ state: "cancelled", ended_at: now(), error: "the group was dissolved" })
      .where(
        and(
          eq(job.state, "pending"),
          inArray(job.grp_id, ctx.db.select({ id: grp.id }).from(grp).where(eq(grp.status, "DISSOLVED"))),
        ),
      )
      .returning({ id: job.id });
    if (orphanQueued.length > 0) {
      await ctx.bus.emit({
        author: "orchestrator",
        kind: "state_change",
        say: msg`cancelled ${plural({ n: orphanQueued.length }, { one: "# job", other: "# jobs" })} queued for a dissolved group`,
      });
    }
  });

  // 11. A question stranded below the boss on a group that cannot answer it.
  // route() sends these to the boss, but only at the moment they are routed — a
  // group can stop *after* a question was handed to its PM. The symptom is the
  // worst kind: a stopped group, and a `To do` count of zero.
  await step({ id: "11", name: "stranded_question", every: EVERY_TICK }, async () => {
    // Blockers only, same reason route() lifts only blockers: an advisory that
    // nobody answers costs nothing, and a clearance denial is a JSON blob about
    // a tool call rather than a decision anyone can take.
    const stranded = await ctx.db
      .select({ id: escalation.id })
      .from(escalation)
      .innerJoin(grp, eq(grp.id, escalation.grp_id))
      .where(
        and(
          isNull(escalation.answer),
          eq(escalation.severity, "blocker"),
          ne(escalation.chain_state, "boss"),
          notInArray(escalation.chain_state, [...ESCALATION_TERMINAL_STATES]),
          notInArray(grp.status, [...DISPATCHABLE_GRP_STATES]),
          // Rule 16 revokes these. Without the second clause this routes them to the
          // boss — notification and all — and rule 16 kills the question afterwards.
          notInArray(grp.status, [...ANSWERLESS_GRP_STATES]),
        ),
      );
    for (const e of stranded) await route({ ctx, ...(ctx.notifyBoss ? { notifyBoss: ctx.notifyBoss } : {}) }, e.id);
  });

  // 10. The group it was waiting on has landed. `orch blocked` stops the caller,
  // and without this it waits forever: nothing else in the system knows that one
  // group's merge is another group's green light.
  await step({ id: "10", name: "unblocked", every: EVERY_TICK }, async () => {
    const target = alias(grp, "target");
    const waiting = await ctx.db
      .select({ id: grp.id, name: grp.name, blocked_on: grp.blocked_on })
      .from(grp)
      .innerJoin(target, eq(target.id, grp.blocked_on))
      .where(and(isNotNull(grp.blocked_on), eq(target.status, "DISSOLVED")));
    for (const g of waiting) {
      await release(ctx, g.id);
      await ctx.bus.emit({
        grpId: g.id,
        author: "orchestrator",
        kind: "state_change",
        say: msg`grp ${{ target: String(g.blocked_on) }} landed; resuming by itself`,
      });
      // Rule 8 above requeues a live group with an empty queue, so the turn itself
      // comes from there — this only has to make the group live again.
      findings.push({
        rule: "unblocked",
        grpId: g.id,
        severity: "advisory",
        say: msg`grp ${{ target: String(g.blocked_on) }} landed; resuming by itself`,
      });
    }
  });

  // 7. Paused too long: notify, then park to stop holding a slot.
  await step({ id: "7", name: "paused_too_long", every: EVERY_TICK }, async () => {
    // `rl_resets_at IS NULL`: a group waiting for quota is not waiting for the boss,
    // and parking it would retire its sessions minutes before it could resume.
    // `blocked_on IS NULL` for the same reason: it is waiting on another group,
    // not on anyone here, and parking would retire the sessions that are about to
    // be woken.
    const paused = await ctx.db
      .select({ id: grp.id, name: grp.name, paused_at: grp.paused_at })
      .from(grp)
      .where(and(eq(grp.status, "PAUSED"), isNotNull(grp.paused_at), isNull(grp.rl_resets_at), isNull(grp.blocked_on)));
    for (const g of paused) {
      const waited = now() - (g.paused_at ?? now());
      if (waited >= cfg.parkAfterPausedMs) {
        await park(ctx, g.id, `waited ${minutes(waited)} min for you`);
        findings.push({
          rule: "parked",
          grpId: g.id,
          severity: "advisory",
          say: msg`${{ name: g.name }} parked after waiting ${{ min: minutes(waited) }} min — checkout kept, slot freed`,
        });
      } else if (waited >= limits(ctx).pausedNotifyMs) {
        findings.push({
          rule: "waiting_on_you",
          grpId: g.id,
          severity: "blocker",
          say: msg`${{ name: g.name }} has been waiting ${{ min: minutes(waited) }} min for you`,
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
    const revivable = await ctx.db
      .select({ id: grp.id, name: grp.name })
      .from(grp)
      .where(
        and(
          eq(grp.status, "PARKED"),
          isNotNull(grp.paused_at),
          exists(
            ctx.db
              .select({ id: escalation.id })
              .from(escalation)
              .where(
                and(
                  eq(escalation.grp_id, grp.id),
                  eq(escalation.severity, "blocker"),
                  isNotNull(escalation.answer),
                  gt(escalation.answered_at, grp.paused_at),
                ),
              ),
          ),
          notExists(
            ctx.db
              .select({ id: escalation.id })
              .from(escalation)
              .where(and(eq(escalation.grp_id, grp.id), isNull(escalation.answer), eq(escalation.severity, "blocker"))),
          ),
        ),
      );
    for (const g of revivable) {
      await unpark(ctx, g.id);
      findings.push({
        rule: "unparked",
        grpId: g.id,
        severity: "advisory",
        say: msg`${{ name: g.name }} is no longer waiting on anything — woken up`,
      });
    }
  });

  // 15. A live branch is told once per remote base to rebase before PR time.
  await step({ id: "15", name: "base_moved", every: EVERY_TICK }, () => nudgeMovedBases(ctx, findings, now));

  // 14. Parked and forgotten. It will not come back on its own and will not ask
  // again, so the one thing owed is a reminder that says how long.
  await step({ id: "14", name: "waiting_parked", every: EVERY_TICK }, async () => {
    for (const g of await ctx.db
      .select({ id: grp.id, name: grp.name, paused_at: grp.paused_at })
      .from(grp)
      .where(
        and(eq(grp.status, "PARKED"), isNotNull(grp.paused_at), lt(grp.paused_at, now() - limits(ctx).nudgeAfterMs)),
      )) {
      findings.push({
        rule: "waiting_parked",
        grpId: g.id,
        severity: "advisory",
        say: msg`${{ name: g.name }} has been parked ${{ hours: hours(now() - (g.paused_at ?? now())) }}h — wake it, or drop it?`,
      });
    }
  });

  // 17. A dissolved group's sandbox. Two containers per group — the sandbox and
  // its egress sidecar — and neither goes away on its own until the TTL runs out,
  // which is a day. `pause` is not the cheap alternative it looks like: it is a
  // real `docker pause`, so the container and its disk both stay (docs/adr/005).
  // Only kill frees anything.
  await step({ id: "17", name: "sandbox_swept", every: EVERY_TICK }, async () => {
    for (const g of await ctx.db
      .select({ id: grp.id, name: grp.name })
      .from(grp)
      .where(and(eq(grp.status, "DISSOLVED"), isNotNull(grp.sandbox_id)))) {
      await killSandbox(ctx, { grp: g.id });
      findings.push({
        rule: "sandbox_swept",
        grpId: g.id,
        severity: "advisory",
        say: msg`${{ name: g.name }} dissolved; its sandbox is reclaimed`,
      });
    }
  });

  // 17b. A sandbox older than the credential it is supposed to be using. A sidecar
  // is loaded once, when its sandbox is built, so storing a credential has to kill
  // the running sandboxes. Not left to the callers — the next way to store one
  // would have to remember, and forgetting looks healthy here. A fact about the
  // row, checked here, whichever path stored it.
  await step({ id: "17b", name: "sandbox_stale_credential", every: EVERY_TICK }, async () => {
    const [credential] = await ctx.db.select({ at: maxMs(runtime_auth.updated_at) }).from(runtime_auth);
    const newestCredential = credential?.at ?? 0;
    if (newestCredential) {
      // Not the dissolved ones: the sweep above already took theirs, and killing
      // the same container twice is a finding the boss cannot act on. A null
      // `sandbox_at` is older than any credential, which is what the `coalesce`
      // said before there was a way to spell it as a condition.
      for (const g of await ctx.db
        .select({ id: grp.id, name: grp.name })
        .from(grp)
        .where(
          and(
            isNotNull(grp.sandbox_id),
            ne(grp.status, "DISSOLVED"),
            or(isNull(grp.sandbox_at), lt(grp.sandbox_at, newestCredential)),
          ),
        )) {
        await killSandbox(ctx, { grp: g.id });
        findings.push({
          rule: "sandbox_stale_credential",
          grpId: g.id,
          severity: "advisory",
          say: msg`${{ name: g.name }}'s sandbox is bound to a superseded credential; reclaimed, and the next tick rebuilds it`,
        });
      }
      for (const p of await ctx.db
        .select({ id: project.id })
        .from(project)
        .where(
          and(isNotNull(project.sandbox_id), or(isNull(project.sandbox_at), lt(project.sandbox_at, newestCredential))),
        )) {
        await killSandbox(ctx, { project: p.id });
      }
      // The utility container matters most: its sidecar holds the GitHub token, so
      // a rotated login leaves it pushing with the old one — and a push refused for
      // authentication is the boss-bucket failure 007 §6 says must never present as
      // an agent problem.
      const util = await utilSandbox(ctx.db);
      if (util.id && util.at < newestCredential) await killSandbox(ctx, UTIL);
    }
  });

  // 18. A live container expiring under whatever is using it. The TTL stops a
  // crashed orchestrator leaking containers forever, so it is short enough to reap
  // a group that is merely thinking, and renewing every tick is the other half of
  // that bargain. One loop over every kind, deliberately: a third loop for the
  // utility container would guarantee the same omission a third time.
  await step({ id: "18", name: "sandbox_expiring", every: EVERY_TICK }, async () => {
    const alive: Scope[] = [
      ...(
        await ctx.db
          .select({ id: grp.id })
          .from(grp)
          .where(and(inArray(grp.status, ["RUNNING", "PR_OPEN", "PAUSED"]), isNotNull(grp.sandbox_id)))
      ).map((g) => ({ grp: g.id })),
      ...(await ctx.db.select({ id: project.id }).from(project).where(isNotNull(project.sandbox_id))).map((p) => ({
        project: p.id,
      })),
      UTIL,
    ];
    for (const scope of alive) await renewSandbox(ctx, scope);
  });

  // 19. The sandbox server is gone. Fires on **absence** and nothing else: one
  // present but refusing would only be restarted into a loop. Two more guards,
  // because an automatic action that keeps trying is how a crash loop becomes an
  // outage — only an argv we have **seen** this process run, and a hard cap.
  await step({ id: "19", name: "sandbox_server", every: EVERY_TICK }, async () => {
    const present = serverPresent(deps);
    if (present) serverRestarts = 0;
    switch (serverAction(present, seenServerArgv, serverRestarts, now(), nextServerTry)) {
      case "give_up":
        nextServerTry = now() + limits(ctx).reemitMs;
        findings.push({
          rule: "server_gone",
          grpId: null,
          severity: "blocker",
          say: msg`opensandbox-server will not start; ${plural({ n: SERVER_RESTART_CAP }, { one: "# attempt", other: "# attempts" })} and no more automatic retries. Run it by hand to see what it says: ${{ cmd: seenServerArgv!.join(" ") }}`,
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
          // `err` verbatim: it is a descriptor now and one cannot nest in another.
          // The attempt number leaves the failing branch with it — `give_up` below
          // is what says how many there were, and it says it once.
          say:
            err ??
            msg`opensandbox-server was gone and has been restarted (attempt ${{ n: serverRestarts }}). Held work resumes by itself.`,
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
    for (const e of await ctx.db
      .select({ id: escalation.id, grp_id: escalation.grp_id, name: grp.name })
      .from(escalation)
      .innerJoin(grp, eq(grp.id, escalation.grp_id))
      .where(
        and(
          notInArray(escalation.chain_state, [...ESCALATION_TERMINAL_STATES]),
          inArray(grp.status, [...ANSWERLESS_GRP_STATES]),
        ),
      )) {
      await ctx.db
        .update(escalation)
        .set({
          chain_state: "revoked",
          answered_by: "orchestrator",
          // English, like every other answer this server writes itself — `escalation.answer`
          // is a text column the panel draws raw, with no descriptor beside it, and
          // `opened #N instead`, `reconfigured` and `reopened` are already its
          // neighbours. A `Said` here would need a column to ride in.
          answer: "the requirement reached PR, so this question expired; nobody is waiting on the reply",
          answered_at: now(),
        })
        .where(eq(escalation.id, e.id));
      // Whatever asked is long gone, but a waiter left hanging keeps a job row alive.
      answered(ctx, e.id, "stale: the group reached PR");
      findings.push({
        rule: "stale_ask",
        grpId: e.grp_id,
        severity: "advisory",
        say: msg`${{ name: e.name }} reached PR, so the question still hanging on it expired — closed by itself`,
      });
    }
  });

  // 13. The three places that wait on the boss, with a clock on each. They are
  // supposed to wait; what was missing is that they waited in silence.
  await step({ id: "13", name: "boss_clocks", every: EVERY_TICK }, async () => {
    for (const w of await waitingOnBoss(ctx.db, now(), limits(ctx).nudgeAfterMs)) findings.push(w);
  });

  return await emit(ctx, findings, now);
}

/**
 * A standing condition is re-detected on every tick, and a repeat is a reminder
 * rather than a new problem — so the event log backs off the way the notifier
 * already does. The returned list is filtered to the same set, not just the
 * emitted events: it is what the caller pushes to the boss's phone.
 */
async function emit(ctx: Ctx, findings: Finding[], now: () => number): Promise<Finding[]> {
  const fresh: Finding[] = [];
  for (const f of findings) {
    // `IS NULL` where the finding has no group, not `= NULL`: the old statement
    // said `grp_id IS ?`, which is SQLite's null-safe equality and has no operator
    // form here — a finding about no group must match the rows about no group.
    const [last] = await ctx.db
      .select({ at: maxMs(event.at) })
      .from(event)
      .where(
        and(
          eq(event.kind, "escalation"),
          eq(event.author, "watchdog"),
          sql`${event.meta_json}->>'rule' = ${f.rule}`,
          f.grpId === null ? isNull(event.grp_id) : eq(event.grp_id, f.grpId),
        ),
      );
    const l = limits(ctx);
    const window = f.rule.startsWith("waiting_") ? l.nudgeReemitMs : l.reemitMs;
    if (last?.at && now() - last.at < window) continue;
    fresh.push(f);
    await ctx.bus.emit({
      grpId: f.grpId,
      author: "watchdog",
      kind: "escalation",
      intent: "ask",
      severity: f.severity,
      say: f.say,
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
export async function holdForOffline(ctx: Ctx, now: number): Promise<number> {
  const running = await ctx.db
    .select({
      id: job.id,
      kind: job.kind,
      grp_id: job.grp_id,
      agent_id: job.agent_id,
      slice_id: job.slice_id,
      payload_json: job.payload_json,
      priority: job.priority,
      state: job.state,
    })
    .from(job)
    .where(and(eq(job.state, "running"), eq(job.kind, "agent_turn")));
  if (running.length === 0) return 0;

  for (const j of running) {
    abortJob(j.id);
    await ctx.db
      .update(job)
      .set({ state: "cancelled", ended_at: now, error: "offline: the host lost its network" })
      .where(eq(job.id, j.id));
  }
  // An agent that believes it is mid-turn is skipped forever by everything else.
  await ctx.db.update(agent).set({ state: "idle" }).where(eq(agent.state, "running"));
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
export async function recordTurnOutcome(
  ctx: Ctx,
  agentId: number,
  filesTouched: string[],
  wroteNote: boolean,
  movedTask: boolean,
): Promise<void> {
  const productive = filesTouched.length > 0 || wroteNote || movedTask;
  await ctx.db
    .update(agent)
    .set({ idle_turns: productive ? 0 : sql`${agent.idle_turns} + 1` })
    .where(eq(agent.id, agentId));

  // One file, alone, repeatedly: the signature of an agent guessing.
  const single = filesTouched.length === 1 ? filesTouched[0]! : null;
  if (!single) {
    await ctx.db.update(agent).set({ loop_file: null, loop_count: 0 }).where(eq(agent.id, agentId));
    return;
  }
  const [row] = await ctx.db.select({ loop_file: agent.loop_file }).from(agent).where(eq(agent.id, agentId));
  if (row?.loop_file === single) {
    await ctx.db
      .update(agent)
      .set({ loop_count: sql`${agent.loop_count} + 1` })
      .where(eq(agent.id, agentId));
  } else {
    await ctx.db.update(agent).set({ loop_file: single, loop_count: 1 }).where(eq(agent.id, agentId));
  }
}
