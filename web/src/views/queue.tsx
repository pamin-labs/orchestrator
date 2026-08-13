import { Button, LinkButton } from "../ui/button";
import { Badge } from "../ui/badge";
import { Card, CardLabel, CardRow } from "../ui/card";
import { Meta } from "../ui/bits";
import type { State } from "../lib/api";
import { byRequirement, groupName, rank, REASONS, type Reason } from "../lib/rank";
import { pending, prUrl } from "../lib/select";
import { cn } from "../lib/utils";
import { RejectSlice } from "./requirement";

/**
 * Everything waiting on the boss, ordered by what ignoring it costs.
 *
 * It can reach zero, and that matters: "都处理完了" is achievable, where a board always
 * looks half empty and trains the reader to ignore it.
 *
 * Two earlier versions were wrong in opposite directions. The first tinted all five
 * rows in the accent, so the accent stopped meaning anything. The second split them
 * into 停着不动 / 可以稍后 — true, but only two levels, and "everything in this list is
 * important" is exactly right: the question is never whether an item matters, it is
 * which one to open first. So each row carries the reason it sits where it does, and
 * rows on the same requirement cluster — one trip instead of three context switches.
 */
interface Item {
  key: string;
  kind: string;
  what: string;
  sub: string;
  grpId: number | null;
  points: number;
  reasons: Reason[];
  flag?: string;
  actions: React.ReactNode;
}

export function Queue({
  st,
  projectId,
  onOpen,
  refresh,
}: {
  st: State;
  projectId: number | null;
  onOpen: (grpId: number) => void;
  refresh: () => void;
}) {
  const w = pending(st, projectId);
  const now = Date.now();
  /** Nothing is running on this requirement: its agents are idle until you act. */
  const halted = (grpId: number | null) =>
    grpId == null || !st.agents.some((a) => a.grp_id === grpId && a.state === "running");
  const spend = (grpId: number | null) => st.groups.find((g) => g.id === grpId)?.spent_tokens ?? 0;

  const items: Item[] = [];

  for (const g of w.cards) {
    const card = st.draftCards.find((c) => c.grpId === g.id);
    // A planner that found the work already covered files this instead of a card.
    // Labelled as a plan it read as "go review the slices" and there were none.
    const drop = st.dropProposals.find((p) => p.grpId === g.id);
    const goal = (card?.body.split("\n").find((l) => l.startsWith("目标")) ?? "").replace(/^目标\s*[:：]\s*/, "");
    items.push({
      key: `c${g.id}`,
      kind: drop ? "作废" : "计划",
      what: g.name,
      sub: drop ? drop.body.split("\n")[0]! : goal || "计划卡未提交",
      grpId: g.id,
      ...rank([
        REASONS.unstarted(),
        card ? REASONS.waited(now - card.at) : null,
        spend(g.id) > 0 && REASONS.sunk(spend(g.id)),
      ]),
      flag: st.lateObjections.some((o) => o.grpId === g.id) ? "有反对意见" : undefined,
      actions: <Button variant="go" onClick={() => onOpen(g.id)}>去审阅</Button>,
    });
  }
  for (const s of w.slices) {
    items.push({
      key: `s${s.id}`,
      kind: "切片",
      what: s.title,
      sub: s.accept_spec,
      grpId: s.grp_id,
      ...rank([
        halted(s.grp_id) && REASONS.halted(),
        s.awaiting_at ? REASONS.waited(now - s.awaiting_at) : null,
      ]),
      actions: (
        <>
          {/* 查收 happens on the requirement page, next to the diff and the verdicts:
              accepting from a list is accepting a title. */}
          <Button variant="go" onClick={() => onOpen(s.grp_id)}>去查收</Button>
          <RejectSlice sliceId={s.id} refresh={refresh} />
        </>
      ),
    });
  }
  for (const m of w.merges) {
    const g = st.groups.find((x) => x.id === m.grpId);
    const url = g ? prUrl(st, g) : null;
    // Everything queued behind the head cannot merge until this one does.
    const behind = Math.max(
      0,
      st.groups.filter((x) => x.status === "PR_OPEN" && x.project_id === g?.project_id).length - 1,
    );
    items.push({
      key: `m${m.grpId}`,
      kind: "PR",
      what: m.name,
      sub: `${m.branch ?? ""}${url ? "" : " · 未找到 PR 链接"}`,
      grpId: m.grpId,
      ...rank([
        REASONS.halted(),
        behind > 0 && REASONS.blocking(behind),
        spend(m.grpId) > 0 && REASONS.sunk(spend(m.grpId)),
      ]),
      // GitHub does the merging, and GitHub is asked whether it happened — so the
      // only action here is going there.
      actions: url ? <LinkButton href={url}>去合并 PR ↗</LinkButton> : null,
    });
  }
  for (const e of w.asks) {
    items.push({
      key: `a${e.id}`,
      kind: "提问",
      what: e.question,
      // A watchdog escalation has no agent behind it, and "?" read like a bug.
      sub: `${e.asker ?? "系统"}${e.grp_id ? "" : " · 常驻"}`,
      grpId: e.grp_id,
      ...rank([
        // `orch ask-boss` blocks its caller, so a blocker from an agent is that agent
        // hanging on you. A blocker the watchdog raised has no caller: the group is
        // suspended, and saying "an agent is waiting" would be the row inventing
        // urgency it cannot substantiate.
        e.severity === "blocker" && (e.asker ? REASONS.blocked(e.asker) : REASONS.suspended()),
        halted(e.grp_id) && REASONS.halted(),
        REASONS.waited(now - e.created_at),
      ]),
      flag: e.severity === "blocker" ? "全组已暂停" : undefined,
      actions: <Button variant="go" onClick={() => onOpen(e.grp_id!)}>去回答</Button>,
    });
  }

  if (!items.length) {
    return (
      <Card className="mb-10 overflow-hidden">
        <CardLabel className="bg-sunk text-ink-3">待办</CardLabel>
        <CardRow className="text-[0.8125rem] text-ink-2">
          <b className="text-ok">无待办</b>
          <span className="text-ink-3"> · 需要决策时出现在此并推送通知</span>
        </CardRow>
      </Card>
    );
  }

  const { clustered, loose } = byRequirement(items);
  // Clusters and singletons interleave by weight: a lone blocker must not sit below a
  // cluster of three slow slices merely because the cluster has more rows.
  const blocks = [
    ...clustered.map((c) => ({
      points: c.points,
      node: <Cluster key={`g${c.grpId}`} st={st} c={c} onOpen={onOpen} />,
    })),
    ...loose.map((i) => ({
      points: i.points,
      node: <Row key={i.key} item={i} onOpen={() => i.grpId != null && onOpen(i.grpId)} />,
    })),
  ].sort((a, b) => b.points - a.points);

  return (
    <Card tone="mine" className="mb-10 overflow-hidden">
      <CardLabel className="bg-accent-soft text-accent">
        待办 {items.length}
        <span className="font-normal text-ink-2">按「不管它会怎样」排序</span>
      </CardLabel>
      {blocks.map((b) => b.node)}
    </Card>
  );
}

