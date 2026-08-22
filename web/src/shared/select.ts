import type { Escalation, Group, Slice, State } from "./api";
import { githubRepo } from "./github";
import { z } from "zod";
import { valueOr } from "../../../src/contracts/json.ts";
import type { GrpState } from "../../../src/contracts/states.ts";
import { msg, t } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { i18n } from "../i18n";

/** A label from a partial table, or the raw value where it has no row. Four
 *  tables need it — `WHERE_LABEL` covers the four open chain states while
 *  `chain_state` also carries `answered` and `revoked`, and the rotation, note
 *  and usage tables are partial for their own reasons. A total table indexes
 *  directly. */
export const labelOf = (m: MessageDescriptor | undefined, fallback: string): string => (m ? i18n._(m) : fallback);

const OwnsSchema = z.array(z.string());
const GatesSchema = z.record(z.string(), z.string());

/**
 * DRAFT with the boss's yes already on it: waiting on a boundary, not on the boss.
 *
 * It has to be one predicate, because a row that sits in `To do` while the `To do` badge
 * does not count it is worse than either answer alone.
 */
export const heldApproved = (g: Group) => g.status === "DRAFT" && !!g.approved_at;

export const statusLabel = (g: Group) =>
  heldApproved(g) ? t`Approved · Awaiting boundary` : i18n._(STATUS_LABEL[g.status]);

/**
 * `msg` at module scope, `i18n._` at call scope. A descriptor is locale-free
 * data, so a table built once at import stays right after the locale changes;
 * a resolved string would freeze at whatever was active on first evaluation.
 *
 * `Record<GrpState, …>`, so a ninth state is a compile error rather than a raw
 * `PR_OPEN` on the panel. `Group.status` is `z.enum(GRP_STATES)`, so there is no
 * unknown state to fall back for: one this build has never heard of fails
 * `SnapshotSchema.safeParse` before it reaches here.
 */
export const STATUS_LABEL: Record<GrpState, MessageDescriptor> = {
  PLANNING: msg`Planning`,
  DRAFT: msg`Pending review`,
  RUNNING: msg`Running`,
  PAUSING: msg`Pausing`,
  PAUSED: msg`Paused`,
  PARKED: msg`Archived`,
  PR_OPEN: msg`PR open`,
  DISSOLVED: msg`Dissolved`,
};
export const WHERE_LABEL: Record<string, MessageDescriptor> = {
  pm: msg`PM working`,
  architect: msg`Architect working`,
  cos: msg`CoS working`,
  boss: msg`Awaiting your decision`,
};
/**
 * The layers actually recorded, in order.
 *
 * `self` was drawn here once while nothing recorded it, so its tick sat grey forever
 * and taught the boss to ignore the row. It is back because `orch task done --review`
 * now records it — docs/project/plan.md §7 layer 1, the only one where the writer is the reviewer.
 */
export const STOPS: [string, MessageDescriptor][] = [
  ["self", msg`Self-review`],
  ["reconcile", msg`Reconciliation`],
  ["gate", msg`Gate`],
  ["qa", msg`QA`],
];

export const owns = (g: Group) => valueOr(g.owns_json, OwnsSchema, []);
export const gates = (s: Slice) => valueOr(s.gates_json, GatesSchema, {});

const needsDraftDecision = (g: Group) => g.status === "DRAFT" && !g.approved_at;
const hasDraftDecision = (st: State, id: number) =>
  st.draftCards.some((c) => c.grpId === id) || st.dropProposals.some((p) => p.grpId === id);

/**
 * Everything that cannot move without the boss, per docs/project/plan.md's three approval points.
 *
 * Called `To do` everywhere in the panel. It used to be "waiting on you" in the nav,
 * "awaiting your decision" in the
 * requirement list and `No pending items` when empty — three names for one concept, one of which
 * was a verb phrase doing a noun's job in a nav badge.
 */
