import { cn } from "./cn";

/** A share-of-total bar. The cost view had this inline three times. */
export function Bar({ frac, tone, className }: { frac: number; tone?: "ink" | "warn" | "bad"; className?: string }) {
  return (
    <span className={cn("block h-1 w-full min-w-10 rounded-sm bg-rule", className)}>
      <i
        className={cn("block h-full rounded-sm", tone === "bad" ? "bg-bad" : tone === "warn" ? "bg-warn" : "bg-ink-3")}
        style={{ width: `${Math.max(2, Math.min(1, frac) * 100)}%` }}
      />
    </span>
  );
}
