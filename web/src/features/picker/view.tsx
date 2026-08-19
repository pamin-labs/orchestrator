import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, LinkButton } from "../../ui/button";
import { Badge } from "../../ui/badge";
import { Menu, MenuItem } from "../../ui/menu";
import { api, mutate, readJson } from "../../shared/api";
import { cn } from "../../ui/cn";
import { browseListing, browseRow, repoRow, type Entry } from "./model";
import { z } from "zod";
import type { InferResponseType } from "hono/client";

const EntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  repo: z.boolean().optional(),
  taken: z.boolean().optional(),
  size: z.number().optional(),
});
const DirEntrySchema = EntrySchema.omit({ size: true }).required({ repo: true, taken: true });
const FileEntrySchema = EntrySchema.omit({ repo: true, taken: true }).required({ size: true });
const DirsSchema: z.ZodType<InferResponseType<typeof api.dirs.$get, 200>> = z.object({
  path: z.string(),
  parent: z.string().nullable(),
  repo: z.boolean(),
  dirs: z.array(DirEntrySchema),
  files: z.array(FileEntrySchema),
});
type Dirs = z.infer<typeof DirsSchema>;

interface BrowseRowProps {
  entry: Entry;
  isDir: boolean;
  pick: boolean;
  selected: boolean;
  onRow: (entry: Entry, isDir: boolean) => boolean;
  load: (path: string) => void;
}

/** Handle, name, right edge. Fixed, so the names line up down the listing. */
const BROWSE_ROW =
  "grid w-full grid-cols-[1.125rem_minmax(0,1fr)_auto] items-center gap-2 px-3.5 py-1.5 text-left text-[0.8125rem] transition-colors";

type RowProps = BrowseRowProps & { row: string; glyph: React.ReactNode; meta: string };

function Glyph({ mark, accent }: { mark: string; accent: boolean }) {
  return <span className={cn("font-mono text-[0.75rem]", accent ? "text-accent" : "text-ink-3")}>{mark}</span>;
}

/** Picking attachments: the arrow walks in, the name toggles the tick. */
function PickBrowseRow(props: RowProps) {
  const { t } = useTranslation();
  return (
    <div className={cn(props.row, "hover:bg-sunk")}>
      {props.isDir ? (
        <button
          type="button"
          aria-label={t("picker.view.browseRow.enter", "进入 {{name}}", { name: props.entry.name })}
          onClick={() => props.load(props.entry.path)}
          className="cursor-pointer font-mono text-[0.75rem] text-ink-3 hover:text-accent"
        >
          ▸
        </button>
      ) : (
        props.glyph
      )}
      <button
        type="button"
        onClick={() => props.onRow(props.entry, props.isDir)}
        className="cursor-pointer truncate text-left"
      >
        {props.entry.name}
      </button>
      <span className="text-[0.75rem] text-ink-3">{props.meta}</span>
    </div>
  );
}

/** Walking for a project: the whole row is one button, and it goes in. */
function WalkBrowseRow(props: RowProps) {
  return (
    <button
      type="button"
      onClick={() => {
        if (!props.onRow(props.entry, props.isDir) && props.isDir) props.load(props.entry.path);
      }}
      className={cn(props.row, "cursor-pointer hover:bg-sunk")}
    >
      {props.glyph}
      <span className={cn("truncate", props.entry.repo && "font-medium")}>{props.entry.name}</span>
      <span className="text-[0.75rem] text-ink-3">{props.meta}</span>
    </button>
  );
}

function BrowseRow(props: BrowseRowProps) {
  const marks = browseRow(props.entry, props.isDir, props.pick, props.selected);
  const row = {
    ...props,
    row: cn(BROWSE_ROW, props.entry.taken && "text-ink-3", props.selected && "bg-accent-soft"),
    glyph: <Glyph mark={marks.glyph} accent={marks.repo} />,
    meta: marks.meta,
  };
  return props.pick ? <PickBrowseRow {...row} /> : <WalkBrowseRow {...row} />;
}

