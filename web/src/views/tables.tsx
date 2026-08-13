import * as Collapsible from "@radix-ui/react-collapsible";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { Empty, H3, Meta } from "../ui/bits";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Bar, Table, TBody, TD, TH, THead, TR } from "../ui/table";
import { Tip } from "../ui/tooltip";
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
      {groups.map((g) => (
        <Desks key={String(g.id)} name={g.name} agents={g.agents} slices={st.slices} tail={last} />
      ))}
      {!idle && running.length > 0 && rows.length > running.length && (
        <div className="mt-2 text-[0.75rem] text-ink-3">另外 {rows.length - running.length} 个空闲，没在花钱。</div>
      )}
    </>
  );
}

/** 谁 · 在做什么 · turn · 累计. Four columns, no horizontal scroll, one ruler. */
const DESK_ROW = "grid grid-cols-[10rem_minmax(0,1fr)_3rem_4.5rem] items-baseline gap-x-3 px-2 max-[52rem]:grid-cols-[8rem_minmax(0,1fr)_3rem]";

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
          "flex w-full cursor-pointer items-baseline gap-2 border-t border-rule-soft px-2 py-1.5",
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
        <Meta>{runners > 0 ? `${runners} 在跑` : "空闲"}</Meta>
        <span className="grow" />
        <Meta>{K(agents.reduce((n, a) => n + a.total_tokens, 0))}</Meta>
      </Collapsible.Trigger>
      <Collapsible.Content className="fade-in">
        <div className="mb-1.5 bg-sunk/50 py-1">
          {list.map((a) => {
            const sl = slices.find((s) => s.id === a.slice_id);
            const t = tail.get(a.id);
            return (
              <div key={a.id} className={cn(DESK_ROW, "py-0.5")}>
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
                    <span className="truncate text-[0.75rem] text-ink-2">{a.activity ?? a.state}</span>
                  </span>
                  {t && <span className="block truncate font-mono text-[0.625rem] text-ink-3">{t.slice(-140)}</span>}
                </span>
                {/* A high count on one slice is the visible shape of circling, and
                    the watchdog's own threshold is 5 turns on one file. */}
                <Meta className={cn("text-right", a.turns >= 15 && "text-warn")}>{a.turns || "—"}</Meta>
                <Meta className="text-right max-[52rem]:hidden">{K(a.total_tokens)}</Meta>
              </div>
            );
          })}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

