import { Meta } from "../ui/bits";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tip } from "../ui/tooltip";
import type { Archived, Group, Slice, State } from "../lib/api";
import { usePaged } from "../lib/page";
import { STATUS_ZH, STOPS, gates } from "../lib/select";
import { cn, money } from "../lib/utils";

/**
 * Where every requirement in the project stands, grouped by what it is waiting on.
 *
 * The state is the grouping, not a column: "which of these needs me, which are
 * moving, which are stuck, which are done" is the only question this page answers,
 * and sorting by it beats a status column the eye has to scan. Sections are ordered
 * by whose turn it is — the boss first, then the machines, then the parked, then the
 * archive — so the top of the page is always the part that cannot proceed without a
 * decision.
 *
 * Each section pages independently: at a hundred requirements the archive is the
 * long one, and it is also the one nobody scrolls.
 */

interface Section {
  key: string;
  zh: string;
  hint: string;
  of: string[];
}

const SECTIONS: Section[] = [
  { key: "mine", zh: "等你决策", hint: "计划卡待批、切片待查收、PR 待合入", of: ["DRAFT", "PR_OPEN"] },
  { key: "live", zh: "执行中", hint: "有 agent 在跑，或正在拆解", of: ["RUNNING", "PLANNING", "PAUSING"] },
  { key: "held", zh: "停着", hint: "暂停或封存，工作都留着", of: ["PAUSED", "PARKED"] },
];

export function Progress({
  st, projectId, onOpen, maxGroups,
}: {
  st: State; projectId: number; onOpen: (id: number) => void; maxGroups?: number | null;
}) {
  const groups = st.groups.filter((g) => g.project_id === projectId);
  const archived = (st.archived ?? []).filter((a) => a.project_id === projectId);
  const live = groups.filter((g) => SECTIONS[1]!.of.includes(g.status)).length;

  if (!groups.length && !archived.length) {
    return (
      <div className="text-[0.8125rem] text-ink-3">
        这个项目还没有需求。右上角 ＋ 新需求，写一句话就行。
      </div>
    );
  }

  return (
    <>
      <div className="mb-5 flex flex-wrap items-baseline gap-x-4 gap-y-1.5 border-b border-rule pb-3">
        {SECTIONS.map((sec) => {
          const n = groups.filter((g) => sec.of.includes(g.status)).length;
          return (
            <span key={sec.key} className="flex items-baseline gap-1.5">
              <b className={cn("font-display text-[1.25rem] font-semibold", sec.key === "mine" && n > 0 && "text-accent")}>
                {n}
              </b>
              <span className="text-[0.75rem] text-ink-3">{sec.zh}</span>
            </span>
          );
        })}
        <span className="flex items-baseline gap-1.5">
          <b className="font-display text-[1.25rem] font-semibold">{archived.length}</b>
          <span className="text-[0.75rem] text-ink-3">已交付</span>
        </span>
        <span className="grow" />
        {/* The slot cap is why an approved requirement can sit still: queued, not
            stuck. Without it that difference is invisible. */}
        {maxGroups != null && (
          <Tip label={`并发上限 ${maxGroups} 组。满了之后已批准的需求排队等槽位，不是卡住了。`}>
            <Meta className={cn("underline decoration-dotted", live >= maxGroups && "text-warn")}>
              并行 {live}/{maxGroups}
            </Meta>
          </Tip>
        )}
      </div>

      {SECTIONS.map((sec) => (
        <Group key={sec.key} sec={sec} st={st} groups={groups.filter((g) => sec.of.includes(g.status))} onOpen={onOpen} />
      ))}
      <Done rows={archived} />
    </>
  );
}

function Group({
  sec, st, groups, onOpen,
}: {
  sec: Section; st: State; groups: Group[]; onOpen: (id: number) => void;
}) {
  const { page, rest, more } = usePaged(groups, 25);
  if (!groups.length) return null;
  return (
    <section className="mb-7">
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2.5">
        <h2 className={cn("text-[0.8125rem] font-semibold", sec.key === "mine" ? "text-accent" : "text-ink")}>
          {sec.zh} <span className="font-normal text-ink-3">{groups.length}</span>
        </h2>
        <Meta>{sec.hint}</Meta>
      </div>
      {page.map((g) => (
        <Row key={g.id} st={st} g={g} onOpen={onOpen} mine={sec.key === "mine"} />
      ))}
      {rest > 0 && (
        <Button variant="quiet" size="sm" className="mt-1.5" onClick={more}>还有 {rest} 个</Button>
      )}
    </section>
  );
}

function Row({ st, g, onOpen, mine }: { st: State; g: Group; onOpen: (id: number) => void; mine: boolean }) {
  const slices = st.slices.filter((s) => s.grp_id === g.id);
  const doing = st.agents.find((a) => a.grp_id === g.id && a.state === "running");
  const waiting = slices.filter((s) => s.status === "awaiting_boss").length;
  const done = slices.filter((s) => s.status === "accepted").length;
  const card = st.draftCards.find((c) => c.grpId === g.id);
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
          {STATUS_ZH[g.status] ?? g.status}
          {slices.length ? ` · 已查收 ${done}/${slices.length}` : ""}
          {g.spent_usd ? ` · ${money(g.spent_usd)}` : ""}
        </Meta>
      </div>
      <div className="min-w-0 max-[60rem]:col-span-full">
        {g.status === "PLANNING" ? (
          <span className="text-[0.75rem] text-ink-3">Dispatcher 在深挖，还没有切片</span>
        ) : g.status === "DRAFT" ? (
          <span className="text-[0.75rem] text-ink-2">
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
  const { page, rest, more } = usePaged(rows, 10);
  if (!rows.length) return null;
  return (
    <section className="mb-7">
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2.5">
        <h2 className="text-[0.8125rem] font-semibold">已交付 <span className="font-normal text-ink-3">{rows.length}</span></h2>
        <Meta>已合入 main，session 全退休</Meta>
      </div>
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
      {rest > 0 && <Button variant="quiet" size="sm" className="mt-1.5" onClick={more}>还有 {rest} 个</Button>}
    </section>
  );
}
