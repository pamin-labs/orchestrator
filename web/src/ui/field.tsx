import { cn } from "./cn";

/**
 * shadcn's Field family, on our tokens.
 *
 * A settings page is a list of label-and-value pairs, and the hand-rolled
 * version of that is a grid of `<span>` and `<input>` — which looks right and is
 * not: the label is not associated with the control, so clicking it does not
 * focus and a screen reader reads two unrelated things. 硬约束 4, one more time.
 *
 * `horizontal` is the shape this project wants: a fixed label column, values
 * aligned down the page, a hairline between rows. `vertical` exists for the one
 * case where a value is a block (a pasted auth.json) rather than a line.
 *
 * Deliberately not shadcn's own styling. The look is ours (docs/design/ui.md): hairlines
 * rather than cards, `sunk` for machine output, the accent reserved for what
 * waits on the boss.
 */

export function FieldGroup({ className, ...rest }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="field-group"
      // A hairline means "next row" and nothing else, so the group draws them
      // between its rows and no frame around itself. Its own top rule used to be
      // the same token as the rule that opened the section above it, which is
      // how a settings pane became four boundaries of equal weight with no way
      // to tell a section from a row. Sections are separated by space now.
      className={cn("flex w-full flex-col divide-y divide-rule-soft", className)}
      {...rest}
    />
  );
}

export function Field({
  orientation = "horizontal",
  className,
  ...rest
}: React.ComponentProps<"div"> & { orientation?: "horizontal" | "vertical" }) {
  return (
    <div
      role="group"
      data-slot="field"
      data-orientation={orientation}
      className={cn(
        // No rule of its own: the group divides its children, so a row rendered
        // last has no dangling edge and a row rendered conditionally cannot leave
        // one behind.
        "group/field gap-x-4 py-2",
        // The label column is a variable so a narrower context — two settings
        // blocks side by side — can tighten it without a second Field.
        orientation === "horizontal"
          ? "grid grid-cols-[var(--label,10rem)_minmax(0,1fr)] items-baseline"
          : "flex flex-col gap-y-1.5",
        // A value the boss has to act on, said by the label's ink rather than by
        // a badge next to it. The control that holds the bad value marks itself
        // (`aria-invalid`), because a row can carry four of them and the row-wide
        // rule would light all four.
        "data-[invalid=true]:[&_[data-slot=field-label]]:text-accent",
        className,
      )}
      {...rest}
    />
  );
}

export function FieldLabel({ className, htmlFor, ...rest }: React.ComponentProps<"label"> & { htmlFor: string }) {
  return (
    <label
      htmlFor={htmlFor}
      data-slot="field-label"
      className={cn("flex items-baseline gap-2 text-[0.8125rem] text-ink", className)}
      {...rest}
    />
  );
}

/** For a row whose label names a fact rather than a control. */
export function FieldTitle({ className, ...rest }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="field-label"
      className={cn("flex items-baseline gap-2 text-[0.8125rem] text-ink", className)}
      {...rest}
    />
  );
}

/** The value side. Anything wider than one control goes in here. */
export function FieldContent({ className, ...rest }: React.ComponentProps<"div">) {
  return <div data-slot="field-content" className={cn("flex min-w-0 items-center gap-2", className)} {...rest} />;
}

/**
 * A control with something attached to it — the button that saves it, usually.
 *
 * shadcn's InputGroup encloses them in one bordered shell; ours sits them side
 * by side, because a second border around a field that already has one is the
 * two-boxes-around-one-thing rule.
 */
export function InputGroup({ className, ...rest }: React.ComponentProps<"div">) {
  return <div data-slot="input-group" className={cn("flex min-w-0 flex-1 items-center gap-2", className)} {...rest} />;
}
