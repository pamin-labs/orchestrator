import { Empty, H2, Meta } from "../ui/bits";
import type { Cost, State } from "../lib/api";
import { STATUS_ZH, owns } from "../lib/select";
import { cn, K, money } from "../lib/utils";

const Th = ({ children, num }: { children?: React.ReactNode; num?: boolean }) => (
  <th className={cn(
    "border-b border-rule pb-1.5 pr-3 text-[0.6875rem] font-medium uppercase tracking-[0.07em] text-ink-3",
    num ? "pr-0 text-right" : "text-left",
  )}>{children}</th>
);
const Td = ({ children, num, className }: { children?: React.ReactNode; num?: boolean; className?: string }) => (
  <td className={cn(
    "border-b border-rule-soft py-1.5 pr-3 align-top",
    num && "pr-0 text-right font-mono text-[0.75rem]",
    className,
  )}>{children}</td>
);

/** Per PLAN.md §8: current slice, what tool is running, model, clearance, spend. */
export function Desk({ st, projectId }: { st: State; projectId: number }) {
  const ids = new Set(st.groups.filter((g) => g.project_id === projectId).map((g) => g.id));
  const rows = st.agents.filter((a) => !a.grp_id || ids.has(a.grp_id));
  if (!rows.length) return <Empty>无活动 agent</Empty>;
  return (
    <table className="w-full border-collapse text-[0.8125rem]">
      <thead><tr>
        <Th>角色</Th><Th>需求</Th><Th>当前动作</Th><Th>model</Th><Th>权限</Th>
        <Th num>session token</Th><Th num>支出</Th>
      </tr></thead>
      <tbody>
        {rows.map((a) => (
          <tr key={a.id}>
            <Td className="font-mono text-[0.75rem]">
              {a.role}
              {a.state === "running" && <span className="ml-1.5 font-sans text-[0.625rem] text-ok">在跑</span>}
            </Td>
            <Td className="text-[0.75rem] text-ink-2">
              {st.groups.find((g) => g.id === a.grp_id)?.name ?? "常驻"}
            </Td>
            <Td className="max-w-[22rem] truncate text-[0.75rem] text-ink-2">{a.activity ?? a.state}</Td>
            <Td><Meta>{a.model.replace("claude-", "")}</Meta></Td>
            <Td><Meta>{a.clearance}</Meta></Td>
            <Td num><span className="text-ink-3">{K(a.session_tokens)}</span></Td>
            <Td num>{money(a.total_usd)}</Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Overlap is what this view exists for: two groups owning one path is the thing
    file ownership prevents, so it gets named rather than implied. */
export function Owns({ st, projectId }: { st: State; projectId: number }) {
  const gs = st.groups.filter((g) => g.project_id === projectId && owns(g).length);
  if (!gs.length) return <Empty>暂无边界划分。开工前由 Architect 划定，防止两个需求改同一批文件。</Empty>;
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
      <table className="w-full border-collapse text-[0.8125rem]">
        <thead><tr><Th>需求</Th><Th>owns</Th><Th>状态</Th></tr></thead>
        <tbody>
          {gs.map((g) => (
            <tr key={g.id}>
              <Td>{g.name}</Td>
              <Td><Meta>{owns(g).map((o) => <div key={o}>{o}</div>)}</Meta></Td>
              <Td className="text-[0.75rem] text-ink-3">{STATUS_ZH[g.status] ?? g.status}</Td>
            </tr>
          ))}
        </tbody>
      </table>
      {pairs.length ? (
        <>
          <h3 className="mt-8 mb-2.5 font-display text-[1rem] font-semibold text-bad">路径重叠，禁止并行</h3>
          {pairs.map(([a, b, hit]) => (
            <div key={a + b} className="text-[0.75rem] text-bad">
              {a} 和 {b}：<span className="font-mono">{hit.join(" ")}</span>
            </div>
          ))}
        </>
      ) : (
        <>
          <h3 className="mt-8 mb-2.5 font-display text-[1rem] font-semibold">无重叠</h3>
          <Empty>路径两两不相交，可并行开工。</Empty>
        </>
      )}
    </>
  );
}

/** Per PLAN.md §8: by requirement, slice, role and difficulty, plus cache hit rate. */
export function CostView({ st, cost, projectId }: { st: State; cost: Cost | null; projectId: number }) {
  if (!cost?.total?.usd) return <Empty>暂无支出。</Empty>;
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
        <h3 className="mt-8 mb-2.5 font-display text-[1rem] font-semibold">{title}</h3>
        <table className="w-full border-collapse text-[0.8125rem]">
          <tbody>
            {list.map((r) => (
              <tr key={r.label}>
                <Td className="max-w-[20rem] truncate text-[0.75rem]">{r.label}</Td>
                <Td className="w-2/5">
                  <span className="block h-1 min-w-12 rounded-sm bg-rule">
                    <i className="block h-full rounded-sm bg-ink-3" style={{ width: `${Math.max(2, (r.usd / top) * 100)}%` }} />
                  </span>
                </Td>
                <Td num><span className="text-ink-3">{K(r.tokens)}</span></Td>
                <Td num>{money(r.usd)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <>
      <div className="flex items-baseline gap-6">
        <b className="font-display text-[1.75rem] font-semibold">{money(cost.total.usd)}</b>
        <Meta>{K(cost.total.tokens)} tokens</Meta>
        {/* A cache ratio that drops is the only visible sign that prompt assembly
            broke: agents keep working, tests keep passing, turns cost 3-5x. */}
        <Meta>cache 命中 {cost.cacheRatio == null ? "还没数据" : `${Math.round(cost.cacheRatio * 100)}%`}</Meta>
      </div>
      {table("按需求", cost.byGroup)}
      {table("按切片", bySlice)}
      {table("按角色", cost.byRole)}
      {table("按难度", cost.byDifficulty)}
    </>
  );
}
