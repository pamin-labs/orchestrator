import * as Collapsible from "@radix-ui/react-collapsible";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { Empty, H3, Meta } from "../ui/bits";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Bar, Table, TBody, TD, TH, THead, TR } from "../ui/table";
import { Tip } from "../ui/tooltip";
import { BurnChart, SplitDonut } from "../ui/chart";
import type { Agent, AgentCost, Cost, Frame, Slice, State } from "../lib/api";
import { STATUS_ZH, owns } from "../lib/select";
import { cn, K } from "../lib/utils";

/**
 * Per PLAN.md §8: current slice, turn count, the live last line, model, clearance,
 * spend.
 *
 * The turn count and the last line are what separate a working agent from a stuck
 * one — "in_progress" looks identical either way, and turn 19 on one slice is the
 * shape of a loop. Both come free: the count is a query, the line is the SSE
 * stream the page is already holding, so nothing here costs an agent a token.
 */
export function Desk({ st, frames, projectId }: { st: State; frames: Frame[]; projectId: number }) {
  const ids = new Set(st.groups.filter((g) => g.project_id === projectId).map((g) => g.id));
  const rows = st.agents.filter((a) => !a.grp_id || ids.has(a.grp_id));
  const [idle, setIdle] = useState(false);
  if (!rows.length) {
    return <Empty>还没有人上工。批准一张计划卡，这里会列出每个 agent 在做什么、跑到第几个 turn、正在打印什么。</Empty>;
  }
  // Newest live frame per agent: the tail of what it is printing right now.
  const last = new Map<number, string>();
  for (const f of frames) {
    if (f.agentId != null && (f.cls === "partial" || f.cls === "tool")) last.set(f.agentId, f.text);
  }
  const running = rows.filter((a) => a.state === "running");
  const shown = idle ? rows : running.length ? running : rows;

  // Grouped by requirement, like everything else: nine columns across every agent
  // in the project was one table asking to be read four ways at once. A
  // requirement with someone running opens by itself, because "who is working" is
  // still the question this view answers first.
  const groups = [...new Set(shown.map((a) => a.grp_id))]
    .map((id) => ({
      id,
      name: id == null ? "常驻岗" : (st.groups.find((g) => g.id === id)?.name ?? `#${id}`),
      agents: shown.filter((a) => a.grp_id === id),
    }))
    .sort((a, b) => {
      const run = (x: typeof a) => x.agents.filter((y) => y.state === "running").length;
      return run(b) - run(a) || (a.id ?? 1e9) - (b.id ?? 1e9);
    });

  return (
    <>
      <div className="mb-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
        <h2 className="text-[0.75rem] font-semibold tracking-[0.02em] text-ink-2">工位</h2>
        <Meta>在跑 {running.length} · 共 {rows.length}</Meta>
        <span className="grow" />
        {running.length > 0 && rows.length > running.length && (
          <Button variant="quiet" size="sm" onClick={() => setIdle((v) => !v)}>
            {idle ? "只看在跑的" : `连空闲的一起看（${rows.length - running.length}）`}
          </Button>
        )}
      </div>
      <div className="divide-y divide-rule-soft">
        {groups.map((g) => (
          <Desks key={String(g.id)} name={g.name} agents={g.agents} slices={st.slices} tail={last} />
        ))}
      </div>
      {!idle && running.length > 0 && rows.length > running.length && (
        <div className="mt-2 text-[0.75rem] text-ink-3">另外 {rows.length - running.length} 个空闲，没在花钱。</div>
      )}
    </>
  );
}

/** 谁 · 在做什么 · turn · 累计. Four columns, no horizontal scroll, one ruler. */
const DESK_ROW =
  "grid grid-cols-[11rem_minmax(0,1fr)_2.5rem_4rem] items-baseline gap-x-4 px-3 max-[52rem]:grid-cols-[9rem_minmax(0,1fr)_2.5rem]";

/**
 * What the agent is doing, in the fewest words that are still true.
 *
 * The raw string is `command_execution: orch ctx query "…"`. The tool name is the
 * least interesting part — every row on this wall is a command — and it was eating
 * a third of the column before the part that says what is happening.
 */