/** The listing itself: the read that failed, the directory with nothing in it, or the rows. */
function BrowseRows(props: {
  here: Dirs | null;
  rows: [Entry, boolean][];
  err: string;
  pick: boolean;
  chosen: (path: string) => boolean;
  onRow: (e: Entry, isDir: boolean) => boolean;
  load: (path: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="max-h-[46vh] overflow-y-auto">
      {props.err && <div className="p-3.5 text-[0.75rem] text-bad">{props.err}</div>}
      {props.here && !props.rows.length && (
        <div className="p-3.5 text-[0.75rem] text-ink-3">{t("picker.view.browseRows.empty", "空目录")}</div>
      )}
      {props.rows.map(([entry, isDir]) => (
        <BrowseRow
          key={entry.path}
          entry={entry}
          isDir={isDir}
          pick={props.pick}
          selected={props.chosen(entry.path)}
          onRow={props.onRow}
          load={props.load}
        />
      ))}
    </div>
  );
}

function Browse({
  title,
  hint,
  files,
  pick,
  footer,
  onRow,
  chosen,
}: {
  title: string;
  hint?: string;
  files?: boolean;
  pick?: boolean;
  footer: (here: Dirs | null) => React.ReactNode;
  onRow: (e: Entry, isDir: boolean) => boolean;
  chosen: (path: string) => boolean;
}) {
  const [d, setD] = useState<Dirs | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(
    async (path?: string | null) => {
      const result = await readJson(
        await api.dirs.$get({
          query: { ...(files ? { files: "1" } : {}), ...(path ? { path } : {}) },
        }),
        DirsSchema,
      );
      if (!result.ok) return setErr(result.text);
      setErr("");
      setD(result.data);
    },
    [files],
  );
  useEffect(() => {
    void load(null);
  }, [load]);

  const { parts, rows } = browseListing(d);

  return (
    <>
      <div className="flex items-baseline gap-2 border-b border-rule p-3">
        <Dialog.Title className="font-display text-[1.0625rem] font-semibold">{title}</Dialog.Title>
        {hint && <span className="text-[0.75rem] text-ink-3">{hint}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-1 border-b border-rule-soft px-3 py-2 font-mono text-[0.6875rem]">
        <Button size="sm" variant="quiet" onClick={() => load("/")}>
          /
        </Button>
        {parts.map((seg, i) => (
          <span key={parts.slice(0, i + 1).join("/")} className="flex items-center">
            {i > 0 && <span className="text-ink-3">/</span>}
            <Button size="sm" variant="quiet" onClick={() => load("/" + parts.slice(0, i + 1).join("/"))}>
              {seg}
            </Button>
          </span>
        ))}
      </div>
      <BrowseRows
        here={d}
        rows={rows}
        err={err}
        pick={!!pick}
        chosen={chosen}
        onRow={onRow}
        load={(path) => void load(path)}
      />
      <div className="flex flex-wrap items-center gap-2 border-t border-rule p-3">{footer(d)}</div>
    </>
  );
}

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

const RepoListSchema: z.ZodType<InferResponseType<typeof api.github.repos.$get, 200>> = z.object({
  installations: z.array(z.object({ id: z.number(), account: z.string(), kind: z.string() })),
  selected: z.number().nullable(),
  installUrl: z.string(),
  repos: z.array(
    z.object({
      fullName: z.string(),
      private: z.boolean(),
      defaultBranch: z.string(),
      pushedAt: z.number(),
      cloneUrl: z.string(),
      taken: z.object({ id: z.number(), name: z.string() }).nullable(),
    }),
  ),
});
type RepoList = z.infer<typeof RepoListSchema>;

const ProjectCreatedSchema: z.ZodType<InferResponseType<typeof api.projects.$post, 200>> = z.object({
  id: z.number(),
  gates: z.array(z.string()),
});

let lastInstallation: number | null = null;
let cached: RepoList | null = null;

type Repo = RepoList["repos"][number];

function RepoHeader({
  title,
  data,
  here,
  selectInstallation,
}: {
  title: React.ReactNode;
  data: RepoList | null;
  here: RepoList["installations"][number] | undefined;
  selectInstallation: (id: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-baseline gap-2 border-b border-rule p-3">
      {title}
      <span className="min-w-0 grow truncate text-[0.75rem] text-ink-3">
        {t("picker.view.repoHeader.hint", "点一行就添加")}
      </span>
      {data && data.installations.length > 1 ? (
        <Menu label={here ? here.account : t("picker.view.repoHeader.pickAccount", "选账号")}>
          {data.installations.map((installation) => (
            <MenuItem
              key={installation.id}
              hint={
                installation.kind === "Organization"
                  ? t("picker.view.repoHeader.org", "组织")
                  : t("picker.view.repoHeader.personal", "个人账号")
              }
              onSelect={() => selectInstallation(installation.id)}
            >
              {installation.account}
            </MenuItem>
          ))}
        </Menu>
      ) : (
        here && <span className="shrink-0 truncate text-[0.8125rem] font-medium">{here.account}</span>
      )}
    </div>
  );
}

function RepoError({ error, onSettings }: { error: string; onSettings: () => void }) {
  const { t } = useTranslation();
  if (!error) return null;
  return (
    <div className="space-y-2 border-b border-rule-soft p-3.5">
      <p className="text-[0.8125rem] text-bad">{error}</p>
      <Button onClick={onSettings}>{t("picker.view.repoError.goToSettings", "去设置看 GitHub")}</Button>
    </div>
  );
}

function RepoLoading({ data, error }: { data: RepoList | null; error: string }) {
  if (data || error) return null;
  return (
    <div className="breathe">
      {[0, 1, 2, 3, 4].map((index) => (
        <div key={index} className="border-t border-rule-soft px-3.5 py-1.5 first:border-t-0">
          <div className="h-3 rounded-sm bg-sunk" style={{ width: `${58 - index * 7}%` }} />
        </div>
      ))}
    </div>
  );
}

function RepoInstallEmpty({ data, empty }: { data: RepoList | null; empty: boolean | null }) {
  const { t } = useTranslation();
  if (!empty) return null;
  return (
    <div className="space-y-2 p-3.5 text-[0.8125rem] text-ink-2">
      <p>{t("picker.view.repoInstallEmpty.body", "连上了，但这个 GitHub App 还没装到任何账号上，所以一个仓库也看不见。")}</p>
      {data?.installUrl ? (
        <LinkButton href={data.installUrl}>{t("picker.view.repoInstallEmpty.install", "去 GitHub 装上")}</LinkButton>
      ) : (
        <p className="text-[0.75rem] text-ink-3">
          {t("picker.view.repoInstallEmpty.hint", "去 GitHub → 这个 App → Install App，选要给它看的仓库。")}
        </p>
      )}
    </div>
  );
}

function RepoListEmpty({ data, account }: { data: RepoList | null; account: string | undefined }) {
  const { t } = useTranslation();
  if (!data) return null;
  if (!data.installations.length) return null;
  if (data.repos.length) return null;
  return (
    <div className="space-y-2 p-3.5 text-[0.8125rem] text-ink-2">
      <p>{t("picker.view.repoListEmpty.body", "{{account}} 下面，这个 App 一个仓库都看不到。装的时候可能只勾了几个。", { account })}</p>
      {data.installUrl && (
        <LinkButton href={data.installUrl}>{t("picker.view.repoListEmpty.change", "去改它能看哪些")}</LinkButton>
      )}
    </div>
  );
}

function RepoStates(props: {
  data: RepoList | null;
  error: string;
  empty: boolean | null;
  account: string | undefined;
  onSettings: () => void;
}) {
  return (
    <>
      <RepoError error={props.error} onSettings={props.onSettings} />
      <RepoLoading data={props.data} error={props.error} />
      <RepoInstallEmpty data={props.data} empty={props.empty} />
      <RepoListEmpty data={props.data} account={props.account} />
    </>
  );
}

/**
 * The right edge of a repository row: what it is now, and what pressing it does.
 *
 * The action hides until the row is the one under the cursor, so the list reads
 * as ages rather than as thirty offers. A row already being added has neither —
 * it says 添加中… and stops offering to be pressed again.
 */
function RepoEdge({ marks }: { marks: ReturnType<typeof repoRow> }) {
  if (marks.adding) return <span className="whitespace-nowrap text-[0.75rem] text-ink-3">{marks.meta}</span>;
  return (
    <>
      <span className="whitespace-nowrap text-[0.75rem] text-ink-3 group-data-[selected=true]:hidden">
        {marks.meta}
      </span>
      <span className="hidden whitespace-nowrap font-mono text-[0.6875rem] text-accent group-data-[selected=true]:inline">
        {marks.action}
      </span>
    </>
  );
}

function RepoItem({ repo, busy, select }: { repo: Repo; busy: string; select: (repo: Repo) => void }) {
  const marks = repoRow(repo, busy);
  const { t } = useTranslation();
  return (
    <Command.Item
      value={repo.fullName}
      disabled={!!busy}
      onSelect={() => select(repo)}
      className={cn(
        "group grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-baseline gap-2 border-t border-rule-soft px-3.5 py-1.5 text-[0.8125rem] first:border-t-0 data-[selected=true]:bg-sunk",
        repo.taken && "text-ink-3",
      )}
    >
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="truncate font-medium">{marks.name}</span>
        {repo.private && <Badge>{t("picker.view.repoItem.private", "私有")}</Badge>}
      </span>
      <RepoEdge marks={marks} />
    </Command.Item>
  );
}

function RepositoryList({ data, busy, select }: { data: RepoList | null; busy: string; select: (repo: Repo) => void }) {
  const repos = data?.repos ?? [];
  const { t } = useTranslation();
  return (
    <Command.List>
      {!!repos.length && (
        <Command.Empty className="p-3.5 text-[0.75rem] text-ink-3">
          {t("picker.view.repositoryList.noMatch", "没有匹配的")}
        </Command.Empty>
      )}
      {repos.map((repo) => (
        <RepoItem key={repo.fullName} repo={repo} busy={busy} select={select} />
      ))}
    </Command.List>
  );
}

function RepoFooter({ data, onCancel }: { data: RepoList | null; onCancel: (() => void) | undefined }) {
  const { t } = useTranslation();
  if (!onCancel && !data?.repos.length) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-rule p-3">
      <span className="min-w-0 grow truncate text-[0.75rem] text-ink-3">
        {data?.repos.length
          ? t("picker.view.repoFooter.count", "{{n}} 个仓库，最近动过的在前", { n: data.repos.length })
          : ""}
      </span>
      {onCancel && <Button onClick={onCancel}>{t("picker.view.repoFooter.cancel", "取消")}</Button>}
    </div>
  );
}

function Repos({
  title,
  onAdded,
  onOpenProject,
  onSettings,
  onCancel,
}: {
  title: React.ReactNode;
  onAdded: (projectId: number) => void;
  onOpenProject: (projectId: number) => void;
  onSettings: () => void;
  onCancel?: () => void;
}) {
  const [d, setD] = useState<RepoList | null>(cached);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [q, setQ] = useState("");
  const { t } = useTranslation();

  const load = async (installation?: number) => {
    const want = installation ?? lastInstallation;
    const result = await readJson(
      await api.github.repos.$get({ query: want ? { installation: String(want) } : {} }),
      RepoListSchema,
    );
    if (!result.ok) return setErr(result.text);
    setErr("");
    const next = result.data;
    lastInstallation = next.selected;
    cached = next;
    setD(next);
  };
  useEffect(() => {
    void load();
  }, []);

  const add = async (repo: string) => {
    setBusy(repo);
    const r = await mutate(api.projects.$post({ json: { repo } }), false, ProjectCreatedSchema);
    setBusy("");
    if (!r.ok) return;
    onAdded(r.data.id);
  };

  const here = d?.installations.find((i) => i.id === d.selected);
  const empty = d && !d.installations.length;

  const selectRepo = (repo: Repo) => {
    if (repo.taken) onOpenProject(repo.taken.id);
    else void add(repo.fullName);
  };

  return (
    <Command label={t("picker.view.repos.label", "选择仓库")} className="flex min-h-0 flex-col">
      <RepoHeader
        title={title}
        data={d}
        here={here}
        selectInstallation={(id) => {
          setQ("");
          void load(id);
        }}
      />
      {!empty && (
        <Command.Input
          value={q}
          onValueChange={setQ}
          placeholder={t("picker.view.repos.placeholder", "筛一下，或者直接打名字")}
          className="w-full border-b border-rule-soft bg-transparent px-3.5 py-2.5 text-[0.875rem]
                     text-ink placeholder:text-ink-3 focus:outline-none"
        />
      )}
      <div className="max-h-[46vh] overflow-y-auto">
        <RepoStates data={d} error={err} empty={empty} account={here?.account} onSettings={onSettings} />
        <RepositoryList data={d} busy={busy} select={selectRepo} />
      </div>
      <RepoFooter data={d} onCancel={onCancel} />
    </Command>
  );
}

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
  const { t } = useTranslation();
  return (
    <Shell open={open} onOpenChange={onOpenChange}>
      <Repos
        title={
          <Dialog.Title className="shrink-0 font-display text-[1.0625rem] font-semibold">
            {t("picker.view.picker.title", "选择仓库")}
          </Dialog.Title>
        }
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

export function FirstProject({
  onAdded,
  onSettings,
}: {
  onAdded: (projectId: number) => void;
  onSettings: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="max-w-[40rem] overflow-hidden rounded-xl border border-rule bg-paper">
      <Repos
        title={
          <h2 className="shrink-0 font-display text-[1.0625rem] font-semibold">
            {t("picker.view.firstProject.title", "添加第一个项目")}
          </h2>
        }
        onAdded={onAdded}
        onOpenProject={onAdded}
        onSettings={onSettings}
      />
    </div>
  );
}

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
  const { t } = useTranslation();
  return (
    <Shell open={open} onOpenChange={onOpenChange}>
      <Browse
        title={t("picker.view.filePicker.title", "选附件")}
        hint={t("picker.view.filePicker.hint", "文件和目录都行，点名字进目录")}
        files
        pick
        chosen={(p) => sel.includes(p)}
        onRow={(e) => {
          setSel((p) => (p.includes(e.path) ? p.filter((x) => x !== e.path) : [...p, e.path]));
          return true;
        }}
        footer={() => (
          <>
            <span className="min-w-0 grow truncate text-[0.75rem] text-ink-3">
              {sel.length
                ? t("picker.view.filePicker.selected", "选了 {{n}} 个", { n: sel.length })
                : t("picker.view.filePicker.noneSelected", "还没选")}
            </span>
            <Button onClick={() => onOpenChange(false)}>{t("picker.view.filePicker.cancel", "取消")}</Button>
            <Button
              variant="go"
              disabled={!sel.length}
              onClick={() => {
                onPick(sel);
                onOpenChange(false);
              }}
            >
              {t("picker.view.filePicker.add", "加进来")}
            </Button>
          </>
        )}
      />
    </Shell>
  );
}
