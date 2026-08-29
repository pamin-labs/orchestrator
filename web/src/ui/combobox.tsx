import * as P from "@radix-ui/react-popover";
import { useLingui } from "@lingui/react/macro";
import { Command } from "cmdk";
import { ChevronDown } from "lucide-react";
import { useRef, useState } from "react";
import { useDraft } from "../shared/use-draft";
import { cn } from "./cn";

/**
 * One control for a value that comes from a list: type to filter, click or Enter
 * to commit.
 *
 * The base-branch field was a text box **and** a menu beside it — two widgets for
 * one value, where the box could not say what the valid answers were and the menu
 * could not be typed into. Having both was the bug, not either half.
 */
/**
 * **The list is the authority when there is one.** A base branch that does not
 * exist is a group that fails at clone time four steps later, so text matching
 * nothing is refused and the field snaps back. When the list is *empty* — no
 * credential, rate limited, API down — refusing everything would let an
 * unreachable API silently lock a settings field, so then and only then text is
 * taken as typed.
 */
/**
 * shadcn's current combobox is Base UI. This is Radix Popover plus the `cmdk`
 * already here, which is the same composition one library earlier: seven Radix
 * packages are in this tree, and a second primitive library for one control is a
 * dependency that outlives its reason.
 */
/**
 * What a typed or clicked value becomes, and whether the caller hears about it.
 *
 * Refused rather than saved: see the note above. `options.length` is the whole
 * condition — an empty list means unverifiable, not invalid — and a value equal
 * to the stored one is committed to nothing, so reopening the field and pressing
 * Enter is not a write.
 */
export function committed(
  typed: string,
  value: string,
  options: string[],
  free?: boolean,
): { draft: string; commit: string | null } {
  const next = typed.trim();
  if (!free && options.length && !options.includes(next)) return { draft: value, commit: null };
  return { draft: next, commit: next === value.trim() ? null : next };
}

export function Combobox({
  value,
  options,
  placeholder,
  empty,
  disabled,
  width,
  free,
  onCommit,
}: {
  value: string;
  options: string[];
  placeholder?: string;
  /** Defaulted in the body, not in the signature: a default parameter is
   *  evaluated before `useLingui` has run. */
  empty?: string;
  disabled?: boolean;
  width?: string;
  /**
   * The list is a suggestion, not the authority.
   *
   * For a base branch the list *is* the authority — a branch that does not exist
   * fails at clone time four steps later. A model id is the other case: the only
   * way a new one ever enters the config is by being typed somewhere first, and a
   * picker that refused it would be a picker you edit the yaml to get around.
   */
  free?: boolean;
  onCommit: (v: string) => void;
}) {
  const { t } = useLingui();
  const nothingFound = empty ?? t`No matching branches`;
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useDraft(value, value);

  // Typed text filters; it does not narrow to nothing. Showing the whole list on
  // focus is the point of opening it — filtering by the value already in the box
  // would offer exactly the one branch already selected.
  const q = draft.trim().toLowerCase();
  const shown = q && q !== value.trim().toLowerCase() ? options.filter((o) => o.toLowerCase().includes(q)) : options;

  const commit = (v: string) => {
    setOpen(false);
    const next = committed(v, value, options, free);
    setDraft(next.draft);
    if (next.commit !== null) onCommit(next.commit);
  };

  return (
    <P.Root open={open} onOpenChange={setOpen}>
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
              className="w-full rounded-lg border border-rule bg-paper px-2.5 py-1.5 pr-7 font-mono text-body
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
            <Command.List
              className="max-h-[14rem] overflow-y-auto p-1"
              // Scrolled by hand, because this list is portalled to the body and
              // the settings dialog locks scrolling on everything outside its own
              // content — so the wheel did nothing over twenty local images,
              // which reads as a list that simply ends. `modal` on the popover
              // fixes the scroll and breaks the control: a modal popover makes
              // everything outside its content inert, and the input that drives
              // this one lives outside it, so every keystroke dismissed the list.
              //
              // ponytail: two lines against react-remove-scroll's preventDefault.
              // The day Radix hands portalled content to the lock as a shard,
              // delete this.
              onWheel={(e) => {
                e.currentTarget.scrollTop += e.deltaY;
              }}
            >
              {!shown.length && (
                <div className="px-2 py-2 text-secondary text-ink-3">
                  {options.length ? nothingFound : t`Can't read remote branches; storing what you entered`}
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
                    "cursor-pointer rounded-md px-2 py-1.5 font-mono text-secondary text-ink",
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
