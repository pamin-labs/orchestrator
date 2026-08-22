/**
 * Every state a first-class entity can rest in.
 *
 * Written here and nowhere else, so `invariants.ts` can be checked against it: a
 * state with no invariant row is a state nobody is driving, which is how a group
 * ends up RUNNING forever with an empty queue and no error. Adding a state fails the
 * build until the table says who pushes it.
 *
 * If the transition out of a state never fires, who notices?
 */

export const GRP_STATES = [
  "PLANNING",
  "DRAFT",
  "RUNNING",
  "PAUSING",
  "PAUSED",
  "PARKED",
  "PR_OPEN",
  "DISSOLVED",
] as const;

export const SLICE_STATES = ["pending", "running", "gate", "qa", "awaiting_boss", "accepted", "rejected"] as const;

export const TASK_STATES = ["pending", "in_progress", "done"] as const;

export const JOB_STATES = ["pending", "running", "done", "failed", "cancelled"] as const;

/**
 * A gate or a command an agent asked for, and is **blocked on**.
 *
 * The only state list here whose resting states have an agent parked on them:
 * `orch lease` does not return until `finishLease` resolves the waiter, and
 * neither the route nor the agent's poll loop has a deadline. So a lease that
 * stops moving is not a slow gate, it is an agent that never takes another turn
 * — which is why these rows exist and why every path through `runLease` now ends
 * in `finishLease` whatever happens to it.
 */
export const LEASE_STATES = ["queued", "running", "done", "failed"] as const;

/**
 * A lease that has not finished, so it is still the one an agent is parked on.
 *
 * `finishLease` guards its UPDATE on these two, which is what makes it the single
 * resolver: a second finish for the same lease changes no rows and resolves no
 * waiter twice. It was written into the SQL, where nothing checked it against
 * this list.
 */
export const ACTIVE_LEASE_STATES = ["queued", "running"] as const satisfies readonly LeaseState[];

/** `pm | architect | cos | boss` are in-flight; the last two are terminal. */
export const ESCALATION_STATES = ["pm", "architect", "cos", "boss", "answered", "revoked"] as const;

/**
 * The utility container, which is one per orchestrator and belongs to no row.
 *
 * Two resting states and they are not symmetric. `down` is the ordinary one — it
 * is built on demand and there is nothing to keep alive between pushes — but it
 * is also what "nothing can reach GitHub any more" looks like, and those two
 * must not be told apart by guessing.
 */
export const UTIL_STATES = ["down", "up"] as const;

/**
 * Whether a project's GitHub is answering (007 §6).
 *
 * `repo_held` is a resting state in the strict sense and the reason it is in this
 * table: nothing dispatches for that project, and every group underneath it still
 * reads RUNNING with an agent on the roster. It is not a column — the hold lives
 * in memory, keyed by `owner/repo` — but the question this table asks is "if the
 * way out never fires, who notices", and that question does not care where the
 * state is stored.
 */
export const PROJECT_STATES = ["reachable", "repo_held"] as const;

/**
 * The sandbox server, which is the one host dependency that runs containers.
 *
 * Three states that look identical from the panel and want three different
 * answers — which is the whole reason they are written down. `absent` wants a
 * restart; `refusing` must **not** be restarted, because that is how a crash
 * loop becomes a restart loop; and `stale_config` is not a restart problem at
 * all — the process is healthy and the only symptom is an empty directory
 * inside every container.
 */
export const SERVER_STATES = ["up", "absent", "refusing", "stale_config"] as const;

export type GrpState = (typeof GRP_STATES)[number];
export type UtilState = (typeof UTIL_STATES)[number];
export type ServerHealthState = (typeof SERVER_STATES)[number];
export type ProjectState = (typeof PROJECT_STATES)[number];
export type SliceState = (typeof SLICE_STATES)[number];
export type TaskState = (typeof TASK_STATES)[number];
export type JobState = (typeof JOB_STATES)[number];
export type LeaseState = (typeof LEASE_STATES)[number];
export type EscalationState = (typeof ESCALATION_STATES)[number];

/** Jobs that still occupy a queue or executor slot. */
export const ACTIVE_JOB_STATES = ["pending", "running"] as const satisfies readonly JobState[];

