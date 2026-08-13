import * as M from "@radix-ui/react-dropdown-menu";
import { ChevronDown } from "lucide-react";
import { buttonStyles } from "./button";
import { cn } from "../lib/utils";

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
      <M.Trigger className={cn(buttonStyles({ variant: "default" }), "cursor-pointer")}>
        {label}
        <ChevronDown size={12} strokeWidth={2} />
      </M.Trigger>
      <M.Portal>
        <M.Content
          align="end"
          sideOffset={4}
          className="fade-in z-50 min-w-[16rem] overflow-hidden rounded-lg border border-rule bg-paper
                     p-1 shadow-[0_10px_30px_var(--shade)]"
        >
          {children}
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}

export function MenuItem({
  children, hint, danger, onSelect,
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
