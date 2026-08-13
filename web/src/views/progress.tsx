import { useState } from "react";
import { Meta } from "../ui/bits";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tab, TabList, TabPanel, Tabs } from "../ui/tabs";
import { Tip } from "../ui/tooltip";
import type { Archived, Group, Slice, State } from "../lib/api";
import { usePaged } from "../lib/page";
import { STOPS, gates, heldApproved, statusLabel } from "../lib/select";
import { cn, money } from "../lib/utils";

/**
 * Every requirement in the project, filtered by whose turn it is.
 *
 * The state is the filter, not a column: "which of these needs me, which are
 * moving, which are stuck, which are done" is the only question this page answers,
 * and a tab carrying the count answers it before the list is read at all.
 *
 * Four stacked sections were the first attempt. They read fine at four
 * requirements and become a scroll hunt at forty — the archive is the longest
 * section and the one nobody wants, so it was permanently in the way. One list at a
 * time, paged, with the count on the control that selects it.
 */

interface Bucket {
  key: string;
  zh: string;
  hint: string;
  of: string[];
  mine?: boolean;
}

const BUCKETS: Bucket[] = [
  { key: "mine", zh: "待办", hint: "计划卡待批、切片待查收、PR 待合入", of: ["DRAFT", "PR_OPEN"], mine: true },
  { key: "live", zh: "执行中", hint: "有 agent 在跑，或正在拆解", of: ["RUNNING", "PLANNING", "PAUSING"] },
  { key: "held", zh: "停着", hint: "暂停或封存，工作都留着，唤醒即续", of: ["PAUSED", "PARKED"] },
];
const DONE = "done";

export function Progress({
  st, projectId, onOpen, maxGroups,
}: {
  st: State; projectId: number; onOpen: (id: number) => void; maxGroups?: number | null;
}) {
  const groups = st.groups.filter((g) => g.project_id === projectId);
  const archived = (st.archived ?? []).filter((a) => a.project_id === projectId);
  // A group already approved is not the boss's to act on: it belongs with the
  // other things that are simply waiting.
  const of = (b: Bucket) =>
    groups.filter((g) => (heldApproved(g) ? b.key === "held" : b.of.includes(g.status)));
  const live = of(BUCKETS[1]!).length;

  // Open on the tab that has something for the boss; failing that, on the work.
  const [tab, setTab] = useState(() => {
    if (of(BUCKETS[0]!).length) return "mine";
    return BUCKETS.find((b) => of(b).length)?.key ?? (archived.length ? DONE : "live");
  });

  if (!groups.length && !archived.length) {
    return (
      <div className="text-[0.8125rem] text-ink-3">
        这个项目还没有需求。右上角 ＋ 新需求，写一句话就行 —— 深挖和切边界不用你做。
      </div>
    );
  }

  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabList>
        {BUCKETS.map((b) => (
          <Tab key={b.key} value={b.key} count={of(b).length} mine={b.mine}>
            {b.zh}
          </Tab>
        ))}
        <Tab value={DONE} count={archived.length}>已交付</Tab>
        <span className="grow" />
        {/* The slot cap is why an approved requirement can sit still: queued, not
            stuck. Without it that difference is invisible. */}
        {maxGroups != null && (
          <Tip label={`并发上限 ${maxGroups} 组。满了之后已批准的需求排队等槽位，不是卡住了。`}>
            <Meta className={cn("self-center underline decoration-dotted", live >= maxGroups && "text-warn")}>
              并行 {live}/{maxGroups}
            </Meta>
          </Tip>
        )}
      </TabList>

      {BUCKETS.map((b) => (
        <TabPanel key={b.key} value={b.key}>
          <List st={st} groups={of(b)} onOpen={onOpen} hint={b.hint} mine={!!b.mine} empty={emptyOf(b.key)} />
        </TabPanel>
      ))}
      <TabPanel value={DONE}>
        <Done rows={archived} />
      </TabPanel>
    </Tabs>
  );
}

/** Absence, with the reason it is absent. A bare "无" teaches nothing. */
function emptyOf(key: string): string {
  if (key === "mine") return "没有待办。有计划卡、待查收切片或待合入 PR 时出现在这里，并推送通知。";
  if (key === "live") return "没有在跑的需求。批准一张计划卡就会有。";
  return "没有停着的需求。预算用尽、或等你答问题超过 2 小时会自动封存到这里，工作不丢。";
}

function List({
  st, groups, onOpen, hint, mine, empty,
}: {
  st: State; groups: Group[]; onOpen: (id: number) => void; hint: string; mine: boolean; empty: string;
}) {
  const { page, rest, more, total } = usePaged(groups, 25);
  if (!groups.length) return <div className="text-[0.8125rem] text-ink-3">{empty}</div>;
  return (
    <>
      <Meta className="mb-1 block">{hint}</Meta>
      {page.map((g) => (
        <Row key={g.id} st={st} g={g} onOpen={onOpen} mine={mine} />
      ))}
      {rest > 0 && (
        <Button variant="quiet" size="sm" className="mt-2" onClick={more}>
          还有 {rest} 个（共 {total}）
        </Button>
      )}
    </>
  );
}

