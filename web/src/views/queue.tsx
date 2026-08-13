import { Button, LinkButton } from "../ui/button";
import { Badge } from "../ui/badge";
import { Card, CardLabel, CardRow } from "../ui/card";
import { Meta } from "../ui/bits";
import type { State } from "../lib/api";
import { pending, prUrl, waitedLabel } from "../lib/select";
import { cn } from "../lib/utils";
import { Landed, RejectSlice } from "./requirement";

/**
 * Everything waiting on the boss, one list, action on the row.
 *
 * It can reach zero, and that matters: "都处理完了" is an achievable state, where a
 * board always looks half empty and trains the reader to ignore it.
 *
 * Ranked by what ignoring it costs, not by kind. The first version tinted all five
 * rows in the accent, which is how the accent stopped meaning anything: two of them
 * had a requirement halted with idle agents, three did not, and the page said they
 * were the same. The tint is now reserved for the halted ones, and inside each tier
 * the oldest is first — the clock is the whole argument for slicing work up.
 */
interface Item {
  key: string;
  kind: string;
  what: string;
  sub: string;
  grpId: number | null;
  at: number | null;
  stopped: boolean;
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
  const name = (id: number | null) => st.groups.find((g) => g.id === id)?.name ?? "";
  /** Nothing is running on this requirement: its agents are idle until you act. */
  const halted = (grpId: number | null) =>
    grpId == null || !st.agents.some((a) => a.grp_id === grpId && a.state === "running");

  const items: Item[] = [];

  for (const g of w.cards) {
    const card = st.draftCards.find((c) => c.grpId === g.id);
    const goal = (card?.body.split("\n").find((l) => l.startsWith("目标")) ?? "").replace(/^目标\s*[:：]\s*/, "");
    items.push({
      key: `c${g.id}`,
      kind: "计划",
      what: g.name,
      sub: goal || "计划卡未提交",
      grpId: g.id,
      at: card?.at ?? null,
      // DRAFT blocks dispatch by design, so this group is doing nothing at all.
      stopped: true,
      flag: st.lateObjections.some((o) => o.grpId === g.id) ? "有反对意见" : undefined,
      actions: <Button variant="go" onClick={() => onOpen(g.id)}>去审阅</Button>,
    });
  }
  for (const s of w.slices) {
    items.push({
      key: `s${s.id}`,
      kind: "切片",
      what: s.title,
      sub: `${name(s.grp_id)} · ${s.accept_spec}`,
      grpId: s.grp_id,
      at: s.awaiting_at,
      stopped: halted(s.grp_id),
      actions: (
        <>
          {/* 查收 happens on the requirement page, next to the diff and the verdicts:
              accepting from a list is accepting a title. So this navigates — and says
              so, in the same word the act is called everywhere else. */}
          <Button variant="go" onClick={() => onOpen(s.grp_id)}>去查收</Button>
          <RejectSlice sliceId={s.id} refresh={refresh} />
        </>
      ),
    });
  }
  for (const m of w.merges) {
    const g = st.groups.find((x) => x.id === m.grpId);
    const url = g ? prUrl(st, g) : null;
    items.push({
      key: `m${m.grpId}`,
      kind: "PR",
      what: m.name,
      sub: `${m.branch ?? ""}${url ? "" : " · 未找到 PR 链接"}`,
      grpId: m.grpId,
      at: null,
      // The branch is finished, and everything behind it in the queue is waiting.
      stopped: true,
      actions: (
        <>
          {url && <LinkButton href={url}>打开 PR ↗</LinkButton>}
          {/* GitHub does the merging, and GitHub is asked whether it happened. */}
          <Landed grpId={m.grpId} refresh={refresh} />
        </>
      ),
    });
  }
  for (const e of w.asks) {
    items.push({
      key: `a${e.id}`,
      kind: "提问",
      what: e.question,
      // A watchdog escalation has no agent behind it, and "?" read like a bug.
      sub: `${e.asker ?? "系统"}${e.grp_id ? ` · ${name(e.grp_id)}` : " · 常驻"}`,
      grpId: e.grp_id,
      at: e.created_at,
      stopped: e.severity === "blocker" || halted(e.grp_id),
      flag: e.severity === "blocker" ? "全组已暂停" : undefined,
      actions: <Button variant="go" onClick={() => onOpen(e.grp_id!)}>去回答</Button>,
    });
  }

