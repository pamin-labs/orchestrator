import * as P from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";

/**
 * One control for a value that comes from a list.
 *
 * Type to filter, click or Enter to commit. The first attempt at the
 * base-branch field was a text box **and** a menu beside it: two widgets for one
 * value, where the box could not say what the valid answers were and the menu
 * could not be typed into. Having both was the bug, not either half.
 *
 * **The list is the authority when there is one.** A base branch that does not
 * exist is not a value, it is a group that fails at clone time four steps later,
 * so text that matches nothing is refused and the field snaps back. When the
 * list is *empty* — no GitHub credential, rate limited, the API down — there is
 * nothing to check against, and refusing everything would mean an unreachable
 * API silently locks a settings field. Then, and only then, text is taken as
 * typed.
 *
 * shadcn's current combobox is Base UI. This is Radix Popover plus the `cmdk`
 * already here, which is the same composition one library earlier: seven Radix
 * packages are in this tree, and a second primitive library for one control is a
 * dependency that outlives its reason.
 */
export function Combobox({
  value,
  options,
  placeholder,
  empty = "没有匹配的分支",
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
  onCommit: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => setDraft(value), [value]);

  // Typed text filters; it does not narrow to nothing. Showing the whole list on
  // focus is the point of opening it — filtering by the value already in the box
  // would offer exactly the one branch already selected.
  const q = draft.trim().toLowerCase();
  const shown = q && q !== value.trim().toLowerCase()
    ? options.filter((o) => o.toLowerCase().includes(q))
    : options;

  const commit = (v: string) => {
    const next = v.trim();
    setOpen(false);
    // Refused rather than saved: see the note above. `options.length` is the
    // whole condition — an empty list means unverifiable, not invalid.
    if (options.length && !options.includes(next)) return setDraft(value);
    setDraft(next);
    if (next !== value.trim()) onCommit(next);
  };

  // `modal`, and it is not about focus: this control lives inside the settings
  // dialog, and Radix's Dialog locks scrolling on everything outside its own
  // content. The list is portalled to the body, so it was outside — the wheel
  // did nothing over a list of twenty images, which reads as a list that simply
  // ends. A modal popover brings its own scroll lock, which takes over for as
  // long as it is open.
  return (
    <P.Root open={open} onOpenChange={setOpen} modal>
      <Command shouldFilter={false} className={cn("relative min-w-0 flex-1", width)}>
        <P.Anchor asChild>
          <div className="relative">
            <Command.Input
              ref={box}
              value={draft}
              disabled={disabled}
              placeholder={placeholder}
              onValueChange={(v) => {
                setDraft(v);
                if (!open) setOpen(true);
              }}
              // Not `onBlur`. Radix portals the content and installs focus
              // guards, so the input blurs for an instant as the popover mounts
              // — and closing on blur meant the list appeared and vanished by
              // itself a moment later, which is what this looked like. Dismissal
              // belongs to the popover, which knows what is inside it.
              onFocus={() => setOpen(true)}
              onClick={() => setOpen(true)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commit(draft);
                } else if (e.key === "Escape") {
                  setDraft(value);
                  setOpen(false);
                }
              }}
              className="w-full rounded-lg border border-rule bg-paper px-2.5 py-1.5 pr-7 font-mono text-[0.8125rem]
                         text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none
                         disabled:opacity-50"
            />
            {/* Affordance only, and deliberately not a second target: the input
                owns every way in, so this must not be a place to aim. */}
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
            // Focus stays in the box: this is a filtered list, not a menu, and
            // moving focus into it would stop you typing mid-selection.
            onOpenAutoFocus={(e) => e.preventDefault()}
            onCloseAutoFocus={(e) => e.preventDefault()}
            // Clicking away is the one dismissal that also decides the value.
            onInteractOutside={() => commit(draft)}
            className="z-50 w-[var(--radix-popover-trigger-width)] min-w-[12rem] overflow-hidden rounded-lg
                       border border-rule bg-paper shadow-[0_8px_28px_var(--shade)] fade-in"
          >
            <Command.List className="max-h-[14rem] overflow-y-auto p-1">
              {!shown.length && (
                <div className="px-2 py-2 text-[0.75rem] text-ink-3">
                  {options.length ? empty : "读不到远端分支，这里按你填的存"}
                </div>
              )}
              {shown.map((o) => (
                <Command.Item
                  key={o}
                  value={o}
                  // `onSelect` fires on Enter too, and Enter is already handled
                  // on the input — `onMouseDown` keeps the click from blurring
                  // the box before the value lands.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    commit(o);
                  }}
                  onSelect={() => commit(o)}
                  className={cn(
                    "cursor-pointer rounded-md px-2 py-1.5 font-mono text-[0.75rem] text-ink",
                    "data-[selected=true]:bg-sunk",
                    o === value.trim() && "text-accent",
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