/** Several things on one requirement: go there once. */
function Cluster({
  st, c, onOpen,
}: {
  st: State; c: { grpId: number; items: Item[] }; onOpen: (id: number) => void;
}) {
  const g = st.groups.find((x) => x.id === c.grpId);
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-2 border-t border-rule-soft bg-sunk px-3.5 py-1.5">
        <button
          onClick={() => onOpen(c.grpId)}
          className="cursor-pointer font-display text-[0.9375rem] font-semibold hover:text-accent"
        >
          {groupName(st, c.grpId)}
        </button>
        <Meta>{c.items.length} 件都在这个需求上，一趟处理完</Meta>
        {g?.branch && <Meta className="ml-auto">{g.branch}</Meta>}
      </div>
      {c.items.map((i) => (
        <Row key={i.key} item={i} onOpen={() => onOpen(c.grpId)} nested />
      ))}
    </>
  );
}

function Row({ item, onOpen, nested }: { item: Item; onOpen: () => void; nested?: boolean }) {
  const top = item.reasons[0];
  const stopped = item.reasons.some((r) => r.points >= 60);
  return (
    // Below ~52rem the buttons stop fitting beside the text and the row was pushing the
    // whole page into a horizontal scroll. They wrap under instead.
    <CardRow
      className={cn(
        "grid grid-cols-[2.75rem_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 transition-colors",
        "max-[52rem]:grid-cols-[2.75rem_minmax(0,1fr)]",
        // Tint marks work that is stopped, not membership of a list.
        stopped ? "bg-accent-soft/60 hover:bg-accent-soft" : "bg-paper hover:bg-sunk",
        nested && "pl-6",
      )}
    >
      <span className={cn("font-mono text-[0.6875rem]", stopped ? "text-accent" : "text-ink-3")}>{item.kind}</span>
      <div className="min-w-0">
        <button onClick={onOpen} className="cursor-pointer text-left text-[0.875rem] font-medium hover:text-accent">
          {item.what} {item.flag && <Badge tone="mine">{item.flag}</Badge>}
        </button>
        <div className="truncate text-[0.75rem] text-ink-3">
          {/* The reason, not the score. A number nobody can interrogate reorders rows
              for reasons nobody can check, and the first time it looks wrong the whole
              ordering stops being trusted. */}
          {top && <span className={cn("font-medium", stopped ? "text-accent" : "text-ink-2")}>{top.why}</span>}
          {item.reasons.slice(1, 3).map((r) => (
            <span key={r.why}> · {r.why}</span>
          ))}
          {item.sub && <span> · {item.sub}</span>}
        </div>
      </div>
      <span className="flex flex-wrap items-center gap-1.5 max-[52rem]:col-start-2">{item.actions}</span>
    </CardRow>
  );
}
