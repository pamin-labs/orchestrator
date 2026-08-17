import type { Escalation, Group, Slice, State } from "./api";
import { z } from "zod";
import { jsonOr } from "../../../src/contracts/json.ts";

const OwnsSchema = z.array(z.string());
const GatesSchema = z.record(z.string(), z.string());

/**
 * DRAFT with the boss's yes already on it: waiting on a boundary, not on the boss.
 *
 * It has to be one predicate, because a row that sits in 待办 while the 待办 badge
 * does not count it is worse than either answer alone.
 */
export const heldApproved = (g: Group) => g.status === "DRAFT" && !!g.approved_at;

export const statusLabel = (g: Group) => (heldApproved(g) ? "已批·等边界" : (STATUS_ZH[g.status] ?? g.status));

export const STATUS_ZH: Record<string, string> = {
  PLANNING: "拆解中",
  DRAFT: "待批",
  RUNNING: "在跑",
  PAUSING: "正在停",
  PAUSED: "已暂停",
  PARKED: "已封存",
  PR_OPEN: "PR 开着",
  DISSOLVED: "已解散",
};
export const WHERE_ZH: Record<string, string> = {
  pm: "PM 处理中",
  architect: "Architect 处理中",
  cos: "CoS 处理中",
  boss: "待你决策",
};
/**
 * The layers actually recorded, in order.
 *
 * `self` was drawn here once while nothing recorded it, so its tick sat grey forever
 * and taught the boss to ignore the row. It is back because `orch task done --review`
 * now records it — docs/project/plan.md §7 layer 1, the only one where the writer is the reviewer.
 */
export const STOPS: [string, string][] = [
  ["self", "自评"],
  ["reconcile", "对账"],
  ["gate", "测试"],
  ["qa", "QA"],
];

export const owns = (g: Group) => jsonOr(g.owns_json, OwnsSchema, []);
export const gates = (s: Slice) => jsonOr(s.gates_json, GatesSchema, {});

const needsDraftDecision = (g: Group) => g.status === "DRAFT" && !g.approved_at;
const hasDraftDecision = (st: State, id: number) =>
  st.draftCards.some((c) => c.grpId === id) || st.dropProposals.some((p) => p.grpId === id);

/**
 * Everything that cannot move without the boss, per docs/project/plan.md's three approval points.
 *
 * Called 待办 everywhere in the panel. It used to be 等你 in the nav, 等你决策 in the
 * requirement list and 无待办 when empty — three names for one concept, one of which
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
 * calling that 空着 denies the only work the system ever finished.
 */
export function projectState(st: State, p: number): { zh: string; mine: boolean; live?: boolean; fresh?: boolean } {
  const n = countWaiting(st, p);
  if (n) return { zh: `${n} 件待办`, mine: true };
  const gs = st.groups.filter((g) => g.project_id === p);
  return gs.length ? activeProjectState(gs) : emptyProjectState(st, p);
}

const emptyProjectState = (st: State, p: number) =>
  (st.archived ?? []).some((a) => a.project_id === p)
    ? { zh: "都做完了", mine: false }
    : { zh: "空着", mine: false, fresh: true };

function activeProjectState(groups: Group[]) {
  const live = groups.filter((g) => ["RUNNING", "PLANNING", "PAUSING"].includes(g.status)).length;
  if (live) return { zh: `${live} 个在跑`, mine: false, live: true };
  const held = groups.filter((g) => ["PAUSED", "PARKED"].includes(g.status)).length;
  return held ? { zh: `${held} 个停着`, mine: false } : { zh: "都做完了", mine: false };
}

/** Where the PR lives, so "go and merge it" is one click rather than a hunt. */
export function prUrl(st: State, g: Group) {
  const repo = githubRepo(projectRemote(st, g.project_id));
  return repo && g.pr_number ? `https://github.com/${repo}/pull/${g.pr_number}` : null;
}

const projectRemote = (st: State, projectId: number) => st.projects.find((p) => p.id === projectId)?.remote ?? "";

const githubRepo = (remote: string) => {
  const match = /github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?$/.exec(remote);
  return match ? `${match[1]}/${match[2]}` : null;
};

/**
 * This group's open questions. Answered ones are history, not a decision.
 *
 * Unfiltered, this fed a heading that said 待你决策 — so a question the boss had
 * already answered, and one the PM was still holding, both sat at the top of the
 * page under a label claiming they needed the boss.
 */
export const asksOf = (st: State, id: number): Escalation[] =>
  st.escalations.filter((e) => e.grp_id === id && !e.answer && e.chain_state !== "revoked");

/** Of those, the ones actually waiting on the boss. */
export const mineOf = (asks: Escalation[]): Escalation[] => asks.filter((e) => e.chain_state === "boss");

/** What a question is about, in the boss's words. `other` gets no label. */
export const KIND_ZH: Record<string, string> = {
  env: "环境",
  spec: "验收口径",
  boundary: "边界",
  design: "设计取舍",
};
