import * as A from "@radix-ui/react-accordion";
import { cn } from "../lib/utils";

/**
 * One row open at a time, the rest one line each.
 *
 * Hand-rolled first (a `<button>` and a boolean) and it was wrong in the ways
 * hand-rolled disclosure is always wrong: no `aria-expanded`/`aria-controls`
 * pair, no arrow-key or Home/End movement between the rows, no `data-state` for
 * the styling to hang off. CLAUDE.md 硬约束 4 — behaviour comes from Radix, the
 * look is ours.
 *
 * `collapsible` because closing the open one is a real thing to want: with three
 * slices the boss reads one and shuts it to see the shape of the rest.
 */
export function Accordion({
  value, onValueChange, className, children,
}: {
  /** `""` = everything shut. */
  value: string;
  onValueChange: (v: string) => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <A.Root type="single" collapsible value={value} onValueChange={onValueChange} className={className}>
      {children}
    </A.Root>
  );
}

export function AccordionItem({ value, className, children }: { value: string; className?: string; children: React.ReactNode }) {
  return (
    <A.Item value={value} className={cn("border-t border-rule-soft first:border-t-0", className)}>
      {children}
    </A.Item>
  );
}

/** The row itself. Whatever is inside is the trigger; `asChild` keeps our markup. */
export function AccordionTrigger({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <A.Header asChild>
      <div>
        <A.Trigger className={cn("group w-full cursor-pointer text-left", className)}>{children}</A.Trigger>
      </div>
    </A.Header>
  );
}

/**
 * The open body, on the open item's own surface.
 *
 * Body and rows were both on paper, so with the last pane collapsed to a sentence
 * the reader could not tell where the open item stopped and the next row began —
 * a 2px rule under it was not enough, because a rule is what separates every row
 * from every other row. `rail` for the whole open block instead: one tinted
 * region with a start and an end, the machine panes inside it recessed further.
 */
export function AccordionBody({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <A.Content className={cn("bg-rail data-[state=open]:border-b data-[state=open]:border-rule", className)}>
      {children}
    </A.Content>
  );
}
