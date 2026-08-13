import { Fragment } from "react";
import type { Usage } from "../lib/api";
import { cn } from "../lib/utils";
import { Tip } from "./tooltip";

/**
 * How much of each subscription is left, in the header.
 *
 * A deliberate exception to the rule the header keeps: it carries what the boss
 * acts on, and spend went to 成本 because it is merely true. This is not that.
 * Work runs overnight against two accounts, and "the weekly window is at 90%" is
 * the one usage fact that changes what you start next.
 *
 * One number per account, not four. The first version put both windows inline
 * with a meter between each label and its percentage — `claude 5h ▬ 8% 周 ▬ 66%
 * codex 周 0%` — which is eleven elements of chrome to say one thing. The number
 * that matters is whichever window is closest to full, because that is the one
 * that will stop the work; the other is a hover away.
 */

const WARN_AT = 80;

/**
 * How old a reading may be before the failure behind it is worth showing.
 *
 * A failed read is not news: the last one is minutes old and these windows move
 * in hours, so the honest thing is to keep showing it and say nothing. It only
 * becomes the boss's problem when the number on screen is old enough to be wrong,
 * and an hour is well inside a five-hour window.
 */
const STALE_MS = 60 * 60_000;

const WHY: Record<string, string> = {
  rate_limited: "读用量被限流了，过一会自己恢复",
  unreachable: "连不上用量接口",
  no_windows: "这个账号没有窗口",
};

/** "3h12m" / "2天4h". A reset three days out is not worth a minute count. */
function until(unixSecs?: number): string {
  if (!unixSecs) return "";
  const ms = unixSecs * 1000 - Date.now();
  if (ms <= 0) return "即将重置";
  const min = Math.floor(ms / 60_000);
  const h = Math.floor(min / 60);
  const d = Math.floor(h / 24);
  if (d >= 1) return `${d}天${h % 24}h`;
  return h >= 1 ? `${h}h${min % 60}m` : `${min}m`;
}


export function UsageBar({ usage }: { usage: Usage[] }) {
  // No window and no error means an account with nothing to run out of — API-key
  // billing — and it gets no bar rather than an empty one.
  const rows = usage.filter(
    (u) => u.fiveHourPercent !== undefined || u.weeklyPercent !== undefined || u.error,
  );
  if (!rows.length) return null;

  // One row per account, two rings per row, each ring carrying its own label and
  // its own tooltip. The tooltip used to hang off the row, and a row is
  // `display: contents` — no box, so Radix had nothing to position against and
  // put the card at the far edge of the screen.
  return (
    <span className="grid grid-cols-[auto_auto_auto] items-center gap-x-4 gap-y-0.5 font-mono text-[0.625rem]">
      {rows.map((u) => (
        <Fragment key={u.runtime}>
          <span className="truncate text-right text-ink-3">{u.runtime}</span>
          <Ring label="5h" v={u.fiveHourPercent} at={u.resetsAt} stale={staleMark(u)} why={u.error} />
          <Ring label="周" v={u.weeklyPercent} at={u.weeklyResetsAt} stale={staleMark(u)} why={u.error} />
        </Fragment>
      ))}
    </span>
  );
}

/** A reading only becomes news once it is too old to trust. */
const staleMark = (u: Usage) => !!u.error && Date.now() - u.at > STALE_MS;

const R = 5.5;
const C = 2 * Math.PI * R;

/**
 * One window, as a ring.
 *
 * Hand-drawn rather than charted: at 15px a chart library renders the same two
 * arcs through a layout engine, a container observer and a tooltip portal, and
 * this needs none of them.
 */
function Ring({
  label, v, at, stale, why,
}: {
  label: string; v?: number; at?: number; stale: boolean; why?: string;
}) {
  const known = v !== undefined;
  // An account without this window holds the column open and says nothing in it.
  // An empty ring plus a dash was two marks claiming the reading failed, when the
  // truth is the window does not exist on that plan.
  if (!known && !stale) return <span aria-hidden />;
  const hot = known && v >= WARN_AT;
  // Terse: a number and when it resets. The sentence it replaced said "5 小时窗口"
  // next to a ring already labelled 5h, and repeated the failure text under every
  // window it had already been shown for.
  const label2 = known ? `${Math.round(v)}%${at ? ` · ${until(at)}后重置` : ""}` : (WHY[why ?? ""] ?? "读不到");
  return (
    <Tip label={label2}>
      <span className="flex cursor-default items-center gap-1.5">
        <svg viewBox="0 0 14 14" className="size-[15px] shrink-0 -rotate-90">
          <circle cx="7" cy="7" r={R} fill="none" stroke="var(--color-sunk)" strokeWidth="2.5" />
          {known && (
            <circle
              cx="7"
              cy="7"
              r={R}
              fill="none"
              stroke={hot ? "var(--color-warn)" : "var(--color-ink-3)"}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={`${(Math.min(100, Math.max(2, v)) / 100) * C} ${C}`}
            />
          )}
        </svg>
        {/* The ring carries the quantity and the tooltip carries the digits. A
            percentage beside its own ring is the same fact twice, and it was the
            widest thing in the bar. */}
        <span className={cn(hot ? "font-semibold text-warn" : "text-ink-3")}>{known ? label : "?"}</span>
      </span>
    </Tip>
  );
}
