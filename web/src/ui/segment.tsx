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
      className={cn("flex items-center gap-0.5", className)}
    >
      {children}
    </TG.Root>
  );
}

/**
 * Quiet by default, filled when chosen. It was an enclosed strip with a black
 * pressed item and a size on every label — four bordered boxes and four numbers
 * to say which of four panes is open, louder than the evidence it switches
 * between. The pressed item carries the state; nothing else has to.
 */
export function Segment({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <TG.Item
      value={value}
      className={cn(
        "cursor-pointer rounded-md px-2 py-0.5 font-mono text-[0.75rem]",
        "text-ink-3 transition-colors hover:text-ink",
        "data-[state=on]:bg-sunk data-[state=on]:font-medium data-[state=on]:text-ink",
      )}
    >
      {children}
    </TG.Item>
  );
}

/**
 * Several of a kind, any number pressed.
 *
 * The same primitive as `Segments` with `type="multiple"`, which is what a list
 * of gates is: pick the ones that run. A checkbox would want a new dependency,
 * and `aria-pressed` on a toggle says the same thing to a screen reader as a
 * checked box does.
 */
export function Toggles({
  value, onValueChange, className, children,
}: {
  value: string[];
  onValueChange: (v: string[]) => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <TG.Root type="multiple" value={value} onValueChange={onValueChange} className={cn("block", className)}>
      {children}
    </TG.Root>
  );
}

/**
 * A full-width row rather than a pill: these carry a second column.
 *
 * Rest props are forwarded because the gate list makes these rows draggable, and
 * `draggable` plus the drag handlers belong on the element the pointer is on.
 */
export function Toggle({
  value, className, children, ...rest
}: React.ComponentProps<typeof TG.Item> & { value: string }) {
  return (
    <TG.Item
      value={value}
      className={cn(
        "flex w-full cursor-pointer items-baseline gap-3 border-b border-rule-soft px-2 py-2 text-left",
        "text-ink-3 transition-colors hover:bg-rail data-[state=on]:text-ink",
        className,
      )}
      {...rest}
    >
      {children}
    </TG.Item>
  );
}
