import * as M from "@radix-ui/react-dropdown-menu";
import { ChevronDown } from "lucide-react";
import { buttonStyles } from "./button";
import { cn } from "./cn";

/**
 * shadcn's dropdown menu, on our tokens.
 *
 * For the actions that are rare and consequential. Sitting in a header at the same
 * weight as 暂停 they read as ordinary, and one of them discards a turn's work — so
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
          className="fade-in z-[80] min-w-[16rem] overflow-hidden rounded-lg border border-rule bg-paper
                     p-1 shadow-[0_10px_30px_var(--shade)]"
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
  onSelect,
}: {
  children: React.ReactNode;
  /** What it does, in one line. A menu of verbs with no consequences stated is a trap. */
  hint?: string;
  danger?: boolean;
  onSelect: () => void;
}) {
  return (
    <M.Item
      onSelect={onSelect}
      className={cn(
        "cursor-pointer rounded-md px-2 py-1.5 text-[0.8125rem] outline-none",
        "data-[highlighted]:bg-sunk",
        danger ? "text-bad" : "text-ink",
      )}
    >
      {children}
      {hint && <span className="mt-px block text-[0.6875rem] font-normal text-ink-3">{hint}</span>}
    </M.Item>
  );
}
