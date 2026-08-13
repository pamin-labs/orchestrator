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

/** Per PLAN.md §8: by requirement, slice, role and difficulty, plus cache hit rate. */
export function CostView({ st, cost, projectId }: { st: State; cost: Cost | null; projectId: number }) {
  if (!cost?.total?.usd) {
    return (
      <Empty>
        还没有花钱。批准计划卡之后，这里按需求、切片、角色、难度四个维度归因 ——
        难度标签是单次需求成本最直接的旋钮。
      </Empty>
    );
  }
  const ids = new Set(st.groups.filter((g) => g.project_id === projectId).map((g) => g.id));
  const bySlice = st.slices
    .filter((s) => ids.has(s.grp_id) && s.spent_usd)
    .map((s) => ({ label: `S${s.seq} ${s.title}`, usd: s.spent_usd, tokens: s.spent_tokens }))
    .sort((a, b) => b.usd - a.usd);

  const table = (title: string, rows: { label: string; usd: number; tokens: number }[]) => {
    const list = rows.filter((r) => r.usd);
    if (!list.length) return null;
    const top = Math.max(...list.map((r) => r.usd));
    return (
      <div key={title}>
        <H3>{title}</H3>
        <Table min="20rem">
          <TBody>
            {list.map((r) => (
              <TR key={r.label}>
                <TD className="max-w-[20rem] truncate text-[0.75rem]">{r.label}</TD>
                <TD className="w-2/5"><Bar frac={r.usd / top} /></TD>
                <TD num><span className="text-ink-3">{K(r.tokens)}</span></TD>
                <TD num>{money(r.usd)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </div>
    );
  };

  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <b className="font-display text-[1.75rem] font-semibold">{money(cost.total.usd)}</b>
        <Meta>{K(cost.total.tokens)} tokens</Meta>
        {/* A cache ratio that drops is the only visible sign that prompt assembly
            broke: agents keep working, tests keep passing, turns cost 3-5x. */}
        <Tip label="注入的 delta 必须留在最后一条 user message 末尾。这个数掉下来说明 prompt 组装被改坏了 —— 功能全正常，成本翻 3-5 倍。">
          <Meta className="underline decoration-dotted">
            cache 命中 {cost.cacheRatio == null ? "还没数据" : `${Math.round(cost.cacheRatio * 100)}%`}
          </Meta>
        </Tip>
      </div>
      {table("按需求", cost.byGroup)}
      {table("按切片", bySlice)}
      {table("按角色", cost.byRole)}
      {table("按难度", cost.byDifficulty)}
    </>
  );
}