const activityOf = (a: Agent): string =>
  (a.activity ?? a.state).replace(/^(command_execution|file_change|Bash|Read|Grep|Glob|Edit|Write):\s*/, "");

function Desks({
  name, agents, slices, tail,
}: {
  name: string; agents: Agent[]; slices: Slice[]; tail: Map<number, string>;
}) {
  const runners = agents.filter((a) => a.state === "running").length;
  const [open, setOpen] = useState(runners > 0);
  const list = [...agents].sort((a, b) => Number(b.state === "running") - Number(a.state === "running"));

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger
        className={cn(
          "flex w-full cursor-pointer items-baseline gap-2.5 rounded-md px-3 py-2.5",
          "text-left transition-colors hover:bg-sunk",
        )}
      >
        <ChevronRight
          size={12}
          strokeWidth={2}
          className={cn("shrink-0 self-center text-ink-3 transition-transform duration-150", open && "rotate-90")}
        />
        <span className="truncate text-[0.8125rem]" title={name}>{name}</span>
        {runners > 0 && <i className="breathe size-1.5 shrink-0 self-center rounded-full bg-ok" />}
        {/* Who is running, by role. "2 在跑" makes you open the row to learn the
            one thing you opened it for. */}
        <Meta className="truncate">
          {runners > 0
            ? agents.filter((a) => a.state === "running").map((a) => a.role).join(" · ")
            : "空闲"}
        </Meta>
        <span className="grow" />
        {(() => {
          const sum = agents.reduce((n, a) => n + a.total_tokens, 0);
          return sum ? <Meta>{K(sum)}</Meta> : null;
        })()}
      </Collapsible.Trigger>
      <Collapsible.Content className="fade-in">
        <div className="mb-1 rounded-md bg-sunk/40 py-2">
          {list.map((a) => {
            const sl = slices.find((s) => s.id === a.slice_id);
            const doing = activityOf(a);
            // The live tail is the same string as the activity often enough that
            // printing both made every row look like it stuttered.
            const t = tail.get(a.id);
            const stream = t && !doing.includes(t.slice(-40)) ? t : null;
            return (
              <div key={a.id} className={cn(DESK_ROW, "py-1.5")}>
                {/* Clearance and the session count moved into this label: neither
                    answers "who is working on what", and two more columns for them
                    is what made this table nine wide. */}
                <Tip label={`权限 ${a.clearance} · 本 session ${K(a.session_tokens)} tokens · ${a.model}`}>
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className="truncate font-mono text-[0.75rem]">{a.role}</span>
                    <Meta className="truncate">{a.model.replace("claude-", "")}</Meta>
                  </span>
                </Tip>
                <span className="min-w-0">
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    {sl && (
                      <Tip label={sl.accept_spec}>
                        <span className="shrink-0 font-mono text-[0.6875rem] text-ink-3">S{sl.seq}</span>
                      </Tip>
                    )}
                    <span className="truncate font-mono text-[0.6875rem] text-ink-2">{doing}</span>
                  </span>
                  {stream && (
                    <span className="mt-0.5 block truncate font-mono text-[0.6875rem] text-ink-3">{stream.slice(-120)}</span>
                  )}
                </span>
                {/* A high count on one slice is the visible shape of circling, and
                    the watchdog's own threshold is 5 turns on one file. Blank at
                    zero: a column of em-dashes is a column of nothing. */}
                <Meta className={cn("text-right", a.turns >= 15 && "text-warn")}>{a.turns || ""}</Meta>
                <Meta className="text-right max-[52rem]:hidden">{a.total_tokens ? K(a.total_tokens) : ""}</Meta>
              </div>
            );
          })}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

/**
 * Who may write where, and — the actual question — who collides with whom.
 *
 * The verdict was at the bottom, under a table whose middle column stacked every
 * owned path on its own line, so twelve requirements made a page you scrolled to
 * reach the one sentence that mattered. Now the verdict is the first thing, the
 * paths are chips that wrap, and the status column is gone: it read 在跑 on every
 * row, which is a column that costs width to say nothing.
 */
export function Owns({ st, projectId }: { st: State; projectId: number }) {
  const all = st.groups.filter((g) => g.project_id === projectId);
  const gs = all.filter((g) => owns(g).length);
  const bare = all.filter((g) => !owns(g).length);
  if (!gs.length) {
    return (
      <Empty>
        还没有划过边界。Architect 在开工前划定每组能写哪些路径，沙盒按这个挡写操作 ——
        没划的组一旦并行就会踩到同一批文件。
        {bare.length > 0 && `目前 ${bare.length} 个需求没有边界：${bare.map((g) => g.name).join("、")}。`}
      </Empty>
    );
  }
  const pairs: [string, string, string[]][] = [];
  for (let i = 0; i < gs.length; i++)
    for (let j = i + 1; j < gs.length; j++) {
      const [a1, b1] = [gs[i]!, gs[j]!];
      const hit = owns(a1).filter((a) =>
        owns(b1).some((b) => a === b || a.startsWith(b.replace(/\*+$/, "")) || b.startsWith(a.replace(/\*+$/, ""))),
      );
      if (hit.length) pairs.push([a1.name, b1.name, hit]);
    }

  return (
    <>
      {/* The verdict, first and in one line. */}
      <div
        className={cn(
          "mb-4 flex flex-wrap items-baseline gap-x-2 border-b pb-3 text-[0.8125rem]",
          pairs.length ? "border-bad/40 text-bad" : "border-rule",
        )}
      >
        {pairs.length ? (
          <>
            <b className="font-semibold">路径重叠 {pairs.length} 处，这些组不能并行</b>
            <Meta className="text-bad">Architect 得重新切边界</Meta>
          </>
        ) : (
          <>
            <b className="font-semibold">边界两两不相交</b>
            <Meta>{gs.length} 个需求可以同时开工{bare.length ? `，另有 ${bare.length} 个还没划` : ""}</Meta>
          </>
        )}
      </div>

      {pairs.map(([a, b, hit]) => (
        <div key={a + b} className="mb-2.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-[0.8125rem]">
          <span className="text-bad">{a} ↔ {b}</span>
          {hit.map((h) => (
            <span key={h} className="rounded-sm bg-bad-soft px-1.5 py-0.5 font-mono text-[0.6875rem] text-bad">{h}</span>
          ))}
        </div>
      ))}

      <div className="mt-5">
        {[...gs, ...bare].map((g) => (
          <div
            key={g.id}
            className="grid grid-cols-[12rem_minmax(0,1fr)] items-baseline gap-x-5 border-t border-rule-soft
                       px-3 py-3 max-[52rem]:grid-cols-1 max-[52rem]:gap-y-1.5"
          >
            <span className="truncate text-[0.8125rem]" title={g.name}>{g.name}</span>
            {/* Chips that wrap, not a stack. Eight owned paths were eight rows of
                height for one requirement, and the page is a comparison. */}
            <span className="flex min-w-0 flex-wrap gap-x-2 gap-y-1.5">
              {owns(g).length ? (
                owns(g).map((o) => (
                  <span key={o} className="rounded-sm bg-sunk px-1.5 py-0.5 font-mono text-[0.6875rem] text-ink-2">{o}</span>
                ))
              ) : (
                <Badge tone="warn">未划定</Badge>
              )}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * Where the tokens went, in the shape the data actually has.
 *
 * Tokens and nothing else. The dollar figure that used to lead this page was
 * notional — claude's CLI reports what a turn would have cost at API rates, codex
 * reports nothing, and the boss pays neither, because two subscriptions do. Once
 * five of eight roles moved to codex, half the table read "$0.00", which is not a
 * small number: it is a claim that the work was free. What is left on the header
 * for "how much is there" is the quota percentage.
 *
 * The hierarchy is real and the first version flattened it: project, then the
 * requirement, then the people inside it and what each of them was running on.
 * Standing agents are their own block, because attributing an Architect to any one
 * requirement would be made up. 难度 and 账号 stay last and flat: one is a knob,
 * the other is which subscription paid.
 */
export function CostView({ cost }: { cost: Cost | null }) {
  if (!cost?.total?.tokens) {
    return (
      <Empty>
        还没花 token。批准计划卡之后，这里从项目总量往下拆：每个需求多少，点开是需求里每个 agent
        多少、各自跑的什么模型。难度标签是最直接的旋钮，它决定跑哪个模型。
      </Empty>
    );
  }
  const per = cost.delivered?.count ? cost.delivered.tokens / cost.delivered.count : null;
  const agents = cost.agents ?? [];
  const standing = agents.filter((a) => a.grpId == null && a.tokens);
  const standingTotal = standing.reduce((n, a) => n + a.tokens, 0);
  const groups = (cost.byGroup ?? []).filter((g) => g.tokens).sort((a, b) => b.tokens - a.tokens);
  const top = Math.max(1e-9, ...groups.map((g) => g.tokens), standingTotal);
  const sum = groups.reduce((n, g) => n + g.tokens, 0) + standingTotal;

  return (
    <>
      {/* One line, not a hero. "Dashboards of big numbers" is an anti-reference in
          PRODUCT.md and every useful number here is comparative — a token total
          means nothing without the requirement it bought — so the two facts that
          qualify it sit on the same baseline rather than under it as supporting
          stats. */}
      <div className="mb-4 flex flex-wrap items-baseline gap-x-5 gap-y-1 border-b border-rule pb-3">
        <span className="flex items-baseline gap-1.5">
          <b className="font-mono text-[1.375rem] font-semibold leading-none">{K(cost.total.tokens)}</b>
          <span className="text-[0.75rem] text-ink-3">tokens · 这个项目累计</span>
        </span>
        <span className="text-[0.75rem] text-ink-2">
          每个已交付需求{" "}
          <b className="font-mono font-semibold text-ink">{per == null ? "—" : K(per)}</b>
          <span className="text-ink-3">{per == null ? "（合入一个才有）" : `（${cost.delivered.count} 个）`}</span>
        </span>
        <Tip label="注入的 delta 必须留在最后一条 user message 末尾。这个数掉下来说明 prompt 组装被改坏了 —— agent 照跑、测试照绿，每个 turn 贵 3-5 倍。">
          <span className="text-[0.75rem] text-ink-2 underline decoration-dotted">
            cache 命中{" "}
            <b
              className={cn(
                "font-mono font-semibold",
                cost.cacheRatio == null ? "text-ink-3" : cost.cacheRatio < 0.5 ? "text-warn" : "text-ink",
              )}
            >
              {cost.cacheRatio == null ? "还没数据" : `${Math.round(cost.cacheRatio * 100)}%`}
            </b>
          </span>
        </Tip>
      </div>

      {/* Two columns, and the page stops at the viewport. Stacking four sections
          down the page meant the two smallest — three difficulties and two
          accounts, five rows between them — pushed the one list that grows off the
          bottom. The list scrolls in its own column; the fixed-size things sit
          beside it and never move. */}
      <div className="grid grid-cols-[minmax(0,1fr)_17rem] gap-x-8 max-[64rem]:grid-cols-1 max-[64rem]:gap-y-6">
        <div className="min-w-0">
          <SectionHead title="按需求" note="点开是这一组的人和各自跑的模型" scope="需求" />
          <div>
            {groups.map((g) => (
              <Node
                key={g.grpId}
                label={g.label}
                tokens={g.tokens}
                top={top}
                share={g.tokens / sum}
                rows={agents.filter((a) => a.grpId === g.grpId && a.tokens)}
              />
            ))}
            {standing.length > 0 && (
              <Node
                label="常驻岗"
                note="跨需求共用，摊不到某一个需求上"
                tokens={standingTotal}
                top={top}
                share={standingTotal / sum}
                rows={standing}
              />
            )}
          </div>
        </div>

        {/* Sticky rather than a second scrollbar: the fixed-size blocks stay put
            while the list that grows moves past them. */}
        <aside className="min-w-0 self-start max-[64rem]:static lg:sticky lg:top-0">
          <Rail title="烧得多快" note="近 48 小时，按小时">
            <BurnChart data={cost.byHour ?? []} />
          </Rail>
          <Rail title="按账号" note="哪个订阅在付">
            <SplitDonut rows={cost.byRuntime ?? []} />
          </Rail>
          <Rail title="按难度" note="标签决定跑哪个 model，计划卡上能改">
            <SplitDonut rows={cost.byDifficulty ?? []} />
          </Rail>
        </aside>
      </div>
    </>
  );
}

/**
 * One numeric grid for the whole page.
 *
 * Same reason the slice lanes fix their columns: a number whose left edge moves
 * with the label above it cannot be compared with that one, and comparing them is
 * the entire view. The header row, the requirements and the agents nested inside
 * them all land on the same right-hand columns.
 */
const ROW = cn(
  "grid grid-cols-[minmax(0,1fr)_5rem_2.75rem_4.5rem] items-center gap-x-4 px-3",
  "max-[52rem]:grid-cols-[minmax(0,1fr)_5rem_2.75rem]",
);

function SectionHead({ title, note, scope }: { title: string; note: string; scope: string }) {
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-2.5">
        <h3 className="text-[0.8125rem] font-semibold">{title}</h3>
        <Meta>{note}</Meta>
      </div>
      {/* The columns need naming. A right-aligned number and a percentage next to
          each other are two plausible readings of the same pair, and the reader
          should not have to work it out from the magnitudes. */}
      <div className={cn(ROW, "pb-1 pt-1 text-[0.6875rem] text-ink-3")}>
        <span>{scope}</span>
        <span className="text-right">tokens</span>
        <span className="text-right">占比</span>
        <span className="max-[52rem]:hidden" />
      </div>
    </>
  );
}

/** A fixed-size block in the right rail. Never grows, so it never pushes the list. */
function Rail({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="mb-5 last:mb-0">
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2">
        <h3 className="text-[0.8125rem] font-semibold">{title}</h3>
        <Meta>{note}</Meta>
      </div>
      {children}
    </section>
  );
}



/**
 * One requirement, opening onto the agents inside it.
 *
 * Radix rather than a hand-rolled toggle, and the same primitive the diff's file
 * tree uses: aria-expanded, the disclosure keyboard contract and the space/enter
 * handling come with it, and this page had none of the three.
 */
function Node({
  label, note, tokens, top, share, rows,
}: {
  label: string;
  note?: string;
  tokens: number;
  top: number;
  share: number;
  rows: AgentCost[];
}) {
  const [open, setOpen] = useState(false);
  const list = [...rows].sort((a, b) => b.tokens - a.tokens);
  const inner = Math.max(1e-9, ...list.map((r) => r.tokens));

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger
        disabled={!list.length}
        className={cn(
          ROW,
          "w-full border-t border-rule-soft py-2.5 text-left transition-colors",
          list.length && "cursor-pointer hover:bg-sunk",
        )}
      >
        <span className="flex min-w-0 items-baseline gap-1.5">
          <ChevronRight
            size={12}
            strokeWidth={2}
            className={cn(
              "shrink-0 transition-transform duration-150",
              open && "rotate-90",
              list.length ? "text-ink-3" : "invisible",
            )}
          />
          <span className="truncate text-[0.8125rem]" title={label}>{label}</span>
          {note && <Meta className="truncate max-[52rem]:hidden">{note}</Meta>}
        </span>
        <span className="text-right font-mono text-[0.8125rem]">{K(tokens)}</span>
        <Meta className="text-right">{Math.round(share * 100)}%</Meta>
        <Bar frac={tokens / top} className="max-[52rem]:hidden" />
      </Collapsible.Trigger>
      <Collapsible.Content className="fade-in">
        <div className="mb-1 rounded-md bg-sunk/40 py-1.5">
          {list.map((a) => (
            <div key={a.id} className={cn(ROW, "py-1")}>
              {/* Role and model together: "the engineer took 4M" is half a fact
                  until you know which model it took them on. Indented past the
                  chevron so the nesting is the indent, not a rule down the side. */}
              <span className="flex min-w-0 items-baseline gap-1.5 pl-[1.125rem]">
                <span className="truncate font-mono text-[0.75rem] text-ink-2">{a.role}</span>
                <Meta className="truncate">{a.model}</Meta>
              </span>
              <span className="text-right font-mono text-[0.75rem] text-ink-2">{K(a.tokens)}</span>
              {/* Share of this requirement, not of the project: inside the open row
                  the question is which of these people spent it. */}
              <Meta className="text-right">{Math.round((a.tokens / tokens) * 100)}%</Meta>
              <Bar frac={a.tokens / inner} className="max-[52rem]:hidden" />
            </div>
          ))}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}


