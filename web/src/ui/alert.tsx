import { cn } from "./cn";

/**
 * shadcn's alert, on our tokens: a callout for a condition that persists.
 *
 * The distinction from a toast is the one thing this component exists to hold.
 * A toast reports an event and leaves; an alert states a condition and stays
 * until the condition does not. A broken host check is the second kind — a host
 * with no Docker still has none in five seconds — so it belongs in the layout,
 * not floating over the board this panel exists to show.
 */
/**
 * `AlertAction` is absolutely positioned in shadcn's own version. Here it is a
 * grid cell instead: the row is one line tall, so an overlay would cover the
 * description at the width where it matters.
 */
/**
 * One tone, not a `cva`. It shipped with `bad` and `warn` and a
 * `defaultVariants`; the one caller renders it with no `tone` at all, so the
 * variant map and the dependency on `class-variance-authority` were describing a
 * choice nothing makes. A second tone can bring the `cva` back with it.
 */
const ALERT =
  "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 border-b border-bad/25 bg-bad-soft px-6 py-2 text-body text-ink";

export function Alert({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div role="alert" className={cn(ALERT, className)} {...rest} />;
}

export function AlertTitle({ className, ...rest }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("font-medium", className)} {...rest} />;
}

/** One line, and `truncate` rather than wrap: the row must not change height. */
export function AlertDescription({ className, ...rest }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("min-w-0 truncate text-ink-2", className)} {...rest} />;
}

export function AlertAction({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex shrink-0 items-center gap-1", className)} {...rest} />;
}