  if (!items.length) {
    return (
      <Card className="mb-10 overflow-hidden">
        <CardLabel className="bg-sunk text-ink-3">等你</CardLabel>
        <CardRow className="text-[0.8125rem] text-ink-2">
          <b className="text-ok">无待办</b>
          <span className="text-ink-3"> · 需要决策时出现在此并推送通知</span>
        </CardRow>
      </Card>
    );
  }

  // Halted first, then oldest first. An undated row sits at the end of its tier
  // rather than pretending to be new.
  items.sort((a, b) => Number(b.stopped) - Number(a.stopped) || (a.at ?? Infinity) - (b.at ?? Infinity));
  const halt = items.filter((i) => i.stopped);
  const rest = items.filter((i) => !i.stopped);

  return (
    <Card tone="mine" className="mb-10 overflow-hidden">
      <CardLabel className="bg-accent-soft text-accent">等你 {items.length}</CardLabel>
      {halt.length > 0 && (
        <Tier zh="停着不动" hint="这些需求上没有 agent 在跑，等你之前不会动" n={halt.length} mine />
      )}
      {halt.map((i) => (
        <Row key={i.key} item={i} onOpen={() => i.grpId != null && onOpen(i.grpId)} />
      ))}
      {rest.length > 0 && (
        <Tier zh="可以稍后" hint="组还在干别的，晚点处理不耽误进度" n={rest.length} />
      )}
      {rest.map((i) => (
        <Row key={i.key} item={i} onOpen={() => i.grpId != null && onOpen(i.grpId)} />
      ))}
    </Card>
  );
}

/** Names the tier, so the difference in tint is a statement instead of an accident. */
function Tier({ zh, hint, n, mine }: { zh: string; hint: string; n: number; mine?: boolean }) {
  return (
    <div className={cn("flex flex-wrap items-baseline gap-x-2 border-t border-rule-soft px-3.5 py-1.5",
                       mine ? "bg-accent-soft" : "bg-sunk")}>
      <b className={cn("text-[0.75rem] font-semibold", mine ? "text-accent" : "text-ink-2")}>{zh} {n}</b>
      <Meta>{hint}</Meta>
    </div>
  );
}

function Row({ item, onOpen }: { item: Item; onOpen: () => void }) {
  return (
    // Below ~52rem the buttons stop fitting beside the text and the row was pushing
    // the whole page into a horizontal scroll. They wrap under instead.
    <CardRow
      className={cn(
        "grid grid-cols-[2.75rem_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 transition-colors",
        "max-[52rem]:grid-cols-[2.75rem_minmax(0,1fr)]",
        // Only what is halted carries the accent. Tinting every row is what made the
        // colour stop meaning "needs you" and start meaning "is in a list".
        item.stopped ? "bg-accent-soft/60 hover:bg-accent-soft" : "bg-paper hover:bg-sunk",
      )}
    >
      <span className={cn("font-mono text-[0.6875rem]", item.stopped ? "text-accent" : "text-ink-3")}>
        {item.kind}
      </span>
      <div className="min-w-0">
        <button onClick={onOpen} className="cursor-pointer text-left text-[0.875rem] font-medium hover:text-accent">
          {item.what} {item.flag && <Badge tone="mine">{item.flag}</Badge>}
        </button>
        <div className="truncate text-[0.75rem] text-ink-3">
          {item.sub}
          {item.at && <span className="ml-1.5 font-mono">· {waitedLabel(item.at)}</span>}
        </div>
      </div>
      <span className="flex flex-wrap items-center gap-1.5 max-[52rem]:col-start-2">
        {item.actions}
      </span>
    </CardRow>
  );
}
