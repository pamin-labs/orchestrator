import { Meta, Pane } from "../ui/bits";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tab, TabList, TabPanel, Tabs } from "../ui/tabs";
import { Tip } from "../ui/tooltip";
import { prUrl } from "../lib/select";
import type { Archived, Group, Slice, State } from "../lib/api";
import { usePaged } from "../lib/page";
import { STOPS, countWaiting, gates, heldApproved, statusLabel } from "../lib/select";
import { cn, K } from "../lib/utils";

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
  of: string[];
  mine?: boolean;
}

/**
 * 待办 is the queue itself, not a fourth list of requirements.
 *
 * It used to be both: a pinned card of everything waiting on the boss, and a tab
 * holding the requirements those items came from. Two things labelled 待办 with two
 * different counts, one above the other. The card also sat outside the scroll pane,
 * so a two-paragraph question pushed the list off the bottom of a fixed-height page.
 *
 * Now the queue lives in the tab that names it, inside the same pane everything else
 * scrolls in, and 进行中 holds every requirement that has not been delivered — a
 * DRAFT waiting on approval is still in flight, and its decision is one tab over.
 */
const BUCKETS: Bucket[] = [
  { key: "mine", zh: "待办", of: [], mine: true },
  { key: "live", zh: "进行中", of: ["RUNNING", "PLANNING", "PAUSING", "DRAFT", "PR_OPEN"] },
  { key: "held", zh: "停着", of: ["PAUSED", "PARKED"] },
];
const DONE = "done";

export function Progress({
  st,
  projectId,
  onOpen,
  maxGroups,
  tab,
  onTab,
  queue,
}: {
  st: State;
  projectId: number;
  onOpen: (id: number) => void;
  maxGroups?: number | null;
  /** From the hash, so it survives opening a requirement and coming back. */
  tab: string | null;
  onTab: (t: string) => void;
  /** What needs the boss. Rendered as the 待办 tab, not above it. */
  queue?: React.ReactNode;
}) {
  const groups = st.groups.filter((g) => g.project_id === projectId);
  const archived = (st.archived ?? []).filter((a) => a.project_id === projectId);
  // A group already approved is not the boss's to act on: it belongs with the
  // other things that are simply waiting.
  const of = (b: Bucket) => groups.filter((g) => (heldApproved(g) ? b.key === "held" : b.of.includes(g.status)));
  const live = groups.filter((g) => ["RUNNING", "PLANNING", "PAUSING"].includes(g.status)).length;
  const todo = countWaiting(st, projectId);

  // Open on the tab that has something for the boss; failing that, on the work.
  // Only when the boss has not chosen one — this used to be component state, so
  // drilling into a requirement unmounted the list and this heuristic quietly
  // overrode their choice on the way back.
  const fallback = todo
    ? "mine"
    : (BUCKETS.slice(1).find((b) => of(b).length)?.key ?? (archived.length ? DONE : "live"));

  if (!groups.length && !archived.length) {
    return <div className="text-[0.8125rem] text-ink-3">这个项目还没有需求。右上角 ＋ 新需求，写一句话就行。</div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Tabs value={tab ?? fallback} onValueChange={onTab} className="flex min-h-0 flex-1 flex-col">
        <TabList>
          {BUCKETS.map((b) => (
            <Tab key={b.key} value={b.key} count={b.mine ? todo : of(b).length} mine={b.mine}>
              {b.zh}
            </Tab>
          ))}
          <Tab value={DONE} count={archived.length}>
            已交付
          </Tab>
          <span className="grow" />
          {/* The slot cap is why an approved requirement can sit still: queued, not
            stuck. Without it that difference is invisible. */}
          {maxGroups != null && (
            <Tip label={`并发上限 ${maxGroups} 组。满了已批准的需求排队等槽位，不是卡住了。`}>
              <Meta className={cn("self-center underline decoration-dotted", live >= maxGroups && "text-warn")}>
                并行 {live}/{maxGroups}
              </Meta>
            </Tip>
          )}
        </TabList>

        {BUCKETS.map((b) => (
          <TabPanel key={b.key} value={b.key} className="flex min-h-0 flex-1 flex-col">
            <Pane>{b.mine ? queue : <List st={st} groups={of(b)} onOpen={onOpen} empty={emptyOf(b.key)} />}</Pane>
          </TabPanel>
        ))}
        <TabPanel value={DONE} className="flex min-h-0 flex-1 flex-col">
          <Pane>
            <Done rows={archived} />
          </Pane>
        </TabPanel>
      </Tabs>
    </div>
  );
}

