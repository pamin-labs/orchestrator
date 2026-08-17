import { Command } from "cmdk";
import { cn } from "../../ui/cn";

/**
 * Command palette for switching between things of one kind.
 *
 * Tabs were the first attempt and they stop working somewhere around a dozen
 * projects. A filterable list scales, and the keyboard route means switching
 * never costs a trip to the mouse.
 *
 * Controlled, and generic over what it lists: the trigger is whatever the caller
 * wants it to be — the breadcrumb itself, in practice, because a name in a
 * breadcrumb that switches is the shortest possible route to "show me the other
 * one", and a separate 切换 control next to it is one word explaining another.
 */

export interface SwitchItem {
  id: number;
  name: string;
  /** Secondary line, dimmed: a repo path, a branch, a status. */
  meta?: string;
  /** Right-aligned and accented. Reserve it for what needs the boss. */
  badge?: string;
  /** Right-to-left, for paths that matter at the tail. */
  rtlMeta?: boolean;
}

/**
 * One row's cells, decided before anything is drawn.
 *
 * `value` is what cmdk filters on, so the dimmed second line is searchable too —
 * typing a repository path finds the project it belongs to, which is the reason
 * a filterable list replaced tabs in the first place.
 */
export function switchRow(it: SwitchItem) {
  return {
    value: `${it.name} ${it.meta ?? ""}`,
    meta: it.meta ?? null,
    dir: it.rtlMeta ? ("rtl" as const) : undefined,
    badge: it.badge ?? null,
  };
}

export function Switcher({
  open,
  onOpenChange,
  label,
  placeholder,
  empty,
  items,
  onPick,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  label: string;
  placeholder: string;
  empty: string;
  items: SwitchItem[];
  onPick: (id: number) => void;
}) {
  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label={label}
      // Without a scrim the palette floats on top of a fully live page and reads
      // as a stray tooltip rather than something with focus.
      overlayClassName="fixed inset-0 z-40 bg-[var(--scrim)]"
      contentClassName="fixed left-1/2 top-1/4 z-50 w-[min(34rem,92vw)] -translate-x-1/2 overflow-hidden rounded-xl
                        border border-rule bg-paper shadow-[0_12px_40px_var(--shade)] fade-in"
    >
      <Command.Input
        placeholder={placeholder}
        className="w-full border-b border-rule bg-transparent px-3.5 py-2.5 text-[0.875rem]
                   text-ink placeholder:text-ink-3 focus:outline-none"
      />
      <Command.List className="max-h-[50vh] overflow-y-auto p-1.5">
        <Command.Empty className="px-2 py-3 text-[0.75rem] text-ink-3">{empty}</Command.Empty>
        {items.map((it) => {
          const row = switchRow(it);
          return (
            <Command.Item
              key={it.id}
              value={row.value}
              onSelect={() => {
                onPick(it.id);
                onOpenChange(false);
              }}
              className={cn(
                "flex cursor-pointer items-baseline gap-2 rounded-md px-2 py-1.5 text-[0.8125rem]",
                "data-[selected=true]:bg-sunk",
              )}
            >
              {/* Every cell states whether it may wrap. Without that the name broke
                  mid-word and the count stacked one character per line. */}
              <span className="shrink-0 whitespace-nowrap font-display text-[1rem] font-semibold">{it.name}</span>
              {row.meta && (
                <span className="min-w-0 grow truncate font-mono text-[0.6875rem] text-ink-3" dir={row.dir}>
                  {row.meta}
                </span>
              )}
              {!row.meta && <span className="grow" />}
              {row.badge && (
                <span className="shrink-0 whitespace-nowrap font-mono text-[0.6875rem] text-accent">{row.badge}</span>
              )}
            </Command.Item>
          );
        })}
      </Command.List>
    </Command.Dialog>
  );
}
