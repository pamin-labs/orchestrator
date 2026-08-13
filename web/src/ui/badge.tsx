import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils";

/** shadcn's badge, on our tokens. `mine` is the accent one: it means "needs you". */
export const badgeStyles = cva("inline-block rounded-sm px-1.5 py-px font-mono text-[0.625rem] tracking-[0.06em]", {
  variants: {
    tone: {
      muted: "bg-sunk text-ink-2",
      mine: "bg-accent-soft font-semibold text-accent",
      live: "bg-sunk text-ok",
      bad: "bg-sunk text-bad",
      warn: "bg-sunk text-warn",
    },
  },
  defaultVariants: { tone: "muted" },
});

export function Badge({ className, tone, ...rest }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeStyles>) {
  return <span className={cn(badgeStyles({ tone }), className)} {...rest} />;
}