function Row({ st, g, onOpen, mine }: { st: State; g: Group; onOpen: (id: number) => void; mine: boolean }) {
  const slices = st.slices.filter((s) => s.grp_id === g.id);
  const doing = st.agents.find((a) => a.grp_id === g.id && a.state === "running");
  const waiting = slices.filter((s) => s.status === "awaiting_boss").length;
  const done = slices.filter((s) => s.status === "accepted").length;
  const card = st.draftCards.find((c) => c.grpId === g.id);
  const broke = g.budget_tokens != null && g.spent_tokens >= g.budget_tokens;
  return (
    <button
      onClick={() => onOpen(g.id)}
      className={cn(
        "grid w-full cursor-pointer grid-cols-[14rem_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5",
        "border-t border-rule-soft px-2 py-2.5 text-left transition-colors hover:bg-sunk",
        "max-[60rem]:grid-cols-[minmax(0,1fr)_auto]",
        mine && "bg-accent-soft/40",
      )}
    >
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="truncate font-display text-[0.9375rem] font-semibold">{g.name}</span>
          {doing && <i className="breathe size-1.5 shrink-0 rounded-full bg-ok" />}
        </div>
        <Meta>
          {statusLabel(g)}
          {slices.length ? ` · 已查收 ${done}/${slices.length}` : ""}
          {g.spent_usd ? ` · ${money(g.spent_usd)}` : ""}
        </Meta>
      </div>
      <div className="min-w-0 max-[60rem]:col-span-full">
        {g.status === "PLANNING" ? (
          <span className="text-[0.75rem] text-ink-3">Dispatcher 在深挖，还没有切片</span>
        ) : heldApproved(g) ? (
          <span className="text-[0.75rem] text-ink-3">已批准，边界让开就自动开工</span>
        ) : g.status === "DRAFT" ? (
          <span className="block truncate text-[0.75rem] text-ink-2">
            {card ? (card.body.split("\n").find((l) => l.startsWith("目标")) ?? "计划卡待批") : "计划卡还没交"}
          </span>
        ) : !slices.length ? (
          <span className="text-[0.75rem] text-ink-3">无切片</span>
        ) : (
          <div className="flex flex-wrap items-stretch gap-1.5">
            {slices.map((s) => <Seg key={s.id} s={s} />)}
          </div>
        )}
        {doing && (
          <div className="mt-1 truncate font-mono text-[0.6875rem] text-ink-2">{doing.role} ▸ {doing.activity}</div>
        )}
      </div>
      <span className="flex items-center gap-2 whitespace-nowrap">
        {broke && <Badge tone="mine">预算用尽</Badge>}
        {waiting > 0 && <Badge tone="mine">{waiting} 片待查收</Badge>}
        {g.status === "PR_OPEN" && <Badge tone="mine">PR 待合入</Badge>}
        <Meta>{g.branch ?? ""}</Meta>
      </span>
    </button>
  );
}

/** One slice: its place in the order, and which gates it has passed. */
function Seg({ s }: { s: Slice }) {
  const gs = gates(s);
  const waiting = s.status === "awaiting_boss";
  const failed = Object.values(gs).includes("fail");
  const mark = waiting
    ? "待查收"
    : s.status === "accepted" ? "✓" : s.status === "rejected" ? "退回" : s.status === "pending" ? "等" : "";
  return (
    <Tip label={`${s.title} — ${s.accept_spec}`}>
      <span
        className={cn(
          "w-32 shrink-0 rounded-[0.3125rem] border px-1.5 py-1",
          waiting && "border-accent bg-accent-soft",
          !waiting && s.status === "accepted" && "border-rule-soft bg-sunk",
          !waiting && s.status !== "accepted" && (failed || s.status === "rejected") && "border-bad",
          !waiting && s.status !== "accepted" && !failed && s.status !== "rejected" && s.status !== "pending" && "border-ink-3",
          !waiting && s.status === "pending" && "border-rule",
        )}
      >
        <span className={cn("flex items-center gap-1 font-mono text-[0.625rem] text-ink-3", waiting && "font-semibold text-accent")}>
          S{s.seq}
          <span className="grow" />
          {mark}
        </span>
        <span className="mt-px block truncate text-[0.6875rem] text-ink-2">{s.title}</span>
        {/* The layers review.ts actually records. `self` was drawn here for a while
            and recorded nowhere, so the first tick sat grey forever — and the layer
            it stood in for, reconcile, is the one PLAN.md §7 calls worth more than
            the whole Auditor. Progress is which gates passed, never a percentage:
            a model's percentage is a guess, a gate is a fact. */}
        <span className="mt-1 flex gap-1">
          {STOPS.map(([k]) => (
            <i
              key={k}
              className={cn(
                "tick",
                gs[k] === "pass" && "bg-ok",
                gs[k] === "fail" && "bg-bad",
                gs[k] !== "pass" && gs[k] !== "fail" && s.status === k && "breathe bg-ink-3",
              )}
            />
          ))}
        </span>
      </span>
    </Tip>
  );
}

/** Delivered work. 收尾 dissolves the group, and it used to leave no trace at all. */
function Done({ rows }: { rows: Archived[] }) {
  const { page, rest, more, total } = usePaged(rows, 25);
  if (!rows.length) {
    return <div className="text-[0.8125rem] text-ink-3">还没有交付过。合入 main 之后的需求归档到这里。</div>;
  }
  return (
    <>
      <Meta className="mb-1 block">已合入 main，session 全退休，事件和 journal 都留着</Meta>
      {page.map((a) => (
        <div
          key={a.id}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3 border-t border-rule-soft px-2 py-2"
        >
          <span className="min-w-0 truncate text-[0.8125rem] text-ink-2">
            {a.name}
            {a.pr_number ? <Meta className="ml-2">#{a.pr_number}</Meta> : null}
          </span>
          <Meta>{a.slices} 片 · {money(a.spent_usd)}</Meta>
        </div>
      ))}
      {rest > 0 && (
        <Button variant="quiet" size="sm" className="mt-2" onClick={more}>还有 {rest} 个（共 {total}）</Button>
      )}
    </>
  );
}
