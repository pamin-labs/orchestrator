import * as TG from "@radix-ui/react-toggle-group";
import { cn } from "../lib/utils";

/**
 * One of several, chosen — where a tab strip would be the second one on the page.
 *
 * The evidence panel needs exactly what tabs do: pick a view, show one at a time.
 * But it sits inside a page that already has tabs, and a tab strip under a tab
 * strip stops reading as navigation — the eye cannot tell which level it is on.
 * Radix's ToggleGroup is the same behaviour at a different rank: roving focus,
 * arrow keys, one pressed item, `aria-pressed` rather than `role="tab"`. Smaller,
 * enclosed, obviously subordinate.
 *
 * Never build this by hand (CLAUDE.md 硬约束 4). Written once by hand it has no
 * arrow keys and no pressed state for a screen reader, and that is exactly the
 * kind of thing nobody notices is missing.
 */
export function Segments({
  value, onValueChange, className, children,
}: {
  value: string;
  onValueChange: (v: string) => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <TG.Root
      type="single"
      value={value}
      // A toggle group can be empty; this one is a selector, so refuse to unpress.
      onValueChange={(v) => v && onValueChange(v)}
      className={cn("flex overflow-hidden rounded-md border border-rule", className)}
    >
      {children}
    </TG.Root>
  );
}

export function Segment({
  value, children, count,
}: {
  value: string;
  children: React.ReactNode;
  /** A size or a tally, kept quiet: it qualifies the label, it is not the label. */
  count?: string;
}) {
  return (
    <TG.Item
      value={value}
      className={cn(
        "flex cursor-pointer items-baseline gap-1.5 border-r border-rule px-2.5 py-1 text-[0.75rem] last:border-r-0",
        "text-ink-3 transition-colors hover:bg-sunk hover:text-ink",
        "data-[state=on]:bg-ink data-[state=on]:text-paper data-[state=on]:hover:bg-ink",
      )}
    >
      {children}
      {count && <span className="font-mono text-[0.625rem] opacity-70">{count}</span>}
    </TG.Item>
  );
}
