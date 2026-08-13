import { useEffect, useState } from "react";
import { Button, LinkButton } from "../ui/button";
import { Badge } from "../ui/badge";
import { Tip } from "../ui/tooltip";
import { CardRow } from "../ui/card";
import { Meta } from "../ui/bits";
import { post, pull } from "../lib/api";
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
  /** Which requirement it came from. A question with no home reads as the system's. */
  where?: string;
  sub: string;
  grpId: number | null;
  points: number;
  reasons: Reason[];
  flag?: string;
  actions: React.ReactNode;
  /** An open question, answerable without leaving the list. */
  escId?: number;
  /** Told, not asked: 知道了 is the only move. */
  fyi?: boolean;
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
  /**
   * Nothing is running on this requirement: its agents are idle until you act.
   *
   * A standing agent has no requirement, so there is no group to be stopped — the
   * row used to claim 组停着不动 about a question the Architect filed for information.
   */
  const halted = (grpId: number | null) =>
    grpId != null && !st.agents.some((a) => a.grp_id === grpId && a.state === "running");
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
      where: g.name,
      what: drop ? drop.body.split("\n")[0]! : goal || "计划卡未提交",
      sub: "",
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
      where: groupName(st, s.grp_id),
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
      where: m.name,
      what: m.branch ?? "等你合入",
      sub: url ? "" : "未找到 PR 链接",
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
      // The question was the only thing on the row, so a two-paragraph one filled
      // the card and never said which requirement was asking it.
      where: e.grp_id ? groupName(st, e.grp_id) : "常驻岗",
      // A watchdog escalation has no agent behind it, and "?" read like a bug.
      sub: e.asker ?? "系统",
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
      escId: e.id,
      // A standing agent that files a non-blocker is telling you something, not
      // asking: nothing is hanging on the reply and there is no requirement to
      // reply about. A 回答 box there is a text field whose text goes nowhere.
      fyi: !e.grp_id && e.severity !== "blocker",
      // One button. 去回答 used to be the only one and it called onOpen(null) for a
      // standing agent, so the one class of question with nowhere to navigate to
      // was also the one the boss could not clear. Answering happens here; the row
      // title still opens the requirement for anyone who wants the context.
      actions: null,
    });
  }

  if (!items.length) {
    return (
      <div className="text-[0.8125rem] text-ink-3">
        <b className="text-ok">都处理完了。</b> 有计划卡待批、切片待查收、PR 待合入或 agent 提问时出现在这里，并推送通知。
      </div>
    );
  }

  const { clustered, loose } = byRequirement(items);
  // Clusters and singletons interleave by weight: a lone blocker must not sit below a
  // cluster of three slow slices merely because the cluster has more rows.
  const blocks = [
    ...clustered.map((c) => ({
      points: c.points,
      node: <Cluster key={`g${c.grpId}`} st={st} c={c} onOpen={onOpen} refresh={refresh} />,
    })),
    ...loose.map((i) => ({
      points: i.points,
      node: <Row key={i.key} item={i} onOpen={() => i.grpId != null && onOpen(i.grpId)} refresh={refresh} />,
    })),
  ].sort((a, b) => b.points - a.points);

  // No card, no second 待办 label: the tab this renders into already carries the
  // name and the count, and a titled card inside a titled tab was the same word
  // twice with two different numbers under it.
  // The sort order used to be printed above the list. Every row already carries
  // the reason it sits where it does, which is the same fact said once instead of
  // twice — and said on the row that has to justify itself.
  return <div className="overflow-hidden rounded-md border border-rule-soft">{blocks.map((b) => b.node)}</div>;
}

/** Several things on one requirement: go there once. */
function Cluster({
  st, c, onOpen, refresh,
}: {
  st: State; c: { grpId: number; items: Item[] }; onOpen: (id: number) => void; refresh: () => void;
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
        <Row key={i.key} item={i} onOpen={() => onOpen(c.grpId)} refresh={refresh} nested />
      ))}
    </>
  );
}

function Row({
  item, onOpen, refresh, nested,
}: {
  item: Item; onOpen: () => void; refresh: () => void; nested?: boolean;
}) {
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
        {/* Which requirement, on its own line and in the same weight the list of
            requirements uses. It was a grey run-in ahead of the reasons, so the
            first question a row has to answer — whose problem is this — was the
            least visible thing on it. Suppressed inside a cluster, where the header
            two rows up already says it. */}
        {item.where && !nested && (
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-display text-[0.9375rem] font-semibold">{item.where}</span>
            {item.flag && <Badge tone="mine">{item.flag}</Badge>}
          </div>
        )}
        {/* Clamped, not truncated to one line: these are questions, and the first
            line of one is rarely the part that says what is being asked. Two lines
            is enough to decide whether to open it, and the card stays a card. */}
        <button
          onClick={onOpen}
          className="line-clamp-2 cursor-pointer text-left text-[0.8125rem] text-ink-2 hover:text-accent"
        >
          {item.what} {(!item.where || nested) && item.flag && <Badge tone="mine">{item.flag}</Badge>}
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
      <span className="flex flex-wrap items-center gap-1.5 max-[52rem]:col-start-2">
        {item.escId != null && <Reply escId={item.escId} fyi={item.fyi} refresh={refresh} />}
        {item.actions}
      </span>
    </CardRow>
  );
}

/**
 * Answer a question from the list.
 *
 * `orch ask-boss` blocks its caller until this lands, and the Architect files
 * questions with no requirement behind them — those had a 去回答 button that opened
 * a requirement id of null, so the one class of question the boss cannot navigate to
 * was also the one they could not clear. 知道了 is the whole point for an FYI: the
 * answer text is unimportant, unblocking the agent is not.
 */
function Reply({ escId, fyi, refresh }: { escId: number; fyi?: boolean; refresh: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async (answer: string) => {
    if (busy || !answer.trim()) return;
    setBusy(true);
    await post(`/api/escalations/${escId}/answer`, { answer });
    setBusy(false);
    setOpen(false);
    setText("");
    refresh();
  };
  if (fyi) {
    return <Button variant="go" disabled={busy} onClick={() => send("知道了")}>知道了</Button>;
  }
  if (!open) return <Button variant="go" onClick={() => setOpen(true)}>回答</Button>;
  return (
    <span className="flex items-end gap-1.5">
      <Draft escId={escId} onUse={setText} />
      <textarea
        autoFocus
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(text);
        }}
        placeholder="回答…  ⌘↵ 发送"
        className="w-[20rem] resize-none rounded-md border border-rule bg-paper px-2 py-1.5 text-[0.8125rem] outline-none focus:border-accent"
      />
      <Button variant="go" disabled={busy || !text.trim()} onClick={() => void send(text)}>发送</Button>
    </span>
  );
}

/**
 * The drafted answer, offered from the queue as well as the requirement page.
 *
 * This is where the boss actually answers now — 待办 is one tab and the question
 * has its reply box on the row — so a draft that only existed on the drill-in was
 * a draft nobody saw. Same call, same rule: computed on open, never stored, and
 * it goes into the box rather than to the agent.
 */
function Draft({ escId, onUse }: { escId: number; onUse: (t: string) => void }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    void pull<{ text: string }>(`/api/escalations/${escId}/draft`).then((r) => setText(r?.text?.trim() || ""));
  }, [escId]);
  if (!text) return null;
  return (
    <Tip label={text}>
      <Button size="sm" onClick={() => onUse(text)}>用草稿</Button>
    </Tip>
  );
}
