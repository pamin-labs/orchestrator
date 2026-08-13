import { Meta } from "../ui/bits";
import type { Group, Slice, State } from "../lib/api";
import { STATUS_ZH, STOPS, gates } from "../lib/select";
import { cn, money } from "../lib/utils";

/**
 * One track per requirement: slices in order, gates as discrete ticks inside each.
 *
 * Columns cannot show sequence, and sequence is what "走到哪" means here. The ticks
 * are fixed-width marks rather than a fill, so they cannot be read as a percentage
 * (a model's percentage is a guess; a gate is a fact).
 */
export function Pipeline({ st, groups, onOpen }: { st: State; groups: Group[]; onOpen: (id: number) => void }) {
  if (!groups.length) return null;
  return (
    <>
      <h2 className="mb-3 mt-9 text-[0.625rem] font-semibold uppercase tracking-[0.13em] text-ink-3">需求进度</h2>
      {groups.map((g) => {
        const slices = st.slices.filter((s) => s.grp_id === g.id);
        const doing = st.agents.find((a) => a.grp_id === g.id && a.state === "running");
        return (
          <button
            key={g.id}
            onClick={() => onOpen(g.id)}
            className="grid w-full cursor-pointer grid-cols-[9rem_minmax(0,1fr)_auto] items-center gap-3
                       border-t border-rule-soft px-2 py-3 text-left transition-colors hover:bg-sunk"
          >
            <div>
              <div className="font-display text-[0.9375rem] font-semibold break-words">{g.name}</div>
              <Meta>
                {STATUS_ZH[g.status] ?? g.status}
                {g.spent_usd ? ` · ${money(g.spent_usd)}` : ""}
              </Meta>
            </div>
            <div className="min-w-0">
              {g.status === "PLANNING" ? (
                <span className="text-[0.75rem] text-ink-3">拆解中</span>
              ) : g.status === "DRAFT" ? (
                <span className="text-[0.75rem] text-ink-3">计划卡待批</span>
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
            <Meta>{g.branch ?? ""}</Meta>
          </button>
        );
      })}
    </>
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
        "min-w-[4.5rem] flex-1 basis-24 rounded-[0.3125rem] border px-1.5 py-1",
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
            title={k}
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
