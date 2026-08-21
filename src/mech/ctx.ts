import type { DB } from "../platform/persistence/database.ts";
import type { Bus } from "../platform/persistence/event-bus.ts";
import type { Scheduler } from "../platform/scheduling/scheduler.ts";
import type { Capability, Config, Roles } from "../platform/config/load.ts";
import { loadRoles, roleWith } from "../platform/config/load.ts";

/**
 * The handle everything below the HTTP layer is given.
 *
 * Here rather than next to the routes because eighteen files under `src/mech/**`
 * want this type and nothing else from `api.ts` — importing it from there made every
 * one of them depend on the whole route table, in fourteen two-file cycles.
 *
 * Taking the whole `Ctx` where one field would do is the other half: a function that
 * needs the database should say `db: DB`.
 */
export interface Ctx {
  db: DB;
  bus: Bus;
  sched: Scheduler;
  /** Resolves a blocking `ask-boss` call. Written through `awaitAnswer`/`answered`. */
  waiters: Map<string, (value: string) => void>;
  /**
   * Retrieval for `orch ctx query`. Absent in unit tests that never search.
   *
   * Here rather than reached for from a module because it is state: the index is
   * built once and kept fresh, which needs an owner, and the composition layer
   * is the one place that can say when it comes into being.
   */
  notes?: import("./knowledge/note-index.ts").NoteIndex;
  /** Where turns, gates and leases run. Absent in unit tests that need no container. */
  sandbox?: import("./sandbox/sandbox.ts").SandboxDriver;
  /** Talks to GitHub's REST API. Absent in unit tests that need no GitHub. */
  gh?: import("./git/github.ts").Github;
  /**
   * One cheap model call, for PageIndex navigation. Absent in unit tests.
   *
   * A factory, not a closure, because the call runs **in a sandbox** and which
   * one depends on the project. It used to be a host `Bun.spawn` with the boss's
   * own CLI login — a second credential path nothing in the settings page could
   * see, whose failure mode was a permanently empty index that looked built.
   */
  askIn?: (scope: import("./sandbox/sandbox.ts").Scope) => import("./knowledge/pageindex.ts").Ask;
  /** Wired by the server: advances the review pipeline on a QA verdict. */
  reviewVerdict?: (sliceId: number, pass: boolean, note: string) => Promise<void>;
  /** Wired by the server: the Auditor's PR-level verdict. */
  auditVerdict?: (grpId: number, pass: boolean, note: string) => Promise<void>;
  /**
   * Wired by the server: squash, push, open the PR.
   *
   * Not called by the audit any more. A passed audit means the branch may be
   * published; the Scribe's message is what it is published *as*, and this runs
   * when that lands — or when the watchdog stops waiting for one.
   */
  publishBranch?: (grpId: number) => void;
  /** Wired by the server: a watchdog finding worth telling the boss about. */
  onFinding?: (rule: string, severity: string, body: string, grpId: number | null) => void;
  /** Rebuild the checkout after a group sandbox is replaced. */
  restoreWorkspace?: (grpId: number) => Promise<void>;
  /** Wired by the server: a question that reached the top of the answer chain. */
  notifyBoss?: (escId: number, question: string, severity: string) => void;
  /**
   * Wired by the server: hire an agent for a role that has none yet.
   *
   * Standing roles are event-triggered, and the first message addressed to one IS
   * the event — otherwise mailing the Architect before an Architect exists is a
   * silent no-op, and the sender waits on a reply that can never come.
   */
  hire?: (grpId: number | null, role: string, projectId?: number | null) => Promise<number | null>;
  /** Wired by the server: role names that exist in roles/*.yaml. */
  knownRoles?: () => string[];
  /**
   * Wired by the server: what the readiness timer last found, already computed.
   *
   * A getter and not a value because the timer replaces the array every tick.
   * Running the checks costs host round trips and stays on that timer; *reading*
   * the result costs nothing, which is why the panel snapshot may have it.
   * Structural rather than `preflight.Check` so this file keeps importing nothing.
   */
  checks?: () => ReadonlyArray<{ name: string; ok: boolean; detail: string; fix?: string }>;
  /**
   * Wired by the server: run them now, publish the result, hand it back.
   *
   * The settings page asks after the boss has just fixed something, and it used
   * to run its own copy — so the pane went green while the shell's banner kept
   * quoting the answer the timer last found. Two runs of one question is two
   * answers, and the fresher one was the one nobody else could see.
   */
  recheck?: () => Promise<ReadonlyArray<{ name: string; ok: boolean; detail: string; fix?: string }>>;
  /**
   * The roles this installation has, wired by the server.
   *
   * `roleFor` reads it to answer "who reviews a slice" without any call site
   * naming a role. Optional so a unit test that never dispatches need not build
   * one; the fallback is the installed `roles/`, which is what those tests mean.
   */
  roles?: Roles;
  /**
   * The one config object, not a copy of the parts a handler was trusted with.
   *
   * It used to be a hand-written literal listing thirteen fields, which meant two
   * objects that could disagree — and they did: `ctx.config` never carried
   * `maxTurnsPerJob`, `turnTimeoutMs`, `sessionRotateFraction`, `gateRetries`,
   * `difficultyModel` or `contextWindow` at all. Copying was meant to stop a
   * handler reaching for whatever it liked; what it produced was a key that
   * typechecked, read back undefined, and fell through to a default.
   */
  /**
   * Complete because `loadConfig()` validates and fills every field before a
   * context exists. Tests use that same legal value and override only what they
   * exercise; a partial production state would only force fake fallbacks and casts.
   */
  config: Config;
  /**
   * What this build calls itself, for the CLI provisioned into a sandbox.
   *
   * Passed in rather than imported: `platform/process/version.ts` is the release
   * identity and mechanisms may not reach it, so composition — which may — hands
   * it down. A sandbox reporting a different version from the server that made
   * it is a support conversation nobody can win.
   */
  version?: string;
}

/** The role that has this capability. Throws when no role, or more than one, declares it. */
export function roleFor(ctx: Pick<Ctx, "roles">, cap: Capability): string {
  return roleWith(ctx.roles ?? loadRoles(), cap);
}

/**
 * The two halves of a blocking `ask-boss`, so the key has one owner.
 *
 * `awaitAnswer` must be called before the escalation is visible to anything that
 * can answer it: `route()` hands a question to a stand-in that can answer inside
 * the same tick, and an answer arriving before the waiter exists is dropped by
 * the `?.` below — the asking agent then blocks for the rest of its life.
 */
const waiterKey = (id: number): string => `escalation:${id}`;

export const awaitAnswer = (ctx: Pick<Ctx, "waiters">, id: number): Promise<string> =>
  new Promise<string>((resolve) => {
    ctx.waiters.set(waiterKey(id), resolve);
  });

/** Hand the answer to whoever is blocked on it. Nobody waiting is normal: it may be a turn. */
export function answered(ctx: Pick<Ctx, "waiters">, id: number, text: string): void {
  const waiter = ctx.waiters.get(waiterKey(id));
  ctx.waiters.delete(waiterKey(id));
  waiter?.(text);
}