export function pending(st: State, projectId: number | null) {
  const ids = new Set((projectId ? st.groups.filter((g) => g.project_id === projectId) : st.groups).map((g) => g.id));
  return {
    // A card that has not been filed is not a decision. Counting it inflates the
    // badge and produces a queue row whose button leads to nothing actionable.
    // Neither is one already approved and waiting on a boundary — the boss decided,
    // and asking again is what made the click look like it did nothing.
    cards: st.groups.filter(
      (g) =>
        ids.has(g.id) &&
        needsDraftDecision(g) &&
        // A proposal to drop the requirement is a decision too, and it arrives
        // instead of a card — the whole point is that no card gets written.
        hasDraftDecision(st, g.id),
    ),
    slices: st.slices.filter((s) => ids.has(s.grp_id) && s.status === "awaiting_boss"),
    merges: st.mergeQueue.filter((m) => ids.has(m.grpId)),
    // grp_id is NULL for standing agents (CoS / Architect / Librarian), and
    // `orch ask-boss` blocks that agent until it is answered. Filtering them out
    // meant the agent hung forever with its question visible nowhere — but counting
    // one in every project made each project's badge include questions that were
    // not its own, so the per-project counts no longer summed to the global one.
    asks: st.escalations.filter((e) => {
      if (e.chain_state !== "boss") return false;
      if (e.grp_id != null) return ids.has(e.grp_id);
      return projectId == null || e.asker_project === projectId;
    }),
  };
}
export const countWaiting = (st: State, p: number | null) =>
  Object.values(pending(st, p)).reduce((a, x) => a + x.length, 0);

/**
 * A project's state, ordered by what should pull the eye.
 *
 * `fresh` is "nothing was ever asked of this project", which is not the same as
 * "no live group": a project whose requirements all merged also has none, and
 * calling that `Empty` denies the only work the system ever finished.
 */
export function projectState(st: State, p: number): { label: string; mine: boolean; live?: boolean; fresh?: boolean } {
  const n = countWaiting(st, p);
  if (n) return { label: t`${n} to do`, mine: true };
  const gs = st.groups.filter((g) => g.project_id === p);
  return gs.length ? activeProjectState(gs) : emptyProjectState(st, p);
}

const emptyProjectState = (st: State, p: number) =>
  (st.archived ?? []).some((a) => a.project_id === p)
    ? { label: t`All done`, mine: false }
    : { label: t`Empty`, mine: false, fresh: true };

function activeProjectState(groups: Group[]) {
  const live = groups.filter((g) => ["RUNNING", "PLANNING", "PAUSING"].includes(g.status)).length;
  if (live) return { label: t`${live} running`, mine: false, live: true };
  const held = groups.filter((g) => ["PAUSED", "PARKED"].includes(g.status)).length;
  return held ? { label: t`${held} stopped`, mine: false } : { label: t`All done`, mine: false };
}

/** Where the PR lives, so "go and merge it" is one click rather than a hunt. */
export function prUrl(st: State, g: Group) {
  const repo = githubRepo(projectRemote(st, g.project_id));
  return repo && g.pr_number ? `https://github.com/${repo}/pull/${g.pr_number}` : null;
}

const projectRemote = (st: State, projectId: number) => st.projects.find((p) => p.id === projectId)?.remote ?? "";

/**
 * This group's open questions. Answered ones are history, not a decision.
 *
 * Unfiltered, this fed a heading that said `Awaiting your decision` — so a question the boss had
 * already answered, and one the PM was still holding, both sat at the top of the
 * page under a label claiming they needed the boss.
 */
export const asksOf = (st: State, id: number): Escalation[] =>
  st.escalations.filter((e) => e.grp_id === id && !e.answer && e.chain_state !== "revoked");

/** Of those, the ones actually waiting on the boss. */
export const mineOf = (asks: Escalation[]): Escalation[] => asks.filter((e) => e.chain_state === "boss");

/** What a question is about, in the boss's words. `other` gets no label. */
export const KIND_LABEL: Record<string, MessageDescriptor> = {
  env: msg`Environment`,
  spec: msg`Acceptance criteria`,
  boundary: msg`Boundary`,
  design: msg`Design choice`,
};
