import { useState } from "react";
import { Meta } from "../ui/bits";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tip } from "../ui/tooltip";
import type { Group, Slice, State } from "../lib/api";
import { STOPS, gates, heldApproved, statusLabel } from "../lib/select";
import { cn, K } from "../lib/utils";

/**
 * Every requirement in the project, one line each, running ones first.
 *
 * Two things this has to survive that the first version did not: showing that
 * several requirements are genuinely moving at once, and still being readable at a
 * hundred of them. So the eye gets a header that states the concurrency (在跑 3 / 上限
 * 3 — which also explains why a fourth is not starting), then a filtered, capped
 * list. Columns cannot show sequence, and sequence is what "走到哪" means, so each
 * row keeps its slices in order with the gates as discrete ticks inside them — a
 * fixed mark, never a fill, because a percentage from a model is a guess and a gate
 * is a fact.
 */

const BUCKETS = {
  live: { zh: "在跑", of: ["RUNNING", "PLANNING", "PAUSING"] },
  mine: { zh: "待办", of: ["DRAFT", "PR_OPEN"] },
  held: { zh: "停着", of: ["PAUSED", "PARKED"] },
} as const;
type Bucket = keyof typeof BUCKETS;

const bucketOf = (g: Group): Bucket =>
  // Approved and waiting on a boundary is not the boss's to act on.
  heldApproved(g)
    ? "held"
    : (Object.keys(BUCKETS) as Bucket[]).find((k) => BUCKETS[k].of.includes(g.status as never)) ?? "held";

/**
 * 概览 shows what is moving, not everything.
 *
 * The full, state-filtered list is 需求. Repeating it here made two pages that answer
 * the same question slightly differently, which is how a reader stops trusting
 * either. Eight rows plus a link.
 */
const PAGE = 8;

export function Pipeline({
  st, groups, onOpen, maxGroups, onAll,
}: {
  st: State; groups: Group[]; onOpen: (id: number) => void; maxGroups?: number; onAll?: () => void;
}) {
  const [only, setOnly] = useState<Bucket | null>(null);
  if (!groups.length) return null;

  const count = (b: Bucket) => groups.filter((g) => bucketOf(g) === b).length;
  const order: Bucket[] = ["live", "mine", "held"];
  const shown = groups
    .filter((g) => !only || bucketOf(g) === only)
    .sort((a, b) => order.indexOf(bucketOf(a)) - order.indexOf(bucketOf(b)) || a.id - b.id);
  const live = count("live");
  const page = shown.slice(0, PAGE);

  return (
    <>
      <div className="mb-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
        <h2 className="text-[0.75rem] font-semibold tracking-[0.02em] text-ink-2">需求</h2>
        {/* The slot count is why a fourth requirement is not moving. Without it a
            queued group looks stuck rather than queued. */}
        {maxGroups != null && (
          <Tip label={`并发上限 ${maxGroups} 组。满了之后新批准的需求排队，不是卡住。`}>
            <Meta className={cn("underline decoration-dotted", live >= maxGroups && "text-warn")}>
              并行 {live}/{maxGroups}
            </Meta>
          </Tip>
        )}
        <span className="grow" />
        {order.map((b) => {
          const n = count(b);
          if (!n) return null;
          return (
            <button
              key={b}
              onClick={() => setOnly((v) => (v === b ? null : b))}
              className={cn(
                "cursor-pointer rounded-md px-2 py-0.5 text-[0.75rem] transition-colors",
                only === b ? "bg-accent text-on-accent" : "text-ink-3 hover:bg-sunk hover:text-ink",
              )}
            >
              {BUCKETS[b].zh} {n}
            </button>
          );
        })}
      </div>

      {page.map((g) => (
        <Row key={g.id} st={st} g={g} onOpen={onOpen} />
      ))}

      {(shown.length > page.length || onAll) && (
        <Button variant="quiet" className="mt-2" onClick={onAll}>
          {shown.length > page.length ? `还有 ${shown.length - page.length} 个，看全部需求 →` : "看全部需求 →"}
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
  const b = bucketOf(g);
  return (
    <button
      onClick={() => onOpen(g.id)}
      className={cn(
        "grid w-full cursor-pointer grid-cols-[13rem_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5",
        "border-t border-rule-soft px-2 py-2.5 text-left transition-colors hover:bg-sunk",
        "max-[60rem]:grid-cols-[minmax(0,1fr)_auto]",
      )}
    >
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="truncate font-display text-[0.9375rem] font-semibold">{g.name}</span>
          {b === "live" && <i className="breathe size-1.5 shrink-0 rounded-full bg-ok" />}
        </div>
        <Meta>
          {statusLabel(g)}
          {slices.length ? ` · ${done}/${slices.length}` : ""}
          {g.spent_tokens ? ` · ${K(g.spent_tokens)} tokens` : ""}
        </Meta>
      </div>
      <div className="min-w-0 max-[60rem]:col-span-full">
        {g.status === "PLANNING" ? (
          <span className="text-[0.75rem] text-ink-3">拆解中，还没有切片</span>
        ) : heldApproved(g) ? (
          <Badge>已批准，等边界</Badge>
        ) : g.status === "DRAFT" ? (
          <Badge tone="mine">计划卡待批</Badge>
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
        {waiting > 0 && <Badge tone="mine">{waiting} 片待查收</Badge>}
        <Meta>{g.branch ?? ""}</Meta>
      </span>
    </button>
  );
}

function Seg({ s }: { s: Slice }) {
  const gs = gates(s);
  const waiting = s.status === "awaiting_boss";
  const failed = Object.values(gs).includes("fail");
  const mark = waiting ? "待查收" : s.status === "accepted" ? "✓" : s.status === "rejected" ? "退回" : s.status === "pending" ? "等" : "";
  return (
    <span
      title={`${s.title} — ${s.accept_spec}`}
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
      {/* The layers review.ts actually records. `self` was drawn here and never
          recorded anywhere, so the first tick was permanently grey — and the layer
          it stood in for, reconcile, is the one PLAN.md §7 calls worth more than
          the whole Auditor. */}
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
  );
}
