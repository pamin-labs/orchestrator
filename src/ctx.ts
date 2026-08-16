import type { DB } from "./db.ts";
import type { Bus } from "./bus.ts";
import type { Scheduler } from "./scheduler.ts";

/**
 * The handle everything below the HTTP layer is given.
 *
 * It lives here rather than next to the routes because eighteen files under
 * `src/mech/**` want this type and nothing else from `api.ts` — and importing it
 * from there made every one of them depend on the whole route table, fourteen
 * two-file import cycles between `api.ts` and the mechanisms it calls.
 *
 * Taking the whole `Ctx` where one field would do is the other half of that
 * problem. A function that needs the database should say `db: DB`; several here
 * used to take this interface for a single `db` call and joined the cycle for it.
 */
export interface Ctx {
  db: DB;
  bus: Bus;
  sched: Scheduler;
  /** Resolves a blocking `ask-boss` / `lease` call. Keyed by "kind:id". */
  waiters: Map<string, (value: string) => void>;
  /** Where turns, gates and leases run. Absent in unit tests that need no container. */
  sandbox?: import("./mech/sandbox/sandbox.ts").SandboxDriver;
  /** Talks to GitHub's REST API. Absent in unit tests that need no GitHub. */
  gh?: import("./mech/git/github.ts").Github;
  /**
   * One cheap model call, for PageIndex navigation. Absent in unit tests.
   *
   * A factory, not a closure, because the call runs **in a sandbox** and which
   * one depends on the project. It used to be a host `Bun.spawn` with the boss's
   * own CLI login — a second credential path nothing in the settings page could
   * see, whose failure mode was a permanently empty index that looked built.
   */
  askIn?: (scope: import("./mech/sandbox/sandbox.ts").Scope) => import("./mech/knowledge/pageindex.ts").Ask;
  /** Wired by the server: advances the review pipeline on a QA verdict. */
  reviewVerdict?: (sliceId: number, pass: boolean, note: string) => void;
  /** Wired by the server: the Auditor's PR-level verdict. */
  auditVerdict?: (grpId: number, pass: boolean, note: string) => void;
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
  /** Wired by the server: a question that reached the top of the answer chain. */
  notifyBoss?: (escId: number, question: string, severity: string) => void;
  /**
   * Wired by the server: hire an agent for a role that has none yet.
   *
   * Standing roles are event-triggered, and the first message addressed to one IS
   * the event — otherwise mailing the Architect before an Architect exists is a
   * silent no-op, and the sender waits on a reply that can never come.
   */
  hire?: (grpId: number | null, role: string, projectId?: number | null) => number | null;
  /** Wired by the server: role names that exist in roles/*.yaml. */
  knownRoles?: () => string[];
  config: {
    language: string;
    /** difficulty -> token cap written onto each new slice. */
    sliceBudgetTokens?: Record<string, number>;
    dataDir?: string;
    /** Where ticked skills are staged for the sandboxes to mount. */
    skillsDir?: string;
    autoAdvance?: boolean;
    autoAcceptTiers?: string[];
    /** Surfaced to the panel: how many groups may run at once, and lease slots. */
    maxGroups?: number;
    leaseSlots?: number | Record<string, number>;
    /** Same complaint this many times becomes a project rule (PLAN.md §7③). */
    feedbackSediment?: number;
    /** Chars an `orch ctx query` answer may spend. Was a setting that changed nothing. */
    ctxBudgetChars?: number;
    /** How long a gate may run. The lease route waits a minute longer than this. */
    leaseTimeoutMs?: number;
    /** Where the orchestrator listens; the mailbox replays agent calls to it. */
    port?: number;
    /** Wall clock for a dependency install. See config.ts for why it is generous. */
    installTimeoutMs?: number;
    /** Where turns run. See mech/sandbox/sandbox.ts and docs/decisions/005. */
    sandbox?: {
      server: string;
      apiKey: string;
      image: string;
      cpu: string;
      memory: string;
      ttlSeconds: number;
      denyDomains: string[];
      cacheDirs: Record<string, string>;
    };
  };
}

/** Who is calling, resolved from the `x-orch-token` an agent was issued. */
export interface Caller {
  id: number;
  grp_id: number | null;
  project_id: number | null;
  role: string;
}
