import { z } from "zod";
import { jsonOr } from "../../../../src/contracts/json.ts";
import type { Agent, Escalation, Group, Slice, State } from "../../shared/api";
import { activityOf } from "../../shared/activity";
import { gates, heldApproved, STOPS } from "../../shared/select";
import { waited } from "../../shared/format";

/**
 * What the requirement page decides, with no JSX around it.
 *
 * The view had grown to hold both: which of nine states a row is in and the
 * markup for all nine, in one function whose ternaries had to be read twice —
 * once for the condition and once for the tag it produced. These are the
 * conditions, and they are checkable without mounting React.
 */

export const groupSlices = (st: State, grpId: number): Slice[] => st.slices.filter((s) => s.grp_id === grpId);

/**
 * The ones on the boss first: the rest are reference, and reading order should
 * not depend on which agent happened to ask first.
 */
export const bossFirst = (asks: Escalation[]): Escalation[] =>
  [...asks].sort((a, b) => Number(b.chain_state === "boss") - Number(a.chain_state === "boss"));

/** Open questions somebody else in the chain is still holding. */
export const heldAsks = (asks: Escalation[], mine: Escalation[]): Escalation[] => asks.filter((a) => !mine.includes(a));

export const answeredFor = (st: State, grpId: number): State["answered"] =>
  st.answered.filter((a) => a.grp_id === grpId);

export const overBudget = (g: Group): boolean => g.budget_tokens != null && g.spent_tokens >= g.budget_tokens;
export const isDraft = (g: Group): boolean => g.status === "DRAFT" || g.status === "PLANNING";

/**
 * The LAST slice that has actually produced something — work moves down the
 * list, so the newest one carrying evidence is where it has got to. Two states
 * are excluded and only two: `pending` has not started, and `running` with no
 * gate mark yet is a slice that was handed out and has written nothing, so
 * opening it puts an empty panel in front of the boss.
 *
 * `accepted` is NOT excluded. A finished requirement is all accepted slices,
 * and excluding them left the page blank under a green row — the diff you just
 * approved is the thing you go back to look at. Nothing worked on at all:
 * everything stays shut rather than opening something with nothing under it.
 */
const workedSlice = (slices: Slice[]): Slice | undefined =>
  slices.findLast((s) => s.status !== "pending" && (s.status !== "running" || Object.keys(gates(s)).length > 0));

/**
 * Which row is open. `null` = nobody has clicked, take the default. `"none"` =
 * the boss shut the default one; without a distinct value that click falls
 * straight back to the default and the row will not close.
 */
export const shownSlice = (slices: Slice[], picked: number | "none" | null): Slice | undefined =>
  picked === "none" ? undefined : (slices.find((s) => s.id === picked) ?? workedSlice(slices));

export const openSliceValue = (shown: Slice | undefined): string => (shown ? String(shown.id) : "");
export const pickedSlice = (value: string): number | "none" => (value ? Number(value) : "none");

export const activeTab = (tab: string | null | undefined, mine: number): string => tab ?? (mine ? "ask" : "slice");
export const askTabLabel = (mine: number): string => (mine ? "待你决策" : "问题");
/** Absent, not undefined: the strip is uncontrolled when nobody owns the hash. */
export const tabProps = (onTab?: (t: string) => void): { onValueChange?: (t: string) => void } =>
  onTab ? { onValueChange: onTab } : {};
/** No badge at all until the record panel has reported how many there are. */
export const countProps = (n: number | null): { count?: number } => (n === null ? {} : { count: n });

/**
 * Which of the three the boss is looking at. `null` = whatever there is, in the
 * order that matters: a decision first, then what somebody else is holding,
 * then what was answered for you.
 */
export const askLane = (picked: string | null, mine: number, others: number): string =>
  picked ?? (mine ? "mine" : others ? "held" : "done");

export const noQuestions = (asks: number, answered: number): boolean => !asks && !answered;

/** The lanes that have anything in them, with their counts on the switch. */
export const askLanes = (mine: number, others: number, answered: number): [string, string][] =>
  (
    [
      ["mine", "待你决策", mine],
      ["held", "别人在处理", others],
      ["done", "替你答过", answered],
    ] as [string, string, number][]
  )
    .filter(([, , n]) => n > 0)
    .map(([lane, label, n]) => [lane, `${label} ${n}`]);
export const openAskValue = (openAsk: string | null, mine: Escalation[]): string =>
  openAsk ?? String(mine[0]?.id ?? "");

/**
 * A decision carries its own answer box, and that box is the one that unblocks
 * the agent hanging on it. Two inputs on one screen asks the boss to work out
 * which of them the words go to.
 */
export const showDock = (open: boolean, draft: boolean, tab: string, mine: number): boolean =>
  open && !draft && !(tab === "ask" && mine > 0);

export const runningAgents = (st: State, grpId: number): Agent[] =>
  st.agents.filter((a) => a.grp_id === grpId && a.state === "running");

const activityLine = (a: Agent): string => {
  const [verb, detail] = activityOf(a);
  return `${a.role} ▸ ${verb ? `${verb} ` : ""}${detail}`;
};

