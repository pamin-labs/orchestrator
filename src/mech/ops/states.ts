/**
 * Every state a first-class entity can rest in.
 *
 * Written down here, and nowhere else, so that `invariants.ts` can be checked
 * against it: a state with no invariant row is a state nobody is driving, which
 * is how a group ends up RUNNING forever with an empty queue and no error. The
 * check is a test, so adding a state to this file fails the build until the table
 * says who pushes it.
 *
 * "Resting" is the operative word. These are states the system can sit in between
 * turns — the question each one has to answer is: if the transition out of here
 * never fires, who notices?
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

export const SLICE_STATES = [
  "pending",
  "running",
  "self_review",
  "gate",
  "qa",
  "awaiting_boss",
  "accepted",
  "rejected",
] as const;

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
export const LEASE_STATES = ["queued", "running", "done", "failed", "cancelled"] as const;

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
export type ServerState = (typeof SERVER_STATES)[number];
export type ProjectState = (typeof PROJECT_STATES)[number];
export type SliceState = (typeof SLICE_STATES)[number];
export type JobState = (typeof JOB_STATES)[number];
export type LeaseState = (typeof LEASE_STATES)[number];
export type EscalationState = (typeof ESCALATION_STATES)[number];
