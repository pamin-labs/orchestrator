import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/bits";
import { post } from "../lib/api";
import { cn } from "../lib/utils";

interface Dirs {
  path: string;
  parent: string | null;
  repo: boolean;
  dirs: { name: string; path: string; repo: boolean; taken: boolean }[];
}

/**
 * The server reads the disk and lists directories, so the boss picks instead of
 * typing. A browser cannot hand over a real path, and a typed path is both ugly
 * and the likeliest place to make a mistake.
 */
export function Picker({ open, onOpenChange, onAdded }: {
  open: boolean; onOpenChange: (v: boolean) => void; onAdded: () => void;
}) {
  const [d, setD] = useState<Dirs | null>(null);
  const [err, setErr] = useState("");
  const [name, setName] = useState("");

  const load = async (path?: string | null) => {
    const r = await fetch(`/api/dirs${path ? `?path=${encodeURIComponent(path)}` : ""}`);
    if (!r.ok) return setErr(await r.text());
    setErr("");
    setD((await r.json()) as Dirs);
  };
  useEffect(() => { if (open) void load(null); }, [open]);

  const submit = async (path: string, folder: string) => {
    const r = await post("/api/projects", { name: (name.trim() || folder).slice(0, 40), repo_path: path });
    if (r.ok) { setName(""); onOpenChange(false); onAdded(); }
  };

  const parts = (d?.path ?? "").split("/").filter(Boolean);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-[var(--scrim)]" />
        <Dialog.Content className="fixed left-1/2 top-1/5 z-50 w-[min(34rem,92vw)] -translate-x-1/2 overflow-hidden
                                   rounded-xl border border-rule bg-paper shadow-[0_12px_40px_var(--shade)] fade-in">
          <div className="flex items-baseline gap-2 border-b border-rule p-3">
            <Dialog.Title className="font-display text-[1.0625rem] font-semibold">选择仓库</Dialog.Title>
            <span className="text-[0.75rem] text-ink-3">
              {d?.repo ? "当前目录为 git 仓库" : "git 仓库优先"}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1 border-b border-rule-soft px-3 py-2 font-mono text-[0.6875rem]">
            <Button size="sm" variant="quiet" onClick={() => load("/")}>/</Button>
            {parts.map((seg, i) => (
              <span key={i} className="flex items-center">
                <span className="text-ink-3">/</span>
                <Button size="sm" variant="quiet" onClick={() => load("/" + parts.slice(0, i + 1).join("/"))}>
                  {seg}
                </Button>
              </span>
            ))}
          </div>
          <div className="max-h-[46vh] overflow-y-auto">
            {err && <div className="p-3.5 text-[0.75rem] text-bad">{err}</div>}
            {d?.dirs.length === 0 && <div className="p-3.5 text-[0.75rem] text-ink-3">无子目录</div>}
            {d?.dirs.map((x) => (
              <button
                key={x.path}
                onClick={() => (x.repo && !x.taken ? submit(x.path, x.name) : load(x.path))}
                className={cn(
                  "grid w-full cursor-pointer grid-cols-[1.125rem_minmax(0,1fr)_auto] items-center gap-2",
                  "px-3.5 py-1.5 text-left text-[0.8125rem] transition-colors hover:bg-sunk",
                  x.taken && "text-ink-3",
                )}
              >
                <span className={cn("font-mono text-[0.75rem]", x.repo ? "text-accent" : "text-ink-3")}>
                  {x.repo ? "◆" : "▸"}
                </span>
                <span className={cn("truncate", x.repo && "font-medium")}>{x.name}</span>
                <span className="text-[0.75rem] text-ink-3">
                  {x.taken ? "已添加" : x.repo ? "git 仓库 · 选择" : ""}
                </span>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 border-t border-rule p-3">
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
              disabled={!d?.repo}
              onClick={() => d && submit(d.path, parts[parts.length - 1] ?? "project")}
            >
              选择
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