/** The row's second line: where this slice has got to, in the fewest words that are true. */
export function sliceLine(s: Slice, on: Agent[]): string {
  if (s.status === "pending") return "等前序切片";
  if (s.status === "rejected") return "已退回，等它修";
  if (s.status === "awaiting_boss") return s.awaiting_at ? `待你查收 · ${waited(s.awaiting_at)}` : "待你查收";
  return on.length ? on.map(activityLine).join(" · ") : s.accept_spec;
}

export const sliceRowClass = (waiting: boolean, selected: boolean): string =>
  waiting ? "bg-accent-soft/60 hover:bg-accent-soft" : selected ? "bg-rail" : "hover:bg-rail/60";

/** Only when it says something the slice title does not: one task whose title is
 *  the slice's own is the same line twice with a tick in front. */
export const showTasks = (tasks: State["tasks"], s: Slice): boolean =>
  tasks.length > 1 || (!!tasks[0] && tasks[0].title !== s.title);

/** The recorded gate track, plus the boss's own column — not a gate, but read as one. */
export const tickStops = (waiting: boolean): [string, string][] => [...STOPS, ["boss", waiting ? "待查收" : "查收"]];

export const tickState = (s: Slice, key: string, gs: Record<string, string>): string =>
  key !== "boss" ? (gs[key] ?? "") : s.status === "awaiting_boss" ? "wait" : s.status === "accepted" ? "pass" : "";

const TICK_TEXT: Record<string, string> = { pass: "text-ok", fail: "text-bad", wait: "font-semibold text-accent" };
const TICK_DOT: Record<string, string> = {
  pass: "border-ok bg-ok",
  fail: "border-bad bg-bad",
  wait: "border-accent bg-accent",
};

export const tickTextClass = (v: string): string => (v ? (TICK_TEXT[v] ?? "") : "text-ink-3");
export const tickDotClass = (v: string, current: boolean): string =>
  v ? (TICK_DOT[v] ?? "") : current ? "breathe border-ink" : "border-ink-3";

export type StepState = "wait" | "run" | "ok" | "bad";

// The install prints `$ cmd` as its first line and only runs once the clone has
// returned, so that one line marks both steps.
export const cloneStep = (cmd: string | null, failed: boolean): StepState => (cmd ? "ok" : failed ? "bad" : "run");
export const installStep = (cmd: string | null, failed: boolean, until: number | null): StepState =>
  !cmd ? "wait" : failed ? "bad" : until ? "ok" : "run";
export const bootCmd = (cmd: string | null): string => cmd ?? "把这个组的分支和依赖装回新沙盒";
export const bootSecs = (since: number, until: number | null, now: number): number =>
  Math.max(0, Math.round(((until ?? now) - (since || now)) / 1000));
/** Elapsed, because an install with no clock reads as stuck at minute three. */
export const bootClock = (failed: boolean, secs: number): string =>
  failed ? "装失败了" : secs < 90 ? `${secs}s` : `${Math.floor(secs / 60)}m${secs % 60}s`;

export const inMergeQueue = (st: State, grpId: number): boolean => st.mergeQueue.some((m) => m.grpId === grpId);
export const groupTone = (g: Group): "muted" | "mine" | "live" =>
  heldApproved(g) ? "muted" : g.status === "DRAFT" ? "mine" : g.status === "RUNNING" ? "live" : "muted";
export const prLabel = (inQueue: boolean): string => (inQueue ? "去合并 PR ↗" : "打开 PR ↗");
export const isRunning = (g: Group): boolean => ["RUNNING", "PAUSING"].includes(g.status);
/** Closed PR: reopening it on GitHub is enough and the watchdog sees it, but a
 *  branch that was force-pushed or deleted cannot be reopened at all. */
export const canNewPr = (g: Group): boolean => g.status === "PAUSED" && g.pr_number != null;
export const showQueued = (inQueue: boolean, g: Group): boolean => !inQueue && g.status === "PR_OPEN";
export const canResume = (g: Group, broke: boolean): boolean => ["PAUSED", "PAUSING"].includes(g.status) && !broke;
export const canPark = (g: Group): boolean => ["RUNNING", "PAUSING", "PAUSED"].includes(g.status);

/** Everything filed against this requirement's plan card, in one read of the snapshot. */
export function draftView(st: State, grpId: number) {
  const card = st.draftCards.find((c) => c.grpId === grpId);
  return {
    filed: card?.body ?? "",
    idea: st.ideas.find((i) => i.grpId === grpId)?.body ?? "",
    late: st.lateObjections.filter((o) => o.grpId === grpId),
    proposal: st.dropProposals.find((p) => p.grpId === grpId),
    /** Paths the card names that are not in the repo — new files, or a plan from memory. */
    unknown: jsonOr(card?.unknownPaths, z.array(z.string()), []),
  };
}

export const blockedReason = (st: State, grpId: number): string =>
  st.approvedBlocked.find((b) => b.grpId === grpId)?.reason ?? "等 Architect 切边界";
export const cardRows = (filed: string): number => Math.max(7, filed.split("\n").length + 1);
export const firstLine = (body: string): string => body.split("\n")[0] ?? "";
/** Send the text only when edited: an untouched card is approved as filed, so
 *  "approve" and "edit then approve" stay distinct requests. */
export const approveBody = (card: string, filed: string): { card?: string } =>
  card.trim() && card.trim() !== filed.trim() ? { card: card.trim() } : {};
