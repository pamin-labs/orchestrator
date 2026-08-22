import type { Escalation, Group, Slice, State } from "../../shared/api";
import { byRequirement, groupName, rank, REASONS, type Reason } from "./rank";
import { pending, prUrl } from "../../shared/select";
import { cardGoal } from "../../shared/prose";
import { BRIEF, firstSentence } from "../../../../src/contracts/sentence";
import { saidText } from "../../shared/said";
import { t } from "@lingui/core/macro";

export interface QueueItem {
  key: string;
  kind: string;
  what: string;
  where: string;
  sub: string;
  who: string;
  hard: boolean;
  about: string;
  grpId: number | null;
  points: number;
  reasons: Reason[];
  flag: string | null;
  href: string | null;
  escId: number | null;
  fyi: boolean;
}

export interface QueueCluster {
  grpId: number;
  items: QueueItem[];
  points: number;
}

const spent = (st: State, grpId: number | null) => st.groups.find((g) => g.id === grpId)?.spent_tokens ?? 0;
const waitedReason = (at: number | null | undefined, now: number) => (at ? REASONS.waited(now - at) : null);
const sunkReason = (tokens: number) => (tokens > 0 ? REASONS.sunk(tokens) : null);
const halted = (st: State, grpId: number | null) =>
  grpId != null && !st.agents.some((agent) => agent.grp_id === grpId && agent.state === "running");

const goalOf = (card: State["draftCards"][number] | undefined) =>
  cardGoal(card?.body ?? "") || t`Plan card not submitted`;

function cardSummary(card: State["draftCards"][number] | undefined, drop: State["dropProposals"][number] | undefined) {
  if (drop) return drop.body.split("\n")[0] ?? "";
  return goalOf(card);
}

function cardItem(st: State, group: Group, now: number): QueueItem {
  const card = st.draftCards.find((candidate) => candidate.grpId === group.id);
  const drop = st.dropProposals.find((candidate) => candidate.grpId === group.id);
  const tokens = spent(st, group.id);
  const item: QueueItem = {
    key: `c${group.id}`,
    kind: drop ? t`Abandoned` : t`Plan`,
    where: group.name,
    what: cardSummary(card, drop),
    who: "dispatcher",
    sub: "",
    grpId: group.id,
    ...rank([REASONS.unstarted(), waitedReason(card?.at, now), sunkReason(tokens)]),
    hard: false,
    about: "",
    flag: null,
    href: null,
    escId: null,
    fyi: false,
  };
  if (st.lateObjections.some((objection) => objection.grpId === group.id)) item.flag = t`Has objections`;
  return item;
}

function sliceItem(st: State, slice: Slice, now: number): QueueItem {
  const stopped = halted(st, slice.grp_id);
  return {
    key: `s${slice.id}`,
    kind: t`Slice`,
    where: groupName(st, slice.grp_id),
    what: slice.title,
    who: "qa",
    sub: slice.accept_spec,
    grpId: slice.grp_id,
    ...rank([stopped ? REASONS.halted() : null, waitedReason(slice.awaiting_at, now)]),
    hard: false,
    about: "",
    flag: null,
    href: null,
    escId: null,
    fyi: false,
  };
}

const mergeGroup = (st: State, grpId: number) => st.groups.find((group) => group.id === grpId);
const mergeHref = (st: State, group: Group | undefined) => (group ? prUrl(st, group) : null);
const mergeWhat = (branch: string | null) => branch ?? t`Awaiting merge`;
const mergeSub = (href: string | null) => (href ? "" : t`PR link not found`);
const blockingReason = (behind: number) => (behind > 0 ? REASONS.blocking(behind) : null);
const queuedBehind = (st: State, projectId: number | undefined) =>
  Math.max(0, st.groups.filter((group) => group.status === "PR_OPEN" && group.project_id === projectId).length - 1);

