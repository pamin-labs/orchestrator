import { Fragment } from "react";
import { useLingui } from "@lingui/react/macro";
import { R, type RingInput, ringView, staleMark } from "./model";
import type { Usage } from "../../shared/api";
import { cn } from "../../ui/cn";
import { Tip } from "../../ui/tooltip";

/**
 * How much of each subscription is left, in the header.
 *
 * A deliberate exception to the rule the header keeps: it carries what the boss
 * acts on, and spend went to 成本 because it is merely true. This is not that. Work
 * runs overnight against two accounts, and "the weekly window is at 90%" is the one
 * usage fact that changes what you start next.
 */
/**
 * One number per account, not four. The first version put both windows inline with a
 * meter between each label and its percentage — eleven elements of chrome to say
 * one thing. The number that matters is whichever window is closest to full,
 * because that is the one that will stop the work; the other is a hover away.
 */
export function UsageBar({ usage }: { usage: Usage[] }) {
  // No window and no error means an account with nothing to run out of — API-key
  // billing — and it gets no bar rather than an empty one.
  const rows = usage.filter((u) => u.fiveHourPercent !== undefined || u.weeklyPercent !== undefined || u.error);
  if (!rows.length) return null;

  // One row per account, two rings per row, each ring carrying its own label and
  // its own tooltip. The tooltip used to hang off the row, and a row is
  // `display: contents` — no box, so Radix had nothing to position against and
  // put the card at the far edge of the screen.
  return (
    <span className="grid grid-cols-[auto_auto_auto] items-center gap-x-4 gap-y-0.5 font-mono text-pill">
      {rows.map((usage) => (
        <UsageRow key={usage.runtime} usage={usage} />
      ))}
    </span>
  );
}

/** One window's ring inputs: its reading and its reset, each only when it exists. */
export function windowRing(u: Usage, w: "five" | "week"): { v?: number; at?: number } {
  const v = w === "five" ? u.fiveHourPercent : u.weeklyPercent;
  const at = w === "five" ? u.resetsAt : u.weeklyResetsAt;
  return { ...(v !== undefined ? { v } : {}), ...(at !== undefined ? { at } : {}) };
}

function UsageRow({ usage }: { usage: Usage }) {
  const { t } = useLingui();
  const shared = {
    read: usage.at,
    stale: staleMark(usage),
    ...(usage.error !== undefined ? { why: usage.error } : {}),
  };
  return (
    <Fragment>
      <span className="truncate text-right text-ink-3">{usage.runtime}</span>
      <Ring label="5h" {...windowRing(usage, "five")} {...shared} />
      <Ring label={t`Week`} {...windowRing(usage, "week")} {...shared} />
    </Fragment>
  );
}

/**
 * One window, as a ring.
 *
 * Hand-drawn rather than charted: at 15px a chart library renders the same two
 * arcs through a layout engine, a container observer and a tooltip portal, and
 * this needs none of them.
 */
function Ring({ label, ...input }: RingInput & { label: string }) {
  const view = ringView(input);
  if (!view) return <span aria-hidden />;
  return (
    <Tip label={view.tip}>
      <span className="flex cursor-default items-center gap-1.5">
        <svg viewBox="0 0 14 14" className="size-[15px] shrink-0 -rotate-90">
          <circle cx="7" cy="7" r={R} fill="none" stroke="var(--color-sunk)" strokeWidth="2.5" />
          {view.arc && (
            <circle
              cx="7"
              cy="7"
              r={R}
              fill="none"
              stroke={view.hot ? "var(--color-warn)" : "var(--color-ink-3)"}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={view.arc}
            />
          )}
        </svg>
        {/* The ring carries the quantity and the tooltip carries the digits. A
            percentage beside its own ring is the same fact twice, and it was the
            widest thing in the bar. */}
        <span className={cn(view.hot ? "font-semibold text-warn" : "text-ink-3")}>{view.arc ? label : "?"}</span>
      </span>
    </Tip>
  );
}
