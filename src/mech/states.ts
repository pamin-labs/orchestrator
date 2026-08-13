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

/** `pm | architect | cos | boss` are in-flight; the last two are terminal. */
export const ESCALATION_STATES = ["pm", "architect", "cos", "boss", "answered", "revoked"] as const;

export type GrpState = (typeof GRP_STATES)[number];
export type SliceState = (typeof SLICE_STATES)[number];
export type JobState = (typeof JOB_STATES)[number];
export type EscalationState = (typeof ESCALATION_STATES)[number];