function mergeItem(st: State, merge: State["mergeQueue"][number]): QueueItem {
  const group = mergeGroup(st, merge.grpId);
  const href = mergeHref(st, group);
  const behind = queuedBehind(st, group?.project_id);
  const tokens = spent(st, merge.grpId);
  return {
    key: `m${merge.grpId}`,
    kind: "PR",
    where: merge.name,
    what: mergeWhat(merge.branch),
    who: "auditor",
    sub: mergeSub(href),
    grpId: merge.grpId,
    ...rank([REASONS.halted(), blockingReason(behind), sunkReason(tokens)]),
    hard: false,
    about: "",
    flag: null,
    href,
    escId: null,
    fyi: false,
  };
}

function blockerReason(escalation: Escalation) {
  if (escalation.severity !== "blocker") return null;
  return escalation.asker ? REASONS.blocked(escalation.asker) : REASONS.suspended();
}

function askReason(st: State, escalation: Escalation, now: number) {
  const stopped = halted(st, escalation.grp_id);
  return rank([
    blockerReason(escalation),
    stopped ? REASONS.halted() : null,
    REASONS.waited(now - escalation.created_at),
  ]);
}

/**
 * `saidText` on both, because the queue is a browser and the row carries the
 * descriptor the server rendered from. A row an agent filed, or one stored
 * before the column existed, has none and falls back to the stored text.
 */

const askWhat = (escalation: Escalation) =>
  saidText(escalation.briefSaid, escalation.brief ?? "").trim() ||
  firstSentence(saidText(escalation.said, escalation.question), BRIEF);
const askWhere = (st: State, escalation: Escalation) =>
  escalation.grp_id ? groupName(st, escalation.grp_id) : t`Standing post`;
const askWho = (escalation: Escalation) => escalation.asker ?? t`System`;
const askAbout = (escalation: Escalation) => escalation.kind ?? "other";
const askFlag = (hard: boolean) => (hard ? t`Group is paused` : null);
const isFyi = (escalation: Escalation, hard: boolean) => !escalation.grp_id && !hard;

function askItem(st: State, escalation: Escalation, now: number): QueueItem {
  const hard = escalation.severity === "blocker";
  return {
    key: `a${escalation.id}`,
    kind: t`Question`,
    what: askWhat(escalation),
    who: askWho(escalation),
    hard,
    about: askAbout(escalation),
    where: askWhere(st, escalation),
    sub: askWho(escalation),
    grpId: escalation.grp_id,
    ...askReason(st, escalation, now),
    flag: askFlag(hard),
    href: null,
    escId: escalation.id,
    fyi: isFyi(escalation, hard),
  };
}

export function queueItems(st: State, projectId: number | null, now = Date.now()): QueueItem[] {
  const waiting = pending(st, projectId);
  return [
    ...waiting.cards.map((group) => cardItem(st, group, now)),
    ...waiting.slices.map((slice) => sliceItem(st, slice, now)),
    ...waiting.merges.map((merge) => mergeItem(st, merge)),
    ...waiting.asks.map((escalation) => askItem(st, escalation, now)),
  ];
}

const standingCluster = (items: QueueItem[]): QueueCluster | null =>
  items.length ? { grpId: -1, items, points: Math.max(...items.map((item) => item.points)) } : null;

export function queueClusters(items: QueueItem[]): QueueCluster[] {
  const { clustered, loose } = byRequirement(items);
  const standing = standingCluster(loose);
  return [...clustered, ...(standing ? [standing] : [])].sort((a, b) => b.points - a.points);
}

const foldKey = (item: QueueItem) =>
  item.about && item.about !== "other" ? `${item.kind}:${item.about}:${item.who}` : item.key;

export function foldQueueItems(items: QueueItem[]): { item: QueueItem; n: number }[] {
  const folded = new Map<string, { item: QueueItem; n: number }>();
  for (const item of items) {
    const key = foldKey(item);
    const seen = folded.get(key);
    if (seen) seen.n += 1;
    else folded.set(key, { item, n: 1 });
  }
  return [...folded.values()].sort((a, b) => Number(b.item.hard) - Number(a.item.hard));
}
