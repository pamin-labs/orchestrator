import { Button, LinkButton } from "../ui/button";
import { Empty, Input, Meta, Pill } from "../ui/bits";
import { ask } from "../ui/confirm";
import { post, type State } from "../lib/api";
import { pending, prUrl, waitedLabel } from "../lib/select";

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
  showProject,
}: {
  st: State;
  projectId: number | null;
  onOpen: (grpId: number) => void;
  refresh: () => void;
  showProject?: boolean;
}) {
  const w = pending(st, projectId);
  const name = (id: number | null) => st.groups.find((g) => g.id === id)?.name ?? "";
  const rows: React.ReactNode[] = [];

  for (const g of w.cards) {
    const filed = st.draftCards.find((c) => c.grpId === g.id)?.body ?? "";
    const goal = (filed.split("\n").find((l) => l.startsWith("目标")) ?? "").replace(/^目标\s*[:：]\s*/, "");
    const objected = st.lateObjections.some((o) => o.grpId === g.id);
    rows.push(
      <Row
        key={`c${g.id}`}
        kind="计划"
        what={g.name}
        flag={objected ? "有反对意见" : undefined}
        sub={goal || "计划卡未提交"}
        onOpen={() => onOpen(g.id)}
        actions={<Button variant="go" onClick={() => onOpen(g.id)}>审阅</Button>}
      />,
    );
  }
  for (const s of w.slices) {
    rows.push(
      <Row
        key={`s${s.id}`}
        kind="切片"
        what={s.title}
        sub={`${showProject ? "" : ""}${name(s.grp_id)} · ${s.accept_spec}`}
        onOpen={() => onOpen(s.grp_id)}
        actions={
          <>
            <Button variant="go" onClick={async () => { await post(`/api/slices/${s.id}/accept`); refresh(); }}>
              查收
            </Button>
            <Button
              onClick={async () => {
                const why = await ask({
                  title: "退回这一片", body: "原话记入黑板，PM 据此安排修正。", yes: "退回", field: "哪里不满意",
                });
                if (why === null) return;
                await post(`/api/slices/${s.id}/reject`, { feedback: why });
                refresh();
              }}
            >
              不满意
            </Button>
          </>
        }
      />,
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
        actions={
          <>
            {url && <LinkButton href={url}>打开 PR ↗</LinkButton>}
            {/* GitHub does the merging. This only tells the orchestrator it
                happened, so the group can wind up and the queue release the next. */}
            <Button variant="go" onClick={async () => {
              const go = await ask({
                title: "确认已合入 main",
                body: "本组收尾归档，队列中下一个需求放行，其余需求会被要求 rebase。",
                yes: "已合入，收尾",
              });
              if (!go) return;
              await post(`/api/groups/${m.grpId}/landed`);
              refresh();
            }}>
              确认已合入
            </Button>
          </>
        }
      />,
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
        actions={<Button variant="go" onClick={() => onOpen(e.grp_id!)}>去回答</Button>}
      />,
    );
  }

  if (!rows.length) {
    return (
      <div className="mb-10 overflow-hidden rounded-xl border border-rule">
        <div className="bg-sunk px-3.5 py-2 text-[0.625rem] font-medium uppercase tracking-[0.13em] text-ink-3">
          等你
        </div>
        <div className="px-3.5 py-4 text-[0.8125rem] text-ink-2">
          <b className="text-ok">无待办</b>
          <span className="text-ink-3"> · 需要决策时出现在此并推送通知</span>
        </div>
      </div>
    );
  }
  return (
    <div className="mb-10 overflow-hidden rounded-xl border border-accent shadow-[0_1px_2px_oklch(0.435_0.145_285/0.06)]">
      <div className="flex items-center gap-2 bg-accent-soft px-3.5 py-2 text-[0.625rem] font-semibold uppercase tracking-[0.13em] text-accent">
        等你 {rows.length}
      </div>
      {rows}
    </div>
  );
}

function Row({
  kind, what, sub, flag, actions, onOpen,
}: {
  kind: string; what: string; sub: string; flag?: string;
  actions: React.ReactNode; onOpen: () => void;
}) {
  return (
    <div className="grid grid-cols-[2.75rem_minmax(0,1fr)_auto] items-center gap-4 border-t border-rule-soft px-3.5 py-3 transition-colors hover:bg-sunk">
      <span className="font-mono text-[0.6875rem] text-accent">{kind}</span>
      <div className="min-w-0">
        <button onClick={onOpen} className="cursor-pointer text-left text-[0.875rem] font-medium hover:text-accent">
          {what} {flag && <Pill tone="mine">{flag}</Pill>}
        </button>
        <div className="truncate text-[0.75rem] text-ink-3">{sub}</div>
      </div>
      <span className="flex gap-1.5">{actions}</span>
    </div>
  );
}
