import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { useEffect, useState } from "react";
import { Button, LinkButton } from "../ui/button";
import { Badge } from "../ui/badge";
import { Menu, MenuItem } from "../ui/menu";
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
    const r = await fetch(`/api/dirs?${files ? "files=1&" : ""}${path ? `path=${encodeURIComponent(path)}` : ""}`);
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
        <Button size="sm" variant="quiet" onClick={() => load("/")}>
          /
        </Button>
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
              <button onClick={() => onRow(x, isDir)} className="cursor-pointer truncate text-left">
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
function Shell({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  children: React.ReactNode;
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
  /** The project already made from it, so a repeat is a route rather than a wall. */
  taken: { id: number; name: string } | null;
}
interface RepoList {
  installations: { id: number; account: string; kind: string }[];
  selected: number | null;
  installUrl: string | null;
  repos: RepoRow[];
}

/**
 * The account the boss was last in, and the last answer itself.
 *
 * Measured against a live server: the route is 1.0-1.3s wall clock, and 0.8-1.0s
 * of that is fixed — an installation with 4 repositories costs the same as one
 * with 87, so neither pagination (87 fit in one page) nor rendering was ever the
 * price. It is one authenticated round trip to api.github.com, and the ETag cache
 * does not touch it: a 304 saves rate limit, not time.
 *
 * Which leaves one lever, and this is it. `Shell` unmounts its children on close,
 * so without a cache every reopen is another second of empty dialog for a list
 * that has not changed. Painting the old answer and revalidating behind it costs
 * two module-level bindings. Not persisted: a wrong guess costs nothing, because
 * the server answers with whatever installation is actually real.
 */
let lastInstallation: number | null = null;
let cached: RepoList | null = null;

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
 *
 * `cmdk` rather than the hand-rolled filter that was here, and rather than
 * `ui/switcher.tsx`. The filter is the smaller half: 87 rows of `<button>` are 87
 * tab stops with no arrow keys, no `aria-selected` and nothing scrolled into
 * view, and that is behaviour, which 硬约束 4 says we do not invent. Not
 * `Switcher` itself, because `Command.Dialog`'s whole chrome is one input and
 * this needs an account control beside it and a footer under it — and because
 * ⌘K navigates, reversibly, while Enter here writes a row. Same shape, different
 * promise.
 */
function Repos({
  title,
  onAdded,
  onOpenProject,
  onSettings,
  onCancel,
}: {
  /** `Dialog.Title` in the dialog, a plain heading inline. Both need the a11y right. */
  title: React.ReactNode;
  onAdded: (projectId: number) => void;
  onOpenProject: (projectId: number) => void;
  onSettings: () => void;
  onCancel?: () => void;
}) {
  const [d, setD] = useState<RepoList | null>(cached);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  // Controlled, and held above cmdk rather than inside it, so a second of network
  // does not eat what was typed over it. Cleared only when the account changes,
  // where a filter written for the other account's names is worse than nothing.
  const [q, setQ] = useState("");

  const load = async (installation?: number) => {
    const want = installation ?? lastInstallation;
    const r = await fetch(`/api/github/repos${want ? `?installation=${want}` : ""}`);
    if (!r.ok) return setErr(await r.text());
    setErr("");
    const next = (await r.json()) as RepoList;
    lastInstallation = next.selected;
    cached = next;
    setD(next);
  };
  useEffect(() => {
    void load();
  }, []);

  // The id was thrown away here, which is why adding a project used to land
  // nowhere: the dialog closed and the boss was left on the same screen to go
  // find what they had just made. `post` already toasts a failure, so this only
  // has to carry the success forward.
  const add = async (repo: string) => {
    setBusy(repo);
    const r = await post("/api/projects", { repo });
    setBusy("");
    if (!r.ok) return;
    const id = Number((JSON.parse(r.text) as { id?: number }).id);
    if (id) onAdded(id);
  };

  const here = d?.installations.find((i) => i.id === d.selected);
  const empty = d && !d.installations.length;

  return (
    <Command label="选择仓库" className="flex min-h-0 flex-col">
      <div className="flex items-baseline gap-2 border-b border-rule p-3">
        {title}
        {/* The rule, stated once and above the fold. Which repository it is about
            to happen to is the highlighted row's job, below. */}
        <span className="min-w-0 grow truncate text-[0.75rem] text-ink-3">点一行就添加</span>
        {/* The org switcher. Behind one click because it is rare, and because a
            row of accounts would outweigh the list it filters. */}
        {d && d.installations.length > 1 ? (
          <Menu label={here ? here.account : "选账号"}>
            {d.installations.map((i) => (
              <MenuItem
                key={i.id}
                hint={i.kind === "Organization" ? "组织" : "个人账号"}
                onSelect={() => {
                  setQ("");
                  void load(i.id);
                }}
              >
                {i.account}
              </MenuItem>
            ))}
          </Menu>
        ) : (
          here && <span className="shrink-0 truncate text-[0.8125rem] font-medium">{here.account}</span>
        )}
      </div>

      {/* Borderless and full width, like the ⌘K palette: a bordered box inside a
          bordered dialog is two frames around one field. */}
      {!empty && (
        <Command.Input
          value={q}
          onValueChange={setQ}
          placeholder="筛一下，或者直接打名字"
          className="w-full border-b border-rule-soft bg-transparent px-3.5 py-2.5 text-[0.875rem]
                     text-ink placeholder:text-ink-3 focus:outline-none"
        />
      )}

      <div className="max-h-[46vh] overflow-y-auto">
        {/* Every failure this route has is fixed in the same place, and the most
            likely one on the most likely screen is "GitHub was never connected" —
            which is the very first thing a new boss sees, as a red sentence with
            nowhere to go. */}
        {err && (
          <div className="space-y-2 border-b border-rule-soft p-3.5">
            <p className="text-[0.8125rem] text-bad">{err}</p>
            <Button onClick={onSettings}>去设置看 GitHub</Button>
          </div>
        )}

        {/* One second of nothing reads as broken. Rows in the shape of rows say
            "this is a list, it is coming", and `breathe` is the same opacity
            animation everything else in flight uses. */}
        {!d && !err && (
          <div className="breathe">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="border-t border-rule-soft px-3.5 py-1.5 first:border-t-0">
                <div className="h-3 rounded-sm bg-sunk" style={{ width: `${58 - i * 7}%` }} />
              </div>
            ))}
          </div>
        )}

        {/* Authorized and installed are different things, and this is the second
            one missing. An empty list with no explanation is the failure. */}
        {empty && (
          <div className="space-y-2 p-3.5 text-[0.8125rem] text-ink-2">
            <p>连上了，但这个 GitHub App 还没装到任何账号上，所以一个仓库也看不见。</p>
            {d.installUrl ? (
              <LinkButton href={d.installUrl}>去 GitHub 装上</LinkButton>
            ) : (
              <p className="text-[0.75rem] text-ink-3">去 GitHub → 这个 App → Install App，选要给它看的仓库。</p>
            )}
          </div>
        )}

        {/* Installed here, and it can see nothing — a different fault from the one
            above and with the same cure, so it gets the button too rather than a
            grey sentence and no way forward. */}
        {d && !!d.installations.length && !d.repos.length && (
          <div className="space-y-2 p-3.5 text-[0.8125rem] text-ink-2">
            <p>{here?.account} 下面，这个 App 一个仓库都看不到。装的时候可能只勾了几个。</p>
            {d.installUrl && <LinkButton href={d.installUrl}>去改它能看哪些</LinkButton>}
          </div>
        )}

        <Command.List>
          {/* cmdk renders Empty on any zero count, and a list still loading is
              also zero — so unguarded it says 没有匹配的 over the skeleton, before
              a single repository has arrived. */}
          {!!d?.repos.length && <Command.Empty className="p-3.5 text-[0.75rem] text-ink-3">没有匹配的</Command.Empty>}
          {/* Name, private, last activity. The `owner/` prefix repeats on every row
              of a list that is already one account, and the default branch is not
              something you choose between 87 of — it appears on the highlighted
              row instead, where it is the evidence for what the click is about to
              decide (硬约束 5). */}
          {(d?.repos ?? []).map((r) => (
            <Command.Item
              key={r.fullName}
              value={r.fullName}
              disabled={!!busy}
              onSelect={() => (r.taken ? onOpenProject(r.taken.id) : void add(r.fullName))}
              className={cn(
                "group grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-baseline gap-2",
                "border-t border-rule-soft px-3.5 py-1.5 text-[0.8125rem] first:border-t-0",
                "data-[selected=true]:bg-sunk",
                r.taken && "text-ink-3",
              )}
            >
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="truncate font-medium">{r.fullName.split("/")[1] ?? r.fullName}</span>
                {r.private && <Badge>私有</Badge>}
              </span>
              <span
                className={cn(
                  "whitespace-nowrap text-[0.75rem] text-ink-3",
                  busy !== r.fullName && "group-data-[selected=true]:hidden",
                )}
              >
                {busy === r.fullName ? "添加中…" : r.taken ? "已添加" : days(r.pushedAt)}
              </span>
              {busy !== r.fullName && (
                <span className="hidden whitespace-nowrap font-mono text-[0.6875rem] text-accent group-data-[selected=true]:inline">
                  {r.taken ? `去 ${r.taken.name} →` : `添加 · ${r.defaultBranch}`}
                </span>
              )}
            </Command.Item>
          ))}
        </Command.List>
      </div>

      {/* Inline and with nothing to count, this whole band is a bordered empty
          strip under the panel. */}
      {(onCancel || !!d?.repos.length) && (
        <div className="flex shrink-0 items-center gap-2 border-t border-rule p-3">
          <span className="min-w-0 grow truncate text-[0.75rem] text-ink-3">
            {d?.repos.length ? `${d.repos.length} 个仓库，最近动过的在前` : ""}
          </span>
          {onCancel && <Button onClick={onCancel}>取消</Button>}
        </div>
      )}
    </Command>
  );
}

