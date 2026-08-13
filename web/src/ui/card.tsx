import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils";

/**
 * A bordered surface, in the three tones this panel has.
 *
 * `mine` is the accent one and means "needs you" — the same rule the accent
 * follows everywhere else. `alarm` is for a wall the boss has to clear.
 */
export const cardStyles = cva("rounded-xl border", {
  variants: {
    tone: {
      default: "border-rule bg-paper",
      sunk: "border-rule bg-rail/60",
      mine: "border-accent bg-accent-soft shadow-[0_1px_2px_var(--shade)]",
    },
  },
  defaultVariants: { tone: "default" },
});

type Div = React.HTMLAttributes<HTMLDivElement>;

export function Card({ className, tone, ...rest }: Div & VariantProps<typeof cardStyles>) {
  return <div className={cn(cardStyles({ tone }), className)} {...rest} />;
}

/** Header rule included: a header without one is a paragraph in bold. */
export function CardHeader({ className, ...rest }: Div) {
  return <div className={cn("flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rule px-3.5 py-2", className)} {...rest} />;
}

export function CardTitle({ className, ...rest }: Div) {
  return <div className={cn("font-display text-[1.0625rem] font-semibold", className)} {...rest} />;
}

/** Small-caps header, for a strip that labels rows rather than titling a panel. */
export function CardLabel({ className, ...rest }: Div) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3.5 py-2 text-[0.625rem] font-semibold uppercase tracking-[0.13em]",
        className,
      )}
      {...rest}
    />
  );
}

export function CardBody({ className, ...rest }: Div) {
  return <div className={cn("px-3.5 py-3", className)} {...rest} />;
}

export function CardFooter({ className, ...rest }: Div) {
  return <div className={cn("flex flex-wrap items-center gap-2 border-t border-rule-soft px-3.5 py-2", className)} {...rest} />;
}

/** A rule-separated row inside a card. First one carries no rule. */
export function CardRow({ className, ...rest }: Div) {
  return <div className={cn("border-t border-rule-soft px-3.5 py-3 first:border-t-0", className)} {...rest} />;
}
