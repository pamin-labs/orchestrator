import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/bits";
import { post } from "../lib/api";
import { cn } from "../lib/utils";

interface Entry {
  name: string;
  path: string;
  repo?: boolean;
  taken?: boolean;
  size?: number;
}
interface Dirs {
  path: string;
  parent: string | null;
  repo: boolean;
  dirs: Entry[];
  files: Entry[];
}

/**
 * The server reads the disk and lists it, so the boss picks instead of typing.
 *
 * A browser cannot hand over a real path, and a typed path is both ugly and the
 * likeliest place to make a mistake. Two things are picked this way — a repo to
 * add as a project, and files to attach to a message — and they want the same
 * breadcrumb, the same listing, the same keyboard. They differ only in what a row
 * means when you click it, so that is the only thing the two wrappers below
 * decide; everything else is `Browse`.
 */
function Browse({
  title,
  hint,
  /** Files are listed at all, and rows are picked rather than opened. */
  files,
  pick,
  onOpenChange,
  footer,
  onRow,
  chosen,
}: {
  title: string;
  hint?: string;
  files?: boolean;
  /** A row selects instead of navigating; the arrow navigates. */
  pick?: boolean;
  onOpenChange: (v: boolean) => void;
  /** Rendered at the bottom, with the directory currently being listed. */
  footer: (here: Dirs | null) => React.ReactNode;
  /** What a row does. Return false to navigate into it instead. */
  onRow: (e: Entry, isDir: boolean) => boolean;
  chosen?: (path: string) => boolean;
}) {
  const [d, setD] = useState<Dirs | null>(null);
  const [err, setErr] = useState("");

  const load = async (path?: string | null) => {
    const r = await fetch(
      `/api/dirs?${files ? "files=1&" : ""}${path ? `path=${encodeURIComponent(path)}` : ""}`,
    );
    if (!r.ok) return setErr(await r.text());
    setErr("");
    setD((await r.json()) as Dirs);
  };
  useEffect(() => {
    void load(null);
  }, []);

  const parts = (d?.path ?? "").split("/").filter(Boolean);
  const rows: [Entry, boolean][] = [
    ...(d?.dirs ?? []).map((x) => [x, true] as [Entry, boolean]),
    ...(d?.files ?? []).map((x) => [x, false] as [Entry, boolean]),
  ];

  return (
    <>
      <div className="flex items-baseline gap-2 border-b border-rule p-3">
        <Dialog.Title className="font-display text-[1.0625rem] font-semibold">{title}</Dialog.Title>
        {hint && <span className="text-[0.75rem] text-ink-3">{hint}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-1 border-b border-rule-soft px-3 py-2 font-mono text-[0.6875rem]">
        {/* The root button IS the first slash. Printing a separator before every
            segment as well gave `/ / Users / jason`. */}
        <Button size="sm" variant="quiet" onClick={() => load("/")}>/</Button>
        {parts.map((seg, i) => (
          <span key={i} className="flex items-center">
            {i > 0 && <span className="text-ink-3">/</span>}
            <Button size="sm" variant="quiet" onClick={() => load("/" + parts.slice(0, i + 1).join("/"))}>
              {seg}
            </Button>
          </span>
        ))}
      </div>
      <div className="max-h-[46vh] overflow-y-auto">
        {err && <div className="p-3.5 text-[0.75rem] text-bad">{err}</div>}
        {d && !rows.length && <div className="p-3.5 text-[0.75rem] text-ink-3">空目录</div>}
        {rows.map(([x, isDir]) => {
          const meta = chosen?.(x.path)
            ? "已选"
            : x.taken
              ? "已添加"
              : x.repo && !pick
                ? "git 仓库"
                : x.size != null
                  ? `${Math.max(1, Math.round(x.size / 1024))}k`
                  : "";
          const row = cn(
            "grid w-full grid-cols-[1.125rem_minmax(0,1fr)_auto] items-center gap-2",
            "px-3.5 py-1.5 text-left text-[0.8125rem] transition-colors",
            x.taken && "text-ink-3",
            chosen?.(x.path) && "bg-accent-soft",
          );
          const glyph = (
            <span className={cn("font-mono text-[0.75rem]", x.repo && !pick ? "text-accent" : "text-ink-3")}>
              {x.repo && !pick ? "◆" : isDir ? "▸" : "·"}
            </span>
          );
          // A folder that can itself be attached needs two meanings on one row, so
          // it gets two targets: the arrow goes in, the name selects. One click
          // doing both, decided by a flag, is how you end up attaching a folder
          // you only meant to look inside.
          if (!pick) {
            return (
              <button
                key={x.path}
                onClick={() => {
                  if (!onRow(x, isDir) && isDir) void load(x.path);
                }}
                className={cn(row, "cursor-pointer hover:bg-sunk")}
              >
                {glyph}
                <span className={cn("truncate", x.repo && "font-medium")}>{x.name}</span>
                <span className="text-[0.75rem] text-ink-3">{meta}</span>
              </button>
            );
          }
          return (
            <div key={x.path} className={cn(row, "hover:bg-sunk")}>
              {isDir ? (
                <button
                  aria-label={`进入 ${x.name}`}
                  onClick={() => void load(x.path)}
                  className="cursor-pointer font-mono text-[0.75rem] text-ink-3 hover:text-accent"
                >
                  ▸
                </button>
              ) : (
                glyph
              )}
              <button
                onClick={() => onRow(x, isDir)}
                className="cursor-pointer truncate text-left"
              >
                {x.name}
              </button>
              <span className="text-[0.75rem] text-ink-3">{meta}</span>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-rule p-3">{footer(d)}</div>
    </>
  );
}

/** The dialog shell both pickers sit in. */
function Shell({ open, onOpenChange, children }: {
  open: boolean; onOpenChange: (v: boolean) => void; children: React.ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        {/* Above z-50, because the attachment picker opens from inside the new-idea
            dialog — at the same layer its scrim landed under the dialog it was
            supposed to dim, and the picker floated with nothing behind it. */}
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-[var(--scrim)]" />
        <Dialog.Content
          className="fixed left-1/2 top-1/5 z-[70] w-[min(34rem,92vw)] -translate-x-1/2 overflow-hidden
                     rounded-xl border border-rule bg-paper shadow-[0_12px_40px_var(--shade)] fade-in"
        >
          {open && children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Add a project: one git repo, chosen by walking to it. */
export function Picker({ open, onOpenChange, onAdded }: {
  open: boolean; onOpenChange: (v: boolean) => void; onAdded: () => void;
}) {
  const [name, setName] = useState("");
  const submit = async (path: string, folder: string) => {
    const r = await post("/api/projects", { name: (name.trim() || folder).slice(0, 40), repo_path: path });
    if (r.ok) {
      setName("");
      onOpenChange(false);
      onAdded();
    }
  };
  return (
    <Shell open={open} onOpenChange={onOpenChange}>
      <Browse
        title="选择仓库"
        hint="git 仓库优先"
        onOpenChange={onOpenChange}
        // A repo picks itself; anything else is a step on the way.
        onRow={(e) => {
          if (!e.repo || e.taken) return false;
          void submit(e.path, e.name);
          return true;
        }}
        footer={(here) => (
          <>
            <Input
              className="max-w-48"
              placeholder="项目名，默认同目录名"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <span className="grow" />
            <Button onClick={() => onOpenChange(false)}>取消</Button>
            <Button
              variant="go"
              disabled={!here?.repo}
              onClick={() => here && submit(here.path, here.path.split("/").pop() ?? "project")}
            >
              选这个
            </Button>
          </>
        )}
      />
    </Shell>
  );
}

/**
 * Attach from this machine: any number of files, folders included.
 *
 * The `<input type="file">` behind the 附件 button can do neither — a folder is
 * not selectable, and what comes back is bytes the browser had to read, so a
 * folder copied in Finder failed outright. This walks the real disk, so a folder
 * is one click and the server copies it.
 */
export function FilePicker({ open, onOpenChange, onPick }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onPick: (paths: string[]) => void;
}) {
  const [sel, setSel] = useState<string[]>([]);
  useEffect(() => {
    if (open) setSel([]);
  }, [open]);
  return (
    <Shell open={open} onOpenChange={onOpenChange}>
      <Browse
        title="选附件"
        hint="文件和目录都行，点名字进目录"
        files
        pick
        onOpenChange={onOpenChange}
        chosen={(p) => sel.includes(p)}
        // Toggling, not opening: a folder you can attach is a folder you cannot
        // also enter by clicking, so entering is the ▸ on the left and picking is
        // the rest of the row. Files have no second meaning.
        onRow={(e) => {
          setSel((p) => (p.includes(e.path) ? p.filter((x) => x !== e.path) : [...p, e.path]));
          return true;
        }}
        footer={() => (
          <>
            <span className="min-w-0 grow truncate text-[0.75rem] text-ink-3">
              {sel.length ? `选了 ${sel.length} 个` : "还没选"}
            </span>
            <Button onClick={() => onOpenChange(false)}>取消</Button>
            <Button
              variant="go"
              disabled={!sel.length}
              onClick={() => {
                onPick(sel);
                onOpenChange(false);
              }}
            >
              加进来
            </Button>
          </>
        )}
      />
    </Shell>
  );
}
