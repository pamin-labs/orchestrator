import * as P from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";

/**
 * One control for a value that is usually on a list and occasionally is not.
 *
 * The first attempt at the base-branch field was a text box **and** a 选 button
 * beside it: two controls for one value, where the box could not tell you what
 * the valid answers were and the menu could not accept an answer that was not
 * on it yet. Neither half was wrong; having both was.
 *
 * A combobox is the shape that holds both properties at once — type to filter,
 * pick to commit, and whatever you typed is still a legal answer when nothing
 * matches. That last part is why this is not a `Select`: a branch that does not
 * exist yet is a real thing to enter, and so is any value when the list could
 * not be fetched.
 *
 * shadcn's own combobox is built on Base UI. This one is Radix Popover plus
 * `cmdk`, which is the same composition one library earlier and the one this
 * codebase already has — a second primitive library for a single control is a
 * dependency that outlives the reason for it.
 */
export function Combobox({
  value,
  options,
  placeholder,
  empty = "没有匹配的",
  disabled,
  width,
  onCommit,
}: {
  value: string;
  options: string[];
  placeholder?: string;
  empty?: string;
  disabled?: boolean;
  width?: string;
  /** Fired on pick, on Enter, and on leaving with the text changed. */
  onCommit: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setDraft(value), [value]);

  const commit = (v: string) => {
    const next = v.trim();
    setDraft(next);
    setOpen(false);
    if (next !== value.trim()) onCommit(next);
  };

  return (
    <P.Root open={open} onOpenChange={setOpen}>
      <Command
        // Filtering is ours: cmdk's default hides everything once the text stops
        // matching, and the whole point here is that a value nobody offered is
        // still enterable — an empty list must not look like a broken field.
        shouldFilter={false}
        className={cn("relative min-w-0 flex-1", width)}
      >
        <P.Anchor asChild>
          <div className="relative">
            <Command.Input
              ref={input}
              value={draft}
              disabled={disabled}
              placeholder={placeholder}
              onValueChange={(v) => {
                setDraft(v);
                if (!open) setOpen(true);
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commit(draft);
                } else if (e.key === "Escape") {
                  setDraft(value);
                  setOpen(false);
                }
              }}
              onBlur={() => commit(draft)}
              className="w-full rounded-lg border border-rule bg-paper px-2.5 py-1.5 pr-7 font-mono text-[0.8125rem]
                         text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none
                         disabled:opacity-50"
            />
            {/* Affordance only. The input owns the interaction, so this must not
                be a second thing to aim at — it opens what focus already opens. */}
            <ChevronDown
              size={12}
              strokeWidth={2}
              aria-hidden
              className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-3"
            />
          </div>
        </P.Anchor>

        <P.Portal>
          <P.Content
            align="start"
            sideOffset={4}
            // Focus stays in the input: this is a filtered list, not a menu, and
            // moving focus into it would break typing mid-selection.
            onOpenAutoFocus={(e) => e.preventDefault()}
            className="z-50 w-[var(--radix-popover-trigger-width)] min-w-[12rem] overflow-hidden rounded-lg
                       border border-rule bg-paper shadow-[0_8px_28px_var(--shade)] fade-in"
          >
            <Command.List className="max-h-[14rem] overflow-y-auto p-1">
              {!options.length && <div className="px-2 py-2 text-[0.75rem] text-ink-3">{empty}</div>}
              {options
                .filter((o) => o.toLowerCase().includes(draft.trim().toLowerCase()))
                .map((o) => (
                  <Command.Item
                    key={o}
                    value={o}
                    onSelect={() => commit(o)}
                    className={cn(
                      "cursor-pointer rounded-md px-2 py-1.5 font-mono text-[0.75rem] text-ink",
                      "data-[selected=true]:bg-sunk",
                    )}
                  >
                    {o}
                  </Command.Item>
                ))}
            </Command.List>
          </P.Content>
        </P.Portal>
      </Command>
    </P.Root>
  );
}
