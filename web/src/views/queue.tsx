import { Button, LinkButton } from "../ui/button";
import { Badge } from "../ui/badge";
import { Card, CardLabel, CardRow } from "../ui/card";
import type { State } from "../lib/api";
import { pending, prUrl, waitedLabel } from "../lib/select";
import { Landed, RejectSlice } from "./requirement";

/**
 * Everything waiting on the boss, one list, action on the row.
 *
 * It can reach zero, and that matters: "都处理完了" is an achievable state, where
 * a board always looks half empty and trains the reader to ignore it.
 */
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
  const rows: React.ReactNode[] = [];

  for (const g of w.cards) {
    const filed = st.draftCards.find((c) => c.grpId === g.id)?.body ?? "";
    const goal = (filed.split("\n").find((l) => l.startsWith("目标")) ?? "").replace(/^目标\s*[:：]\s*/, "");
    rows.push(
      <Row
        key={`c${g.id}`}
        kind="计划"
        what={g.name}
        flag={st.lateObjections.some((o) => o.grpId === g.id) ? "有反对意见" : undefined}
        sub={goal || "计划卡未提交"}
        onOpen={() => onOpen(g.id)}
      >
        <Button variant="go" onClick={() => onOpen(g.id)}>审阅</Button>
      </Row>,
    );
  }
  for (const s of w.slices) {
    rows.push(
      <Row
        key={`s${s.id}`}
        kind="切片"
        what={s.title}
        sub={`${name(s.grp_id)} · ${s.accept_spec}`}
        onOpen={() => onOpen(s.grp_id)}
      >
        {/* 查收 lives on the requirement page, where the diff and the verdicts are.
            Accepting from a list is accepting a title. */}
        <Button variant="go" onClick={() => onOpen(s.grp_id)}>看改动</Button>
        <RejectSlice sliceId={s.id} refresh={refresh} />
      </Row>,
    );
  }
  for (const m of w.merges) {
    const g = st.groups.find((x) => x.id === m.grpId);
    const url = g ? prUrl(st, g) : null;
    rows.push(
      <Row
        key={`m${m.grpId}`}
        kind="PR"
        what={m.name}
        sub={`${m.branch ?? ""}${url ? "" : " · 未找到 PR 链接"}`}
        onOpen={() => onOpen(m.grpId)}
      >
        {url && <LinkButton href={url}>打开 PR ↗</LinkButton>}
        {/* GitHub does the merging, and GitHub is asked whether it happened. */}
        <Landed grpId={m.grpId} refresh={refresh} />
      </Row>,
    );
  }
  for (const e of w.asks) {
    rows.push(
      <Row
        key={`a${e.id}`}
        kind="提问"
        what={e.question}
        flag={e.severity === "blocker" ? "全组已暂停" : undefined}
        sub={`${e.asker ?? "?"} · ${name(e.grp_id)} · ${waitedLabel(e.created_at)}`}
        onOpen={() => onOpen(e.grp_id!)}
      >
        <Button variant="go" onClick={() => onOpen(e.grp_id!)}>去回答</Button>
      </Row>,
    );
  }

  if (!rows.length) {
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
  return (
    <Card tone="mine" className="mb-10 overflow-hidden">
      <CardLabel className="bg-accent-soft text-accent">等你 {rows.length}</CardLabel>
      {rows}
    </Card>
  );
}

function Row({
  kind, what, sub, flag, children, onOpen,
}: {
  kind: string; what: string; sub: string; flag?: string;
  children: React.ReactNode; onOpen: () => void;
}) {
  return (
    // Below ~52rem the buttons stop fitting beside the text and the row was pushing
    // the whole page into a horizontal scroll. They wrap under instead.
    <CardRow className="grid grid-cols-[2.75rem_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 transition-colors hover:bg-sunk max-[52rem]:grid-cols-[2.75rem_minmax(0,1fr)]">
      <span className="font-mono text-[0.6875rem] text-accent">{kind}</span>
      <div className="min-w-0">
        <button onClick={onOpen} className="cursor-pointer text-left text-[0.875rem] font-medium hover:text-accent">
          {what} {flag && <Badge tone="mine">{flag}</Badge>}
        </button>
        <div className="truncate text-[0.75rem] text-ink-3">{sub}</div>
      </div>
      <span className="flex flex-wrap gap-1.5 max-[52rem]:col-start-2">{children}</span>
    </CardRow>
  );
}
