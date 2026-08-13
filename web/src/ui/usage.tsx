import type { Usage } from "../lib/api";
import { cn } from "../lib/utils";
import { Tip } from "./tooltip";

/**
 * How much of each subscription is left, in the header.
 *
 * A deliberate exception to the rule above it: the bar carries what the boss acts
 * on, and total spend was moved to 成本 because it is merely true. This is not
 * that. Work runs overnight against two accounts, and "the weekly window is at
 * 90%" is the one usage fact that changes what you start next — which requirement
 * to approve, which model tier to tag it, whether to wait for the reset.
 *
 * Quiet until it matters: grey text at a glance, a filled bar and a warn colour
 * only past 80%. Two providers, side by side, because the whole point of running
 * both is that one being spent does not stop the other.
 */

const WARN_AT = 80;

const pct = (n?: number) => (n === undefined ? null : Math.round(n));

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

function Window({ label, value, resetsAt }: { label: string; value?: number; resetsAt?: number }) {
  const p = pct(value);
  if (p === null) return null;
  const hot = p >= WARN_AT;
  return (
    <Tip label={resetsAt ? `${label}窗口用了 ${p}%，${until(resetsAt)} 后重置` : `${label}窗口用了 ${p}%`}>
      <span className={cn("flex items-center gap-1", hot && "text-warn")}>
        {label}
        <span className="relative h-1 w-6 overflow-hidden rounded-full bg-sunk">
          <span
            className={cn("absolute inset-y-0 left-0 rounded-full", hot ? "bg-warn" : "bg-ink-3")}
            style={{ width: `${Math.min(100, p)}%` }}
          />
        </span>
        {p}%
      </span>
    </Tip>
  );
}

const WHY: Record<string, string> = {
  rate_limited: "读用量被限流了，过一会自己恢复",
  unreachable: "连不上用量接口",
  no_windows: "这个账号没有窗口",
};

export function UsageBar({ usage }: { usage: Usage[] }) {
  // A row with neither a percentage nor an error is an account with no windows to
  // report: API-key billing has nothing to run out of, so it gets no bar rather
  // than an empty one.
  const rows = usage.filter(
    (u) => u.fiveHourPercent !== undefined || u.weeklyPercent !== undefined || u.error,
  );
  if (!rows.length) return null;
  return (
    <span className="flex items-center gap-3 font-mono text-[0.6875rem] text-ink-3">
      {rows.map((u) => (
        <span key={u.runtime} className="flex items-center gap-1.5">
          <span className="text-ink-3">{u.runtime}</span>
          <Window label="5h" value={u.fiveHourPercent} resetsAt={u.resetsAt} />
          <Window label="周" value={u.weeklyPercent} resetsAt={u.weeklyResetsAt} />
          {/* Said out loud, not by going blank. A bar that quietly disappears
              reads as "fine"; the one thing it must never do is imply headroom
              nobody checked. Stale numbers stay beside it, dimmed by the ？. */}
          {u.error && (
            <Tip label={`${WHY[u.error] ?? u.error}${lastRead(u)}`}>
              <span className="cursor-default text-warn underline decoration-dotted">
                {u.fiveHourPercent === undefined && u.weeklyPercent === undefined ? "读不到" : "?"}
              </span>
            </Tip>
          )}
        </span>
      ))}
    </span>
  );
}

/** How old the numbers beside the warning are, if there are any. */
function lastRead(u: Usage): string {
  if (u.fiveHourPercent === undefined && u.weeklyPercent === undefined) return "";
  const min = Math.round((Date.now() - u.at) / 60_000);
  return `。旁边是 ${min < 1 ? "刚才" : `${min} 分钟前`}读到的数`;
}
