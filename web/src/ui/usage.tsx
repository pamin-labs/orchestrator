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

/** Both windows, for the hover. */
function detail(u: Usage): string {
  const parts: string[] = [];
  if (u.fiveHourPercent !== undefined) {
    parts.push(`5 小时窗口 ${Math.round(u.fiveHourPercent)}%${u.resetsAt ? `，${until(u.resetsAt)} 后重置` : ""}`);
  }
  if (u.weeklyPercent !== undefined) {
    parts.push(`周窗口 ${Math.round(u.weeklyPercent)}%${u.weeklyResetsAt ? `，${until(u.weeklyResetsAt)} 后重置` : ""}`);
  }
  if (u.error) parts.push(WHY[u.error] ?? u.error);
  return parts.join("\n");
}

export function UsageBar({ usage }: { usage: Usage[] }) {
  // No window and no error means an account with nothing to run out of — API-key
  // billing — and it gets no bar rather than an empty one.
  const rows = usage.filter(
    (u) => u.fiveHourPercent !== undefined || u.weeklyPercent !== undefined || u.error,
  );
  if (!rows.length) return null;

  // A small table, aligned by window rather than by account: the question is
  // never "how is claude doing" on its own, it is "which pool runs out first",
  // and that is a comparison down a column. Rings were the other candidate and
  // lose here — an arc at this size is read by angle, which nobody can compare
  // across two rings 20px apart, while two bars on a shared left edge compare
  // themselves.
  return (
    <span className="grid grid-cols-[auto_auto_auto] items-center gap-x-2.5 gap-y-0.5 font-mono text-[0.625rem]">
      <span />
      <span className="text-center text-ink-3">5h</span>
      <span className="text-center text-ink-3">周</span>
      {rows.map((u) => (
        <Tip key={u.runtime} label={detail(u) || u.runtime}>
          <span className="contents cursor-default">
            <span className="text-ink-3">{u.runtime}</span>
            <Cell v={u.fiveHourPercent} stale={staleMark(u)} />
            <Cell v={u.weeklyPercent} stale={staleMark(u)} />
          </span>
        </Tip>
      ))}
    </span>
  );
}

/** A reading only becomes news once it is too old to trust. */
const staleMark = (u: Usage) => !!u.error && Date.now() - u.at > STALE_MS;

function Cell({ v, stale }: { v?: number; stale: boolean }) {
  // An account with no such window gets a dash, not a zero: "this pool does not
  // exist here" and "this pool is untouched" are different facts.
  if (v === undefined) return <span className="text-center text-ink-3">{stale ? "?" : "—"}</span>;
  const hot = v >= WARN_AT;
  return (
    <span className="flex items-center gap-1">
      <span className="relative h-1 w-9 overflow-hidden rounded-full bg-sunk">
        <span
          className={cn("absolute inset-y-0 left-0 rounded-full", hot ? "bg-warn" : "bg-ink-3")}
          style={{ width: `${Math.min(100, Math.max(2, v))}%` }}
        />
      </span>
      <span className={cn("w-7 text-right tabular-nums", hot ? "font-semibold text-warn" : "text-ink-2")}>
        {Math.round(v)}%{stale ? "?" : ""}
      </span>
    </span>
  );
}
