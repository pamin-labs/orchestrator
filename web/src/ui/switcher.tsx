import { Command } from "cmdk";
import { useEffect, useState } from "react";
import type { Project } from "../lib/api";
import { cn } from "../lib/utils";

/**
 * Project switcher as a command palette, reachable with ⌘K.
 *
 * Tabs were the first attempt and they stop working somewhere around a dozen
 * projects. A filterable list scales, and the keyboard route means switching
 * never costs a trip to the mouse.
 */
export function Switcher({
  projects,
  waiting,
  onPick,
}: {
  projects: Project[];
  waiting: (id: number) => number;
  onPick: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="cursor-pointer text-[0.6875rem] text-ink-3 hover:text-ink transition-colors"
      >
        切换 <span className="font-mono">⌘K</span>
      </button>
      <Command.Dialog
        open={open}
        onOpenChange={setOpen}
        label="切换项目"
        className="fixed left-1/2 top-1/4 z-50 w-[min(30rem,92vw)] -translate-x-1/2 overflow-hidden rounded-xl
                   border border-rule bg-paper shadow-[0_12px_40px_oklch(0_0_0/0.18)] fade-in"
      >
        <Command.Input
          placeholder="项目名…"
          className="w-full border-b border-rule bg-transparent px-3.5 py-2.5 text-[0.875rem]
                     text-ink placeholder:text-ink-3 focus:outline-none"
        />
        <Command.List className="max-h-[50vh] overflow-y-auto p-1.5">
          <Command.Empty className="px-2 py-3 text-[0.75rem] text-ink-3">没有匹配的项目</Command.Empty>
          {projects.map((p) => {
            const n = waiting(p.id);
            return (
              <Command.Item
                key={p.id}
                value={p.name}
                onSelect={() => {
                  onPick(p.id);
                  setOpen(false);
                }}
                className={cn(
                  "flex cursor-pointer items-baseline gap-2 rounded-md px-2 py-1.5 text-[0.8125rem]",
                  "data-[selected=true]:bg-sunk",
                )}
              >
                <span className="font-display text-[1rem] font-semibold">{p.name}</span>
                <span className="grow truncate font-mono text-[0.6875rem] text-ink-3">{p.repo_path}</span>
                {n > 0 && <span className="font-mono text-[0.6875rem] text-accent">{n} 件等你</span>}
              </Command.Item>
            );
          })}
        </Command.List>
      </Command.Dialog>
    </>
  );
}
