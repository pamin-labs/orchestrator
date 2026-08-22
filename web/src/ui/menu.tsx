import * as M from "@radix-ui/react-dropdown-menu";
import { ChevronDown } from "lucide-react";
import { buttonStyles } from "./button";
import { cn } from "./cn";

/**
 * shadcn's dropdown menu, on our tokens.
 *
 * For the actions that are rare and consequential. Sitting in a header at the same
 * weight as `Pause` they read as ordinary, and one of them discards a turn's work — so
 * they go behind one click, each with a line saying what it actually does.
 */
export function Menu({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <M.Root>
      {/* `max-w` + truncate: an org name can be far longer than a person's, and a
          trigger that grows pushes whatever sits beside it off the row. */}
      <M.Trigger className={cn(buttonStyles({ variant: "default" }), "max-w-[14rem] cursor-pointer")}>
        <span className="truncate">{label}</span>
        <ChevronDown size={12} strokeWidth={2} />
      </M.Trigger>
      <M.Portal>
        <M.Content
          align="end"
          sideOffset={4}
          // Above every dialog (`z-[70]`), not below one. A menu opened from
          // inside a dialog rendered behind it, which reads as a dead control:
          // the trigger responds and nothing appears. A popover is always above
          // the surface that opened it.
          // Bounded and scrollable, here rather than at a call site. Radix
          // measures the space between the trigger and the viewport edge and
          // publishes it as this variable; without a max-height a menu with
          // twenty items runs off the bottom of the screen with no way to reach
          // the rest. Every caller of this component has that hazard, so the
          // guard belongs on the component. `overflow-y-auto` and not
          // `overflow-hidden`, which is what silently clipped them.
          className="fade-in z-[80] max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-[16rem]
                     overflow-y-auto overscroll-contain rounded-lg border border-rule bg-paper p-1
                     shadow-[0_10px_30px_var(--shade)]"
        >
          {children}
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}

export function MenuItem({
  children,
  hint,
  danger,
  disabled,
  onSelect,
}: {
  children: React.ReactNode;
  /**
   * What it does, in one line. A menu of verbs with no consequences stated is a trap.
   *
   * `| undefined` spelled out, and the same on `disabled` below, because
   * `exactOptionalPropertyTypes` distinguishes "absent" from "present and
   * undefined" — and a caller computing a hint per item has the second.
   */
  hint?: string | undefined;
  danger?: boolean | undefined;
  /**
   * Offered but not takeable, with `hint` saying why.
   *
   * Radix owns what that means — no pointer, no keyboard, `aria-disabled` — and
   * the reason it is a state rather than an omission is that a choice which
   * silently disappears reads as a bug in the menu. Shown-and-explained is the
   * only form of "you cannot do this here" a reader can act on.
   */
  disabled?: boolean | undefined;
  onSelect: () => void;
}) {
  return (
    <M.Item
      onSelect={onSelect}
      disabled={disabled ?? false}
      className={cn(
        "cursor-pointer rounded-md px-2 py-1.5 text-body outline-none",
        "data-[highlighted]:bg-sunk",
        "data-[disabled]:cursor-default data-[disabled]:text-ink-3",
        danger ? "text-bad" : "text-ink",
      )}
    >
      {children}
      {hint && <span className="mt-px block text-meta font-normal text-ink-3">{hint}</span>}
    </M.Item>
  );
}
