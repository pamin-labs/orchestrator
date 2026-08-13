import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { Empty, H3, Meta } from "../ui/bits";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Bar, Table, TBody, TD, TH, THead, TR } from "../ui/table";
import { Tip } from "../ui/tooltip";
import type { Cost, Frame, State } from "../lib/api";
import { STATUS_ZH, owns } from "../lib/select";
import { cn, K, money } from "../lib/utils";

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
  // Running first, then by requirement. At three agents the order does not matter;
  // at thirty, the two that are working are the only ones being looked for.
  const running = rows.filter((a) => a.state === "running");
  const rest = rows.filter((a) => a.state !== "running");
  const shown = idle ? [...running, ...rest] : running.length ? running : rows;

  return (
    <>
      <div className="mb-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
        <h2 className="text-[0.75rem] font-semibold tracking-[0.02em] text-ink-2">工位</h2>
        <Meta>在跑 {running.length} · 共 {rows.length}</Meta>
        <span className="grow" />
        {running.length > 0 && rest.length > 0 && (
          <Button variant="quiet" size="sm" onClick={() => setIdle((v) => !v)}>
            {idle ? "只看在跑的" : `连空闲的一起看（${rest.length}）`}
          </Button>
        )}
      </div>
      <Table min="54rem">
        <THead>
          <TR>
            <TH>角色</TH><TH>需求</TH><TH>切片</TH><TH num>turn</TH><TH>在做什么</TH><TH>model</TH><TH>权限</TH>
            <TH num>session</TH><TH num>支出</TH>
          </TR>
        </THead>
        <TBody>
          {shown.map((a) => {
            const sl = st.slices.find((s) => s.id === a.slice_id);
            const tail = last.get(a.id);
            return (
              <TR key={a.id}>
                <TD className="whitespace-nowrap font-mono text-[0.75rem]">
                  {a.state === "running" && <i className="breathe mr-1.5 inline-block size-1.5 rounded-full bg-ok" />}
                  {a.role}
                </TD>
                <TD className="max-w-[10rem] truncate text-[0.75rem] text-ink-2">
                  {st.groups.find((g) => g.id === a.grp_id)?.name ?? "常驻"}
                </TD>
                <TD className="max-w-[12rem]">
                  {sl ? (
                    <Tip label={sl.accept_spec}>
                      <span className="block truncate text-[0.75rem] text-ink-2">
                        <span className="font-mono text-[0.6875rem] text-ink-3">S{sl.seq}</span> {sl.title}
                      </span>
                    </Tip>
                  ) : (
                    <Meta>—</Meta>
                  )}
                </TD>
                <TD num>
                  {/* A high count on one slice is the visible shape of circling, and
                      the watchdog's own threshold is 5 turns on one file. */}
                  <span className={cn(a.turns >= 15 ? "text-warn" : "text-ink-3")}>{a.turns || "—"}</span>
                </TD>
                <TD className="max-w-[22rem]">
                  <div className="truncate text-[0.75rem] text-ink-2">{a.activity ?? a.state}</div>
                  {tail && <div className="truncate font-mono text-[0.625rem] text-ink-3">{tail.slice(-140)}</div>}
                </TD>
                <TD><Meta>{a.model.replace("claude-", "")}</Meta></TD>
                <TD><Meta>{a.clearance}</Meta></TD>
                <TD num><span className="text-ink-3">{K(a.session_tokens)}</span></TD>
                <TD num>{money(a.total_usd)}</TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
      {!idle && running.length > 0 && rest.length > 0 && (
        <div className="mt-2 text-[0.75rem] text-ink-3">另外 {rest.length} 个空闲，没在花钱。</div>
      )}
    </>
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
 * Where the money went, in the shape the data actually has.
 *
 * PLAN.md §13 risk ② is "this costs 5-10x a direct conversation", and the test for
 * it is the cost of one delivered requirement — so that is the headline.
 *
 * Underneath, the hierarchy is real and the first version flattened it: a slice
 * belongs to a requirement, and a role is either standing (Architect, Dispatcher,
 * CoS, Librarian — paid for across the whole project) or hired into one group (PM,
 * Engineer, QA). So requirements are the primary axis and open up to their own
 * slices and roster; standing roles are their own block, because attributing them to
 * any one requirement would be made up. 难度 stays last and separate: it is the only
 * row here that is a knob rather than a report.
 */
export function CostView({ st, cost, projectId }: { st: State; cost: Cost | null; projectId: number }) {
  if (!cost?.total?.usd) {
    return (
      <Empty>
        还没有花钱。批准计划卡之后，这里按需求（含它的切片和人）、常驻岗、难度三层归因 ——
        难度标签是单次需求成本最直接的旋钮（trivial 跑 haiku，normal 跑 sonnet，hard 跑 opus）。
      </Empty>
    );
  }
  const per = cost.delivered?.count ? cost.delivered.usd / cost.delivered.count : null;
  const standing = (cost.roles ?? []).filter((r) => r.grpId == null && r.usd);
  const groups = (cost.byGroup ?? []).filter((g) => g.usd).sort((a, b) => b.usd - a.usd);
  const topGroup = Math.max(1e-9, ...groups.map((g) => g.usd));
  const inGroups = groups.reduce((n, g) => n + g.usd, 0);

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end gap-x-10 gap-y-4">
        <Stat big label="累计" value={money(cost.total.usd)} sub={`${K(cost.total.tokens)} tokens`} />
        {/* The number to hold against "what would this have cost me directly". */}
        <Stat
          big
          label="每个已交付需求"
          value={per == null ? "还没有" : money(per)}
          sub={per == null ? "合入一个才有这个数" : `${cost.delivered.count} 个已交付`}
        />
        <Tip label="注入的 delta 必须留在最后一条 user message 末尾。这个数掉下来说明 prompt 组装被改坏了 —— agent 照跑、测试照绿，每个 turn 贵 3-5 倍。">
          <span>
            <Stat
              label="cache 命中"
              value={cost.cacheRatio == null ? "还没数据" : `${Math.round(cost.cacheRatio * 100)}%`}
              sub="最近 50 个 turn"
              warn={cost.cacheRatio != null && cost.cacheRatio < 0.5}
            />
          </span>
        </Tip>
      </div>

      <div className="mb-1 flex flex-wrap items-baseline gap-x-2.5">
        <h3 className="text-[0.8125rem] font-semibold">按需求</h3>
        <Meta>点开看它的切片和这一组的人。贵得离谱的通常是被打回过几轮的</Meta>
      </div>
      {groups.map((g) => (
        <GroupCost key={g.grpId} st={st} cost={cost} row={g} top={topGroup} share={g.usd / inGroups} />
      ))}

      {standing.length > 0 && (
        <Split
          title="常驻岗"
          note="跨需求共用，摊不到某一个需求上：Architect 切边界、Dispatcher 拆需求、Librarian 压缩、CoS 分诊"
          rows={standing}
        />
      )}
      <Split
        title="按难度"
        note="这一栏是旋钮：标签直接决定跑哪个 model，在计划卡上就能改"
        rows={cost.byDifficulty}
      />
    </>
  );
}

/** One requirement, and — on demand — the slices and people inside it. */
function GroupCost({
  st, cost, row, top, share,
}: {
  st: State; cost: Cost; row: { grpId: number; label: string; tokens: number; usd: number }; top: number; share: number;
}) {
  const [open, setOpen] = useState(false);
  const slices = st.slices
    .filter((s) => s.grp_id === row.grpId && s.spent_usd)
    .sort((a, b) => b.spent_usd - a.spent_usd);
  const roles = (cost.roles ?? []).filter((r) => r.grpId === row.grpId && r.usd).sort((a, b) => b.usd - a.usd);
  const inner = Math.max(1e-9, ...slices.map((s) => s.spent_usd), ...roles.map((r) => r.usd));
  const canOpen = slices.length > 0 || roles.length > 0;

  return (
    <>
      <button
        onClick={() => canOpen && setOpen((v) => !v)}
        disabled={!canOpen}
        className={cn(
          "grid w-full grid-cols-[minmax(6rem,14rem)_minmax(0,1fr)_3.5rem_4rem_3rem] items-center gap-x-3",
          "border-t border-rule-soft py-1.5 text-left",
          "max-[52rem]:grid-cols-[minmax(0,1fr)_4rem_3rem]",
          canOpen && "cursor-pointer hover:bg-sunk",
        )}
      >
        <span className="flex min-w-0 items-baseline gap-1.5">
          {canOpen && (
            <ChevronRight
              size={12}
              strokeWidth={2}
              className={cn("shrink-0 text-ink-3 transition-transform", open && "rotate-90")}
            />
          )}
          <span className="truncate text-[0.8125rem]" title={row.label}>{row.label}</span>
        </span>
        <Bar frac={row.usd / top} className="max-[52rem]:hidden" />
        <Meta className="text-right max-[52rem]:hidden">{K(row.tokens)}</Meta>
        <span className="text-right font-mono text-[0.8125rem]">{money(row.usd)}</span>
        <Meta className="text-right">{Math.round(share * 100)}%</Meta>
      </button>
      {open && (
        <div className="mb-1.5 border-l border-rule pl-3">
          {slices.length > 0 && (
            <>
              <Meta className="mt-1 block">切片（预算单位，超支在这一层最早看得见）</Meta>
              {slices.map((s) => (
                <Line key={s.id} label={`S${s.seq} ${s.title}`} tag={s.difficulty} tokens={s.spent_tokens} usd={s.spent_usd} top={inner} />
              ))}
            </>
          )}
          {roles.length > 0 && (
            <>
              <Meta className="mt-1.5 block">这一组的人</Meta>
              {roles.map((r) => (
                <Line key={r.label} label={r.label} tokens={r.tokens} usd={r.usd} top={inner} mono />
              ))}
            </>
          )}
        </div>
      )}
    </>
  );
}

function Line({
  label, tag, tokens, usd, top, mono,
}: {
  label: string; tag?: string; tokens: number; usd: number; top: number; mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[minmax(6rem,13rem)_minmax(0,1fr)_3.5rem_4rem] items-center gap-x-3 py-1
                    max-[52rem]:grid-cols-[minmax(0,1fr)_4rem]">
      <span className={cn("truncate text-[0.75rem] text-ink-2", mono && "font-mono")} title={label}>
        {label}
        {tag && <span className="ml-1.5 font-mono text-[0.625rem] text-ink-3">{tag}</span>}
      </span>
      <Bar frac={usd / top} className="max-[52rem]:hidden" />
      <Meta className="text-right max-[52rem]:hidden">{K(tokens)}</Meta>
      <span className="text-right font-mono text-[0.75rem]">{money(usd)}</span>
    </div>
  );
}

function Stat({
  label, value, sub, big, warn,
}: {
  label: string; value: string; sub?: string; big?: boolean; warn?: boolean;
}) {
  return (
    <span className="block">
      <span className="block text-[0.75rem] text-ink-3">{label}</span>
      <b
        className={cn(
          "block font-display font-semibold leading-tight",
          big ? "text-[1.75rem]" : "text-[1.25rem]",
          warn && "text-warn",
        )}
      >
        {value}
      </b>
      {sub && <span className="block font-mono text-[0.6875rem] text-ink-3">{sub}</span>}
    </span>
  );
}

/** A flat attribution: rows sorted by spend, share as a bar, numbers aligned. */
function Split({ title, rows, note }: { title: string; rows: { label: string; usd: number; tokens: number }[]; note: string }) {
  const list = rows.filter((r) => r.usd).sort((a, b) => b.usd - a.usd);
  if (!list.length) return null;
  const top = Math.max(...list.map((r) => r.usd));
  const sum = list.reduce((n, r) => n + r.usd, 0);
  return (
    <section className="mt-7">
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2.5">
        <h3 className="text-[0.8125rem] font-semibold">{title}</h3>
        <Meta>{note}</Meta>
      </div>
      {list.map((r) => (
        <div
          key={r.label}
          className="grid grid-cols-[minmax(6rem,14rem)_minmax(0,1fr)_3.5rem_4rem_3rem] items-center gap-x-3
                     border-t border-rule-soft py-1.5 max-[52rem]:grid-cols-[minmax(0,1fr)_4rem_3rem]"
        >
          <span className="truncate text-[0.8125rem]" title={r.label}>{r.label}</span>
          <Bar frac={r.usd / top} className="max-[52rem]:hidden" />
          <Meta className="text-right max-[52rem]:hidden">{K(r.tokens)}</Meta>
          <span className="text-right font-mono text-[0.8125rem]">{money(r.usd)}</span>
          {/* Share, because "$0.31" only means something next to a denominator. */}
          <Meta className="text-right">{Math.round((r.usd / sum) * 100)}%</Meta>
        </div>
      ))}
    </section>
  );
}
