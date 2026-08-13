import type { Escalation, Group, Slice, State } from "./api";
import { waited } from "./utils";

export const waitedLabel = waited;

export const STATUS_ZH: Record<string, string> = {
  PLANNING: "拆解中", DRAFT: "待批", RUNNING: "在跑", PAUSING: "正在停",
  PAUSED: "已暂停", PARKED: "已封存", PR_OPEN: "PR 开着", DISSOLVED: "已解散",
};
export const WHERE_ZH: Record<string, string> = {
  pm: "PM 处理中", architect: "Architect 处理中", cos: "CoS 处理中", boss: "待你决策",
};
/** The layers `review.ts` actually records. `self` was never one of them, so its
    tick sat grey forever and taught the boss to ignore the row. */
export const STOPS: [string, string][] = [["reconcile", "对账"], ["gate", "测试"], ["qa", "QA"]];

export const owns = (g: Group) => { try { return JSON.parse(g.owns_json || "[]") as string[]; } catch { return []; } };
export const gates = (s: Slice) => { try { return JSON.parse(s.gates_json || "{}") as Record<string, string>; } catch { return {}; } };

/**
 * Everything that cannot move without the boss, per PLAN.md's three approval points.
 *
 * Called 待办 everywhere in the panel. It used to be 等你 in the nav, 等你决策 in the
 * requirement list and 无待办 when empty — three names for one concept, one of which
 * was a verb phrase doing a noun's job in a nav badge.
 */
export function pending(st: State, projectId: number | null) {
  const ids = new Set(
    (projectId ? st.groups.filter((g) => g.project_id === projectId) : st.groups).map((g) => g.id),
  );
  return {
    // A card that has not been filed is not a decision. Counting it inflates the
    // badge and produces a queue row whose button leads to nothing actionable.
    cards: st.groups.filter(
      (g) => ids.has(g.id) && g.status === "DRAFT" && st.draftCards.some((c) => c.grpId === g.id),
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

/** A project's state, ordered by what should pull the eye. */
export function projectState(st: State, p: number) {
  const n = countWaiting(st, p);
  if (n) return { zh: `${n} 件待办`, mine: true };
  const gs = st.groups.filter((g) => g.project_id === p);
  if (!gs.length) return { zh: "空着", mine: false };
  const live = gs.filter((g) => ["RUNNING", "PLANNING", "PAUSING"].includes(g.status)).length;
  if (live) return { zh: `${live} 个在跑`, mine: false, live: true };
  const held = gs.filter((g) => ["PAUSED", "PARKED"].includes(g.status)).length;
  return held ? { zh: `${held} 个停着`, mine: false } : { zh: "都做完了", mine: false };
}

/** Where the PR lives, so "go and merge it" is one click rather than a hunt. */
export function prUrl(st: State, g: Group) {
  const remote = st.projects.find((p) => p.id === g.project_id)?.remote ?? "";
  const m = /github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?$/.exec(remote);
  return m && g.pr_number ? `https://github.com/${m[1]}/${m[2]}/pull/${g.pr_number}` : null;
}

export const asksOf = (st: State, id: number): Escalation[] => st.escalations.filter((e) => e.grp_id === id);