/** Group states in which an agent turn can run and answer a routed question. */
export const DISPATCHABLE_GRP_STATES = ["PLANNING", "RUNNING", "PR_OPEN"] as const satisfies readonly GrpState[];
/**
 * A group with nobody left to answer a question.
 *
 * Shared by the two watchdog rules that would otherwise disagree in a way only
 * their order in the file resolved: one routes a stranded question up to the boss,
 * the other revokes questions here. Routing first meant a push notification for a
 * question revoked later in the same sweep.
 */
export const ANSWERLESS_GRP_STATES = ["PR_OPEN", "DISSOLVED"] as const satisfies readonly GrpState[];

/**
 * A group that is over. Nothing may move it, and `invariants.ts` declares it
 * terminal rather than giving it a driver.
 */
export const GRP_TERMINAL_STATES = ["DISSOLVED"] as const satisfies readonly GrpState[];

/** A question in any of these states can still move through the answer chain. */
export const ESCALATION_OPEN_STATES = ["pm", "architect", "cos", "boss"] as const satisfies readonly EscalationState[];
export type EscalationOpenState = (typeof ESCALATION_OPEN_STATES)[number];

/** A question in either state is closed: no routing, dedupe, display, or repair. */
export const ESCALATION_TERMINAL_STATES = ["answered", "revoked"] as const satisfies readonly EscalationState[];
export type EscalationTerminalState = (typeof ESCALATION_TERMINAL_STATES)[number];

const dispatchableGrpStates = new Set<GrpState>(DISPATCHABLE_GRP_STATES);
const terminalEscalationStates = new Set<EscalationState>(ESCALATION_TERMINAL_STATES);

export const isDispatchableGrpState = (state: GrpState): boolean => dispatchableGrpStates.has(state);
export const isTerminalEscalationState = (state: EscalationState): state is EscalationTerminalState =>
  terminalEscalationStates.has(state);

/**
 * What a question is about — one required word, and the routing is which half of
 * the list it falls in.
 *
 * This was two enums on one call: a `kind` for the queue heading that fell back
 * to `other`, and a `reserved` topic that decided whether the PM may answer. Two
 * axes for one fact, and the second needed a `none` — a reason that is not a
 * reason. An escalation is always *about* something, so naming that once decides
 * both.
 */
/**
 * ASCII, and the same word whatever the asker writes in: this is a protocol key,
 * which is one of ADR 035's three exemptions from the panel's own language.
 * It replaced ten rows of per-language keyword regex whose own comment recorded
 * sixteen of eighteen probes leaking.
 */
/**
 * Ordered, and the order is the rule: a question can be about two of these —
 * "swap Postgres for SQLite to cut hosting cost" is `design` and `budget` — so
 * the asker picks **the one that raises highest**, and the five that raise are
 * first. `TO_BOSS` is the reserved half; the rest start at the PM.
 */
export const ASK_KINDS = [
  "budget",
  "merge",
  "credential",
  "deploy",
  "scope",
  "env",
  "spec",
  "boundary",
  "design",
] as const;
export type AskKind = (typeof ASK_KINDS)[number];

/**
 * What a journal entry can be, and it is a protocol vocabulary like the one
 * above — the CLI offers it in `--help`, the validator parses it, the role
 * prompts name three of these by hand.
 *
 * Here rather than in `mech/util/validate.ts` because `src/orch` may import
 * contracts and nothing else: the CLI's help listed five of the eight by hand
 * and left out `lesson`, `onboarding` and `handoff`, two of which the prompts
 * tell agents to use, and `dispatch.ts` is the only manual a sandboxed agent has.
 */
export const JOURNAL_KINDS = [
  "fact",
  "decision",
  "journal",
  "retro",
  "handoff",
  "risk",
  "onboarding",
  "lesson",
] as const;

/**
 * The five the PM may not answer on the boss's behalf. Declaring one of the
 * other four does not *stop* the gate — `chain.ts` asks a second reader whether
 * the question is one of these anyway, because the agent that saves a round trip
 * by misfiling is the same agent that files.
 */
export const TO_BOSS: ReadonlySet<AskKind> = new Set<AskKind>(["budget", "merge", "credential", "deploy", "scope"]);

export const isAskKind = (value: string): value is AskKind => (ASK_KINDS as readonly string[]).includes(value);
