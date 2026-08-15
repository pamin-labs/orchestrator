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
export function Switch({ id, checked, onCheckedChange, disabled }: {
  id?: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <S.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className={cn(
        "relative h-4 w-7 shrink-0 cursor-pointer rounded-full transition-colors",
        "bg-rule data-[state=checked]:bg-accent",
        "outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
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
