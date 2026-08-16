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
 * theme switch with no JS. The accent is never used: docs/design/ui.md reserves it for
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

/**
 * A whole and its two or three parts.
 *
 * The ring was right; the colours were not. ink / ink-2 / ink-3 are three steps of
 * one warm near-black, which is legible as text and nearly identical as fill —
 * and when one account carries 99%, the other arc is a few pixels of a grey you
 * cannot tell from its neighbour. The ramp below steps by half the distance to
 * the paper each time, so adjacent segments differ at a glance. Still no hue: the
 * accent belongs to "needs you" and green/red/amber belong to gates, and a chart
 * that borrows either teaches the eye to stop trusting them.
 */
const RAMP = [
  "var(--color-ink)",
  "color-mix(in oklch, var(--color-ink) 52%, var(--color-paper))",
  "color-mix(in oklch, var(--color-ink) 26%, var(--color-paper))",
  "color-mix(in oklch, var(--color-ink) 13%, var(--color-paper))",
];

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
              innerRadius="60%"
              outerRadius="100%"
              paddingAngle={list.length > 1 ? 2 : 0}
              stroke="none"
              isAnimationActive={false}
            >
              {list.map((r, i) => (
                <Cell key={r.label} {...(RAMP[i % RAMP.length] ? { fill: RAMP[i % RAMP.length] } : {})} />
              ))}
            </Pie>
            <Tooltip
              wrapperClassName="!outline-none"
              contentStyle={{ all: "unset" }}
              content={({ active, payload }) =>
                active && payload?.length ? (
                  <div className={CARD}>
                    {payload[0]!.name} {K(Number(payload[0]!.value))} · {pct(Number(payload[0]!.value), sum)}
                  </div>
                ) : null
              }
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="min-w-0 grow">
        {list.map((r, i) => (
          <div key={r.label} className="flex items-baseline gap-2 py-0.5 text-[0.75rem]">
            <i className="size-2 shrink-0 rounded-[2px]" style={{ background: RAMP[i % RAMP.length] }} />
            <span className="min-w-0 truncate text-ink-2">{r.label}</span>
            <span className="grow" />
            <span className="font-mono text-ink">{K(r.tokens)}</span>
            <span className="w-9 text-right font-mono text-ink-3">{pct(r.tokens, sum)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Never rounds a real share to 0%: "<1%" is a different fact from "none". */
function pct(n: number, sum: number): string {
  const p = (n / sum) * 100;
  return p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
}
