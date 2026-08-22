import { cva, type VariantProps } from "class-variance-authority";
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
const alertStyles = cva(
  "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 border-b px-6 py-2 text-body",
  {
    variants: {
      tone: {
        bad: "border-bad/25 bg-bad-soft text-ink",
        warn: "border-warn/25 bg-sunk text-ink",
      },
    },
    defaultVariants: { tone: "bad" },
  },
);

export function Alert({
  className,
  tone,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertStyles>) {
  return <div role="alert" className={cn(alertStyles({ tone }), className)} {...rest} />;
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