/** Absence, with the reason it is absent. A bare "无" teaches nothing. */
function emptyOf(key: string): string {
  // No `mine` case: that bucket renders the queue, which carries its own empty
  // line. The copy that lived here was a second, drifting version of it.
  if (key === "live") return "没有在办的需求。右上角 ＋ 新需求。";
  return "没有停着的需求。预算用尽、或等你答问题超过 2 小时会封存到这里，工作不丢。";
}

function List({
  st,
  groups,
  onOpen,
  empty,
}: {
  st: State;
  groups: Group[];
  onOpen: (id: number) => void;
  empty: string;
}) {
  const { page, rest, more, total } = usePaged(groups, 25);
  if (!groups.length) return <div className="text-[0.8125rem] text-ink-3">{empty}</div>;
  return (
    <>
      {page.map((g) => (
        <Row key={g.id} st={st} g={g} onOpen={onOpen} />
      ))}
      {rest > 0 && (
        <Button variant="quiet" size="sm" className="mt-2" onClick={more}>
          还有 {rest} 个（共 {total}）
        </Button>
      )}
    </>
  );
}

function Row({ st, g, onOpen }: { st: State; g: Group; onOpen: (id: number) => void }) {
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
        // `rail`, not `sunk`: an accepted slice's card is `bg-sunk`, so a row that
        // hovers to that colour makes the cards it is made of disappear.
        "border-t border-rule-soft first:border-t-0 px-2 py-2.5 text-left transition-colors hover:bg-rail/70",
        "max-[60rem]:grid-cols-[minmax(0,1fr)_auto]",
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
          {g.spent_tokens ? ` · ${K(g.spent_tokens)} tokens` : ""}
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
            {slices.map((s) => (
              <Seg key={s.id} s={s} />
            ))}
          </div>
        )}
        {doing && (
          <div className="mt-1 truncate font-mono text-[0.6875rem] text-ink-2">
            {doing.role} ▸ {doing.activity}
          </div>
        )}
      </div>
      <span className="flex items-center gap-2 whitespace-nowrap">
        {broke && <Badge tone="mine">预算用尽</Badge>}
        {waiting > 0 && <Badge tone="mine">{waiting} 片待查收</Badge>}
        {/* The row is a button, so this cannot be an <a>. It still has to go to the
            PR: "PR 待合入" that does not take you to the PR is a label describing
            work it will not let you do. */}
        {g.status === "PR_OPEN" &&
          (prUrl(st, g) ? (
            <Badge
              tone="mine"
              className="cursor-pointer underline decoration-dotted underline-offset-2"
              onClick={(e) => {
                e.stopPropagation();
                window.open(prUrl(st, g)!, "_blank", "noopener");
              }}
            >
              去合并 PR ↗
            </Badge>
          ) : (
            <Badge tone="mine">PR 待合入</Badge>
          ))}
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
    : s.status === "accepted"
      ? "✓"
      : s.status === "rejected"
        ? "退回"
        : s.status === "pending"
          ? "等"
          : "";
  return (
    <Tip label={`${s.title} — ${s.accept_spec}`}>
      <span
        className={cn(
          "w-32 shrink-0 rounded-[0.3125rem] border px-1.5 py-1",
          waiting && "border-accent bg-accent-soft",
          !waiting && s.status === "accepted" && "border-rule-soft bg-sunk",
          !waiting && s.status !== "accepted" && (failed || s.status === "rejected") && "border-bad",
          !waiting &&
            s.status !== "accepted" &&
            !failed &&
            s.status !== "rejected" &&
            s.status !== "pending" &&
            "border-ink-3",
          !waiting && s.status === "pending" && "border-rule",
        )}
      >
        <span
          className={cn(
            "flex items-center gap-1 font-mono text-[0.625rem] text-ink-3",
            waiting && "font-semibold text-accent",
          )}
        >
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
      {page.map((a) => (
        <div
          key={a.id}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3 border-t border-rule-soft first:border-t-0 px-2 py-2"
        >
          <span className="min-w-0 truncate text-[0.8125rem] text-ink-2">
            {a.name}
            {a.pr_number ? <Meta className="ml-2">#{a.pr_number}</Meta> : null}
          </span>
          <Meta>{a.slices} 片</Meta>
        </div>
      ))}
      {rest > 0 && (
        <Button variant="quiet" size="sm" className="mt-2" onClick={more}>
          还有 {rest} 个（共 {total}）
        </Button>
      )}
    </>
  );
}
