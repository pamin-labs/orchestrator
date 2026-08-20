import { Tooltip } from "recharts";

/**
 * The two things every chart on this page shares: its axes' ink, and its hover card.
 *
 * Both were written twice — in 成本's burn chart and in 耗时's trend — and differed
 * only in which formatter they called. That is the whole variation, so it is a
 * parameter and everything else is stated once. Two hover cards drifting apart is
 * the kind of thing nobody notices until the panel has two visual vocabularies.
 */
/**
 * Colours are `var(--color-…)` rather than resolved values, so both charts follow
 * the theme switch with no JavaScript. The accent is deliberately absent:
 * `docs/design/ui.md` reserves it for "needs you", and a chart that borrows it
 * teaches the eye to ignore it.
 */
export const AXIS = { stroke: "var(--color-ink-3)", fontSize: 10, fontFamily: "var(--font-mono)" } as const;

/**
 * The card a hover draws, exported because one chart's tooltip is not a series
 * list at all — 成本's split is a single line with a percentage in it — and that
 * one needs the surface without the contents.
 */
export const CHART_CARD =
  "rounded-md border border-rule bg-paper px-2 py-1 font-mono text-meta text-ink shadow-[0_6px_20px_var(--shade)]";

/**
 * A chart's hover card, in the panel's own type rather than recharts' default.
 *
 * `format` is how the series' numbers are spelled — token counts in one chart,
 * durations in the other — and is the only thing a caller supplies.
 */
export function ChartTooltip({
  format,
  label: labelOf,
  hide,
}: {
  format: (value: number) => string;
  /** What the first line says. Without this it is the axis key, which on a
   *  waterfall is a span id — the least useful thing in the box, in bold. */
  label?: (value: string) => string;
  /** Series that exist to position other series and should not be listed. */
  hide?: (name: string) => boolean;
}) {
  return (
    <Tooltip
      cursor={{ stroke: "var(--color-rule)" }}
      // recharts styles its own container; `all: unset` hands the appearance
      // back to the card below, and the outline suppression stops a focused
      // chart drawing a second frame around it.
      wrapperClassName="!outline-none"
      contentStyle={{ all: "unset" }}
      content={({ active, payload, label }) =>
        active && payload?.length ? (
          <div className={CHART_CARD}>
            <div className="text-ink-3">{labelOf ? labelOf(String(label)) : String(label)}</div>
            {payload
              .filter((series) => !hide?.(String(series.name)))
              .map((series) => (
                <div key={series.name}>
                  {series.name} {format(Number(series.value))}
                </div>
              ))}
          </div>
        ) : null
      }
    />
  );
}