/** Overlap is what this view exists for: two groups owning one path is the thing
    file ownership prevents, so it gets named rather than implied. */
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
      const hit = owns(gs[i]).filter((a) =>
        owns(gs[j]).some((b) => a === b || a.startsWith(b.replace(/\*+$/, "")) || b.startsWith(a.replace(/\*+$/, ""))),
      );
      if (hit.length) pairs.push([gs[i].name, gs[j].name, hit]);
    }
  return (
    <>
      <Table min="30rem">
        <THead><TR><TH>需求</TH><TH>owns</TH><TH>状态</TH></TR></THead>
        <TBody>
          {gs.map((g) => (
            <TR key={g.id}>
              <TD>{g.name}</TD>
              <TD><Meta>{owns(g).map((o) => <div key={o}>{o}</div>)}</Meta></TD>
              <TD className="text-[0.75rem] text-ink-3">{STATUS_ZH[g.status] ?? g.status}</TD>
            </TR>
          ))}
          {/* A group with no boundary is the risk this view exists to show, so it is
              a row here rather than an omission. */}
          {bare.map((g) => (
            <TR key={g.id}>
              <TD>{g.name}</TD>
              <TD><Badge tone="warn">未划定</Badge></TD>
              <TD className="text-[0.75rem] text-ink-3">{STATUS_ZH[g.status] ?? g.status}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
      {pairs.length ? (
        <>
          <H3 className="text-bad">路径重叠，禁止并行</H3>
          {pairs.map(([a, b, hit]) => (
            <div key={a + b} className="text-[0.75rem] text-bad">
              {a} 和 {b}：<span className="font-mono">{hit.join(" ")}</span>
            </div>
          ))}
        </>
      ) : (
        <>
          <H3>无重叠</H3>
          <Empty>路径两两不相交，可并行开工。</Empty>
        </>
      )}
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
          PRODUCT.md and the useful numbers here are all comparative — a token total
          means nothing without the requirement it bought. So the total sits at the
          scale DESIGN.md reserves for it and the two facts that qualify it sit on
          the same baseline. */}
      <div className="mb-5 flex flex-wrap items-baseline gap-x-5 gap-y-1 border-b border-rule pb-3">
        <span className="flex items-baseline gap-1.5">
          <b className="font-mono text-[1.375rem] font-semibold leading-none">{K(cost.total.tokens)}</b>
          <span className="text-[0.75rem] text-ink-3">tokens 累计</span>
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

      <Section title="按需求" note="点开是这一组的人和各自跑的模型。贵得离谱的通常是被打回过几轮的">
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
      </Section>

      <Section title="按难度" note="这一栏是旋钮：标签直接决定跑哪个 model，在计划卡上就能改">
        <Flat rows={cost.byDifficulty} />
      </Section>
      <Section title="按账号" note="哪个订阅在被花。顶栏的百分比是这两个池子还剩多少，这里是花在了什么上">
        <Flat rows={cost.byRuntime ?? []} />
      </Section>
    </>
  );
}

/**
 * One numeric grid for the whole page.
 *
 * Same reason the slice lanes fix their columns: a number whose left edge moves
 * with the label above it cannot be compared with that one, and comparing them is
 * the entire view. Requirements, the agents nested inside them, 难度 and 账号 all
 * land on the same three right-hand columns, so the eye reads one ruler down the
 * page instead of four.
 */
const ROW = cn(
  "grid grid-cols-[minmax(0,1fr)_5rem_2.75rem_4.5rem] items-center gap-x-3 px-2",
  "max-[52rem]:grid-cols-[minmax(0,1fr)_5rem_2.75rem]",
);

function Section({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="mt-7 first:mt-0">
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2.5">
        <h3 className="text-[0.8125rem] font-semibold">{title}</h3>
        <Meta>{note}</Meta>
      </div>
      {children}
    </section>
  );
}

/** A flat attribution: no children to open, same ruler, share against the section. */
function Flat({ rows }: { rows: { label: string; tokens: number }[] }) {
  const list = rows.filter((r) => r.tokens).sort((a, b) => b.tokens - a.tokens);
  if (!list.length) return null;
  const top = Math.max(...list.map((r) => r.tokens));
  const sum = list.reduce((n, r) => n + r.tokens, 0);
  return (
    <>
      {list.map((r) => (
        <div key={r.label} className={cn(ROW, "border-t border-rule-soft py-1.5")}>
          <span className="truncate pl-[1.125rem] text-[0.8125rem]" title={r.label}>{r.label}</span>
          <span className="text-right font-mono text-[0.8125rem]">{K(r.tokens)}</span>
          {/* A share of one row is 100%, which says nothing. */}
          <Meta className="text-right">{list.length > 1 ? `${Math.round((r.tokens / sum) * 100)}%` : ""}</Meta>
          <Bar frac={r.tokens / top} className="max-[52rem]:hidden" />
        </div>
      ))}
    </>
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
          "w-full border-t border-rule-soft py-1.5 text-left transition-colors",
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
        <div className="mb-1.5 bg-sunk/50 py-0.5">
          {list.map((a) => (
            <div key={a.id} className={ROW}>
              {/* Role and model together: "the engineer took 4M" is half a fact
                  until you know which model it took them on. Indented past the
                  chevron so the nesting is the indent, not a rule down the side. */}
              <span className="flex min-w-0 items-baseline gap-1.5 pl-[1.125rem]">
                <span className="truncate font-mono text-[0.75rem] text-ink-2">{a.role}</span>
                <Meta className="truncate" title={a.model}>{a.model}</Meta>
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


