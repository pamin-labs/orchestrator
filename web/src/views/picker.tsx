import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { Button, LinkButton } from "../ui/button";
import { Badge } from "../ui/badge";
import { Menu, MenuItem } from "../ui/menu";
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
            segment as well gave `/ / Users / me`. */}
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

interface RepoRow {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  pushedAt: number;
  taken: boolean;
}
interface RepoList {
  installations: { id: number; account: string; kind: string }[];
  selected: number | null;
  installUrl: string | null;
  repos: RepoRow[];
}

/**
 * The account the boss was last in, so the next open can ask for both halves at
 * once.
 *
 * Measured: a round trip to api.github.com is 260-630ms, and the route cannot
 * fetch repositories until it knows the installation id — so a cold open is two
 * trips in series. Naming the id turns that back into one. Module-level rather
 * than stored: it is a guess that costs nothing when wrong (the server answers
 * with whatever installation is real) and nothing is worth persisting for it.
 */
let lastInstallation: number | null = null;

const days = (t: number) => {
  if (!t) return "";
  const d = Math.round((Date.now() - t) / 86_400_000);
  return d < 1 ? "今天" : d < 30 ? `${d} 天前` : `${Math.round(d / 30)} 个月前`;
};

/**
 * Add a project: a repository this login can reach, not a directory on this host.
 *
 * The list is what the GitHub App is *installed* on, which is also why the org
 * switcher is a list of installations rather than a second login — one token
 * already sees all of them. A repository the app was never installed on is
 * deliberately absent: it would add cleanly and fail at its first clone with a
 * 404 that cannot say why.
 */
export function Picker({ open, onOpenChange, onAdded }: {
  open: boolean; onOpenChange: (v: boolean) => void; onAdded: () => void;
}) {
  const [d, setD] = useState<RepoList | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState("");

  const load = async (installation?: number) => {
    const want = installation ?? lastInstallation;
    const r = await fetch(`/api/github/repos${want ? `?installation=${want}` : ""}`);
    if (!r.ok) return setErr(await r.text());
    setErr("");
    const next = (await r.json()) as RepoList;
    lastInstallation = next.selected;
    setD(next);
  };
  useEffect(() => {
    if (open) {
      setQ("");
      void load();
    }
  }, [open]);

  const add = async (repo: string) => {
    setBusy(repo);
    const r = await post("/api/projects", { repo });
    setBusy("");
    if (r.ok) {
      onOpenChange(false);
      onAdded();
    }
  };

  const here = d?.installations.find((i) => i.id === d.selected);
  const shown = (d?.repos ?? []).filter((r) => r.fullName.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <Shell open={open} onOpenChange={onOpenChange}>
      <div className="flex items-baseline gap-2 border-b border-rule p-3">
        <Dialog.Title className="font-display text-[1.0625rem] font-semibold">选择仓库</Dialog.Title>
        {/* The consequence, where the decision is, not in a footer under 87 rows:
            a list that adds on click without warning is a list people are afraid
            to scroll. */}
        <span className="text-[0.75rem] text-ink-3">点一行就添加，不用再确认</span>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-rule-soft px-3 py-2">
        {/* The org switcher. Behind one click because it is rare, and because a
            row of accounts would outweigh the list it filters. */}
        {d && d.installations.length > 1 ? (
          <Menu label={here ? `${here.account}` : "选账号"}>
            {d.installations.map((i) => (
              <MenuItem
                key={i.id}
                hint={i.kind === "Organization" ? "组织" : "个人账号"}
                onSelect={() => void load(i.id)}
              >
                {i.account}
              </MenuItem>
            ))}
          </Menu>
        ) : (
          here && <span className="text-[0.8125rem] font-medium">{here.account}</span>
        )}
        <Input
          className="min-w-0 flex-1"
          placeholder="筛一下"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div className="max-h-[46vh] overflow-y-auto">
        {err && <div className="p-3.5 text-[0.75rem] text-bad">{err}</div>}
        {!d && !err && <div className="p-3.5 text-[0.75rem] text-ink-3">读取中…</div>}
        {/* Authorized and installed are different things, and this is the second
            one missing. An empty list with no explanation is the failure. */}
        {d && !d.installations.length && (
          <div className="space-y-2 p-3.5 text-[0.8125rem] text-ink-2">
            <p>连上了，但这个 GitHub App 还没装到任何账号上，所以一个仓库也看不见。</p>
            {d.installUrl ? (
              <LinkButton href={d.installUrl}>去装上</LinkButton>
            ) : (
              <p className="text-[0.75rem] text-ink-3">去 GitHub → 这个 App → Install App，选要给它看的仓库。</p>
            )}
          </div>
        )}
        {d && !!d.installations.length && !shown.length && (
          <div className="p-3.5 text-[0.75rem] text-ink-3">
            {d.repos.length ? "没有匹配的" : "这个账号下，App 没被授权看任何仓库"}
          </div>
        )}
        {/* One line per repository: the name, whether it is private, when it
            last moved. The `owner/` prefix is on every row of a list that is
            already one account, and the default branch is a fact nobody chooses
            on — both were a second line of noise per row. */}
        {shown.map((r) => (
          <button
            key={r.fullName}
            disabled={r.taken || !!busy}
            onClick={() => void add(r.fullName)}
            className={cn(
              "flex w-full items-baseline gap-2 border-t border-rule-soft px-3.5 py-1.5 text-left",
              "text-[0.8125rem] transition-colors first:border-t-0",
              r.taken ? "text-ink-3" : "cursor-pointer hover:bg-sunk",
            )}
          >
            <span className="truncate font-medium">{r.fullName.split("/")[1] ?? r.fullName}</span>
            {r.private && <Badge>私有</Badge>}
            <span className="grow" />
            <span className="shrink-0 text-[0.75rem] text-ink-3">
              {r.taken ? "已添加" : busy === r.fullName ? "添加中…" : days(r.pushedAt)}
            </span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-rule p-3">
        <span className="min-w-0 grow truncate text-[0.75rem] text-ink-3">
          {d && d.repos.length > 0 && `${shown.length} / ${d.repos.length} 个仓库，最近动过的在前`}
        </span>
        <Button onClick={() => onOpenChange(false)}>取消</Button>
      </div>
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
