import { Area, AreaChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { K } from "../lib/utils";

/**
 * The two charts 成本 earns, and nothing else.
 *
 * A chart has to answer something a sorted list cannot. Two things here do: how
 * fast it is burning right now, which is a shape over time, and how a whole
 * splits when there are only two or three parts, which the eye reads faster as an
 * arc than as three numbers it has to divide. The ranked lists stay lists —
 * exact, comparable, and openable.
 *
 * Colours come from the token set as `var(--color-…)`, so both charts follow the
 * theme switch with no JS. The accent is never used: DESIGN.md reserves it for
 * "needs you", and a chart that borrows it teaches the eye to ignore it.
 */

const AXIS = { stroke: "var(--color-ink-3)", fontSize: 10, fontFamily: "var(--font-mono)" };

const CARD =
  "rounded-md border border-rule bg-paper px-2 py-1 font-mono text-[0.6875rem] text-ink shadow-[0_6px_20px_var(--shade)]";

/** Hourly burn, stacked by which subscription paid for it. */
export function BurnChart({ data }: { data: { hour: string; claude: number; codex: number }[] }) {
  if (data.length < 2) {
    return <div className="py-4 text-[0.75rem] text-ink-3">还不够两个小时的数据。</div>;
  }
  return (
    <div className="h-[8.5rem]">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <XAxis
            dataKey="hour"
            {...AXIS}
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
            minTickGap={28}
            // "08-13 20" is a date this reader already knows; the hour is the part
            // that locates a spike.
            tickFormatter={(v: string) => v.slice(-2)}
          />
          <YAxis {...AXIS} tickLine={false} axisLine={false} width={34} tickFormatter={(v: number) => K(v)} />
          <Tooltip
            cursor={{ stroke: "var(--color-rule)" }}
            wrapperClassName="!outline-none"
            contentStyle={{ all: "unset" }}
            content={({ active, payload, label }) =>
              active && payload?.length ? (
                <div className={CARD}>
                  <div className="text-ink-3">{label}</div>
                  {payload.map((s) => (
                    <div key={s.name}>
                      {s.name} {K(Number(s.value))}
                    </div>
                  ))}
                </div>
              ) : null
            }
          />
          {/* Two flat fills, no gradient: the question is which is larger, and a
              fade to transparent makes the bottom band look like it is ending. */}
          <Area
            type="monotone"
            dataKey="claude"
            stackId="1"
            stroke="var(--color-ink-2)"
            fill="var(--color-ink-2)"
            fillOpacity={0.55}
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="codex"
            stackId="1"
            stroke="var(--color-ink-3)"
            fill="var(--color-ink-3)"
            fillOpacity={0.3}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Monochrome ramp: these are parts of one quantity, not different kinds of thing. */
const RAMP = ["var(--color-ink)", "var(--color-ink-2)", "var(--color-ink-3)", "var(--color-rule)"];

/**
 * A whole and its two or three parts, with the numbers beside it.
 *
 * The arc carries the proportion, the legend carries the exact figure. Neither
 * alone is enough: a ring you have to hover is a quiz, and three raw numbers make
 * the reader do the division.
 */
export function SplitDonut({ rows }: { rows: { label: string; tokens: number }[] }) {
  const list = rows.filter((r) => r.tokens).sort((a, b) => b.tokens - a.tokens);
  if (!list.length) return null;
  const sum = list.reduce((n, r) => n + r.tokens, 0);
  return (
    <div className="flex items-center gap-3">
      <div className="h-[4.5rem] w-[4.5rem] shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={list}
              dataKey="tokens"
              nameKey="label"
              innerRadius="62%"
              outerRadius="100%"
              paddingAngle={list.length > 1 ? 2 : 0}
              stroke="none"
              isAnimationActive={false}
            >
              {list.map((r, i) => (
                <Cell key={r.label} fill={RAMP[i % RAMP.length]} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="min-w-0 grow">
        {list.map((r, i) => (
          <div key={r.label} className="flex items-baseline gap-1.5 py-px text-[0.6875rem]">
            <i className="size-1.5 shrink-0 rounded-[1px]" style={{ background: RAMP[i % RAMP.length] }} />
            <span className="min-w-0 truncate text-ink-2">{r.label}</span>
            <span className="grow" />
            <span className="font-mono text-ink">{K(r.tokens)}</span>
            <span className="w-7 text-right font-mono text-ink-3">{Math.round((r.tokens / sum) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
