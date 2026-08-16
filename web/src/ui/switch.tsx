import * as S from "@radix-ui/react-switch";
import { cn } from "../lib/utils";

/**
 * On or off, applied the moment it moves.
 *
 * A switch rather than a checkbox because nothing here is submitted: a checkbox
 * promises a form and an OK button, and this pane has neither. Radix rather than
 * a styled `<div>` (CLAUDE.md 硬约束 4) — the thumb is ours, the `role="switch"`,
 * the space and enter keys, the focus ring and the disabled semantics are not
 * things to reinvent per settings row.
 *
 * The label is the caller's, and it should be a `<label htmlFor>` pointing at
 * `id`: the whole surface being clickable is what makes a 20px target usable.
 */
export function Switch({
  id,
  checked,
  onCheckedChange,
  disabled,
  ...rest
}: {
  id?: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  /** For the rows whose name is a `FieldTitle` rather than a `<label htmlFor>`. */
  "aria-labelledby"?: string;
}) {
  return (
    <S.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      {...rest}
      className={cn(
        "relative h-4 w-7 shrink-0 cursor-pointer rounded-full transition-colors",
        "bg-rule data-[state=checked]:bg-accent",
        // No focus ring of its own. `outline-none` is a utility and the page's one
        // ring is in `@layer base`, so a local ring does not sit beside the global
        // one — it replaces it, and this row alone then says "focused" a different
        // way than every other control in the dialog. DESIGN.md: one focus ring.
        "disabled:cursor-default disabled:opacity-40",
      )}
    >
      <S.Thumb
        className={cn(
          "block size-3 rounded-full bg-paper shadow-sm transition-transform",
          "translate-x-[0.125rem] data-[state=checked]:translate-x-[0.875rem]",
        )}
      />
    </S.Root>
  );
}