/** From a project that already exists: you come to add one and go back to the work. */
export function Picker({
  open,
  onOpenChange,
  onAdded,
  onSettings,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onAdded: (projectId: number) => void;
  onSettings: () => void;
}) {
  const leave = (id: number) => {
    onOpenChange(false);
    onAdded(id);
  };
  return (
    <Shell open={open} onOpenChange={onOpenChange}>
      <Repos
        title={<Dialog.Title className="shrink-0 font-display text-[1.0625rem] font-semibold">选择仓库</Dialog.Title>}
        onAdded={leave}
        onOpenProject={leave}
        onSettings={() => {
          onOpenChange(false);
          onSettings();
        }}
        onCancel={() => onOpenChange(false)}
      />
    </Shell>
  );
}

/**
 * The very first screen, with no project at all — and not a dialog.
 *
 * It was a card explaining that a button would open a list, over a page with
 * nothing else on it: two screens to show one list, and the second one paid the
 * full second of latency after a click rather than during the page load that was
 * happening anyway. DESIGN.md already says it — with no project at all, the page
 * is the one panel it needs, not a tutorial.
 */
export function FirstProject({
  onAdded,
  onSettings,
}: {
  onAdded: (projectId: number) => void;
  onSettings: () => void;
}) {
  return (
    <div className="max-w-[40rem] overflow-hidden rounded-xl border border-rule bg-paper">
      <Repos
        title={<h2 className="shrink-0 font-display text-[1.0625rem] font-semibold">添加第一个项目</h2>}
        onAdded={onAdded}
        onOpenProject={onAdded}
        onSettings={onSettings}
      />
    </div>
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
export function FilePicker({
  open,
  onOpenChange,
  onPick,
}: {
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
