import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell, Box, Check, CircleAlert, Coins, Gauge, GitBranch, KeyRound, ListChecks, MonitorCog, Server,
  SlidersHorizontal, Sparkles, Timer, Trash2, X,
} from "lucide-react";
import { H2, Head, Input, Meta, Pane } from "../ui/bits";
import { Field, FieldContent, FieldGroup, FieldLabel, FieldTitle, InputGroup } from "../ui/field";
import { Button, LinkButton } from "../ui/button";
import { toast } from "sonner";
import { Switch } from "../ui/switch";
import { Badge } from "../ui/badge";
import { Tip } from "../ui/tooltip";
import { ask } from "../ui/confirm";
import { pull, post, del } from "../lib/api";
import { Knobs } from "./knobs";
import { cn, repoHref } from "../lib/utils";
import { ThemeChoice } from "../ui/theme";
import { Gates, ImageRow, Sandbox, type ProjectConfig } from "./project";
import { Skills } from "./skills";
import { CredPane, RUNTIMES } from "./settings/credentials";
import { DeviceCode, type AuthRow, type HostCheck } from "./settings/shared";

/**
 * Everything that is configured rather than worked on, in one dialog.
 *
 * It was two pages for four versions and every one of them had the same disease:
 * a view is 76rem wide and this is a dozen fields, so the grid was mostly white
 * and the two scopes — this server, this repository — looked identical because
 * they were built from the same three components. A dialog sizes itself, so the
 * density is designed rather than left to whatever the window is; and one left
 * rail can hold both scopes as two groups, which is the thing neither page could
 * say about itself.
 *
 * DESIGN.md bans modal-as-first-thought. This is the fifth thought, and settings
 * is the one surface here nobody is ever *in*: you come to fix something and go
 * back to the work, which is exactly what closing a dialog does and what
 * navigating back from a view does not.
 *
 * Behaviour is Radix (硬约束 4): focus trap, Esc, restored focus, aria wiring.
 */

export type Section =
  | "cred" | "github" | "host" | "server" | "skills"
  | "sched" | "models" | "turn" | "boxdefaults" | "notify"
  | "prefs" | "gates" | "sandbox" | "remove";

/** Host facts only. The credential rows are the 账号 section, said once. */
const isCredential = (c: HostCheck) => c.name.startsWith("credential:");

const NAV: Array<{ key: Section; zh: string; icon: typeof KeyRound; project?: true }> = [
  // 凭据 named the storage, not the thing: what is picked here is which account
  // the fleet works as, and the boss thinks of it as an account. 模型账号 rather
  // than 模型, because which model runs a turn is `roles/*.yaml` and
  // `difficultyModel` — one word for two things sends people here for the wrong
  // control.
  { key: "cred", zh: "模型账号", icon: KeyRound },
  // Its own section, not a row in 模型账号. Those are interchangeable, metered,
  // one per role and about to be six; this is one connection, not metered, with
  // a two-step flow and a repository list. Named GitHub rather than 代码源
  // because there is only GitHub, and the day there is a second one, renaming a
  // nav item is one string.
  { key: "github", zh: "GitHub", icon: GitBranch },
  { key: "host", zh: "环境", icon: MonitorCog },
  { key: "server", zh: "沙盒服务器", icon: Server },
  // This machine's skills, not this project's: the same staged directory is
  // mounted into every group of every project.
  { key: "skills", zh: "技能", icon: Sparkles },
  // The operating knobs, which used to be a yaml inside the release tarball.
  // Three sections rather than one, because forty rows in one list is a list
  // nobody reads to the bottom of — and the three answer different questions:
  // how much runs at once, what it costs, how long one turn may take.
  { key: "sched", zh: "调度", icon: Gauge },
  { key: "models", zh: "模型与预算", icon: Coins },
  { key: "turn", zh: "turn 与上下文", icon: Timer },
  // Under 沙盒服务器, because it is the same subject one level down: that pane is
  // the process, this is what it is told to build. A project's own 沙盒 pane
  // overrides these; nothing overrides them for a project that says nothing.
  { key: "boxdefaults", zh: "沙盒默认值", icon: Box },
  { key: "notify", zh: "通知", icon: Bell },
  { key: "prefs", zh: "偏好", icon: SlidersHorizontal },
  { key: "gates", zh: "闸门", icon: ListChecks, project: true },
  { key: "sandbox", zh: "沙盒", icon: Box, project: true },
  // Last, alone, and the only irreversible thing in this dialog. Nowhere near
  // the switches somebody flips while working.
  { key: "remove", zh: "移除项目", icon: Trash2, project: true },
];

export function SettingsDialog({
  open, onOpenChange, initial, onSection, projectId, projectName, groupCount, onRemoved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Which section the hash asks for, and it keeps asking: the left rail writes
   *  its choice back, or a reload lands on whichever pane the link was for
   *  rather than the one that was being read. */
  initial: Section;
  onSection?: (s: Section) => void;
  projectId: number | null;
  projectName?: string;
  /** How many requirements go with it. Evidence for the one button that erases. */
  groupCount?: number;
  onRemoved?: () => void;
}) {
  const [section, setSection] = useState<Section>(initial);
  useEffect(() => setSection(initial), [initial]);
  const pick = (k: Section) => {
    setSection(k);
    onSection?.(k);
  };
  const [busy, setBusy] = useState(false);
  /**
   * The login in flight: which account, what its row said before it started, and
   * when to give up asking.
   *
   * `since` is what ends it. A login that has landed is a row with a newer
   * `updatedAt` than the one we started from — the panel polled on a timer alone
   * before, so the credential arrived, the row updated, and both buttons stayed
   * "等你在浏览器里批准…" for the rest of the five minutes.
   */
  const [signin, setSignin] = useState<{ runtime: string; since: number; until: number } | null>(null);

  const queries = useQueryClient();
  // A credential landing changes more than the row it landed on: 主机 goes green
  // and the header's readiness with it. Invalidating the lot rather than listing
  // them is safe here — this fires when a human clicks 保存, not on a timer.
  const load = () => void queries.invalidateQueries();

  /**
   * Three reads, three keys, and the project is *in* one of them.
   *
   * This was one `load()` closing over `projectId`, fired from an effect on
   * `[open, projectId]` with nothing to say which call a reply belonged to. Two
   * quick project switches and the slower reply won: this dialog rendered one
   * project's 闸门 and another's base branch, with no error anywhere. `lib/api.ts`
   * had already been bitten by exactly this and grown a `lastProject` ref to
   * remember the scope by hand. A key does not have to remember — a reply for
   * project 3 cannot be written into project 7's entry, so the bug has no shape.
   *
   * `refetchInterval` on the credential read is the login poll. A CLI login lands
   * in another window and stores the credential the moment it exits; the only
   * missing piece is the panel noticing, and two seconds is well inside the time
   * it takes to click through an OAuth screen.
   */
  const auth = useQuery({
    queryKey: ["auth"],
    queryFn: () => pull<{ runtimes: AuthRow[]; trailers: { claudeCoauthor: boolean } }>("/api/auth"),
    enabled: open,
    refetchInterval: signin ? 2000 : false,
  });
  const preflight = useQuery({
    queryKey: ["preflight"],
    queryFn: () => pull<{ checks: HostCheck[] }>("/api/preflight"),
    enabled: open,
  });
  const project = useQuery({
    queryKey: ["project", projectId, "config"],
    queryFn: () => pull<ProjectConfig>(`/api/project/${projectId}/config`),
    enabled: open && projectId !== null,
  });
  const rows = auth.data?.runtimes ?? [];
  const prefs = auth.data?.trailers;
  const checks = preflight.data?.checks ?? [];
  const proj = projectId === null ? null : (project.data ?? null);

  /** It landed. Stop asking, and give the button back. */
  useEffect(() => {
    if (!signin) return;
    const row = rows.find((r) => r.runtime === signin.runtime);
    if (row && row.updatedAt > signin.since) setSignin(null);
    // `auth.data`, not `rows`: TanStack hands back the same object while the
    // answer is unchanged, and `rows` is a fresh array on every render.
  }, [auth.data, signin]);

  /**
   * It did not land, and the window is long gone.
   *
   * On its own clock rather than folded into the check above, because that one
   * only runs when the answer *changes* — and a login that never completes is
   * precisely the case where the answer never changes. The button would have
   * stayed "等你在浏览器里批准…" for the rest of the session.
   */
  useEffect(() => {
    if (!signin) return;
    const t = setTimeout(() => setSignin(null), Math.max(0, signin.until - Date.now()));
    return () => clearTimeout(t);
  }, [signin]);

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    await post(`/api/project/${projectId}/config`, body);
    setBusy(false);
    void queries.invalidateQueries({ queryKey: ["project", projectId] });
  };

  const items = NAV.filter((n) => !n.project || projectId);
  const here = items.some((n) => n.key === section) ? section : "cred";
  // What is waiting on the boss, on the item that holds it. Same dot as the one on
  // the gear in the header, which is where they saw it before they clicked.
  const nags: Partial<Record<Section, boolean>> = {
    cred: RUNTIMES.some((r) => !rows.some((x) => x.runtime === r.key)),
    host: checks.some((c) => !isCredential(c) && !c.ok),
    gates: !!proj && !(proj.config.gates ?? []).length,
  };
  const title = items.find((n) => n.key === here)?.zh ?? "设置";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-[var(--scrim)]" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 grid h-[min(36rem,84vh)] w-[min(58rem,94vw)]
                     -translate-x-1/2 -translate-y-1/2 grid-cols-[13rem_minmax(0,1fr)] overflow-hidden
                     rounded-xl border border-rule bg-paper shadow-[0_12px_40px_var(--shade)] fade-in
                     max-[44rem]:grid-cols-1 max-[44rem]:grid-rows-[auto_minmax(0,1fr)]"
        >
          {/* The scope is the grouping, not a sentence on each page explaining
              which of the two it is. */}
          <nav className="flex min-h-0 flex-col gap-4 overflow-y-auto border-r border-rule bg-rail px-2.5 py-4">
            <Group label="服务器" note="所有项目共用">
              {items.filter((n) => !n.project).map((n) => (
                <Item key={n.key} n={n} on={here === n.key} nag={!!nags[n.key]} go={() => pick(n.key)} />
              ))}
            </Group>
            {projectId && (
              // Same shape as 服务器 above it: the group names the scope, the small
              // line says which one, and the path is a hover away.
              <Group label="项目" note={projectName} hint={proj?.repoPath}>
                {items.filter((n) => n.project).map((n) => (
                  <Item key={n.key} n={n} on={here === n.key} nag={!!nags[n.key]} go={() => pick(n.key)} />
                ))}
              </Group>
            )}
          </nav>

          {/* The label column is set once, here, rather than per pane. Three panes
              had picked three widths, so switching between them moved every value
              sideways — and a width chosen inside a pane is a width the next pane
              cannot know about. 5rem holds the longest label in the dialog
              (基线分支, API 密钥). */}
          <div className="flex min-h-0 flex-col px-6 pt-4 pb-5 [--label:5rem]">
            <Dialog.Title className="sr-only">{title}</Dialog.Title>
            <Dialog.Close
              aria-label="关掉"
              className="absolute top-3 right-3 grid size-6.5 cursor-pointer place-items-center rounded-md
                         text-ink-3 transition-colors hover:bg-sunk hover:text-ink"
            >
              <X size={14} strokeWidth={1.75} />
            </Dialog.Close>

            <Pane>
              {here === "cred" ? (
                <CredPane
                  rows={rows}
                  prefs={prefs}
                  waiting={signin?.runtime}
                  onSaved={load}
                  onWaitForLogin={(runtime, since) =>
                    setSignin({ runtime, since, until: Date.now() + 300_000 })
                  }
                />
              ) : here === "github" ? (
                <GithubPane />
              ) : here === "host" ? (
                <Env checks={checks.filter((c) => !isCredential(c))} />
              ) : here === "server" ? (
                <ServerPane current={rows.find((x) => x.runtime === "sandbox")} checks={checks} onSaved={load} />
              ) : here === "skills" ? (
                <Skills projectId={projectId} />
              ) : here === "sched" || here === "models" || here === "turn" || here === "boxdefaults" || here === "notify" ? (
                <Knobs section={here} />
              ) : here === "prefs" ? (
                <>
                  <Head title="偏好" note="只在这台机器上，不跟着项目走" />
                  <FieldGroup>
                    {/* A toggle group has nothing a `<label>` can point at, so the
                        row names itself: `Field` is already `role="group"`, and
                        this is the one attribute that gives that group a name. */}
                    <Field aria-labelledby="pref-theme">
                      <FieldTitle id="pref-theme">主题</FieldTitle>
                      <FieldContent>
                        <ThemeChoice />
                      </FieldContent>
                    </Field>
                  </FieldGroup>
                </>
              ) : proj ? (
                here === "gates" ? (
                  <Gates d={proj} patch={patch} />
                ) : here === "remove" ? (
                  <Remove
                    projectId={projectId!}
                    name={projectName ?? proj.repoPath}
                    repoPath={proj.repoPath}
                    groups={groupCount ?? 0}
                    onRemoved={() => {
                      onOpenChange(false);
                      onRemoved?.();
                    }}
                  />
                ) : (
                  <Sandbox d={proj} busy={busy} patch={patch} />
                )
              ) : (
                <Meta className="block py-2">读取中…</Meta>
              )}
            </Pane>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Group({
  label, note, hint, children,
}: {
  label: string;
  note?: string;
  /** The long version, on hover. Never `title=`: see ui/tooltip.tsx. */
  hint?: string;
  children: React.ReactNode;
}) {
  // A project's origin is a place you can go, so it is a link rather than a
  // hover string. The tooltip is the fallback for a row migration 037 could not
  // convert — it still holds a path, and that is still where it points.
  const href = repoHref(hint);
  const line = <Meta className="mb-1.5 block truncate px-2">{note}</Meta>;
  return (
    <div>
      <H2 className="mb-1 truncate px-2">{label}</H2>
      {/* One line under the label, not two. The project's own name sat on top of
          its owner/repo, and owner/repo is the one that says which checkout — the
          name is already in the header trail two inches away. */}
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="mb-1.5 block truncate px-2 text-[0.6875rem] text-ink-3 hover:text-accent hover:underline"
        >
          {hint}
        </a>
      ) : (
        note && (hint ? <Tip label={hint}>{line}</Tip> : line)
      )}
      {children}
    </div>
  );
}

function Item({
  n, on, nag, go,
}: {
  n: { key: Section; zh: string; icon: typeof KeyRound };
  on: boolean;
  nag: boolean;
  go: () => void;
}) {
  const Icon = n.icon;
  return (
    <button
      onClick={go}
      aria-current={on}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[0.8125rem]",
        "transition-colors",
        // Weight as well as fill: hover is also a tint, and two states that differ
        // only by opacity are two states nobody can tell apart.
        on ? "bg-sunk font-medium text-ink" : "text-ink-3 hover:bg-sunk/60 hover:text-ink",
      )}
    >
      <Icon size={14} strokeWidth={1.75} className="shrink-0" />
      <span className="truncate">{n.zh}</span>
      <span className="grow" />
      {nag && <i className="size-1.5 shrink-0 rounded-full bg-accent" aria-label="有事等你" />}
    </button>
  );
}

interface GhStatus {
  connected: boolean;
  account: string | null;
  /** Stored, and GitHub no longer answers for it. */
  stale: boolean;
  /** Authorized, but the app is installed nowhere it could read. `null` = could not tell. */
  installed: boolean | null;
  installUrl: string | null;
  /** Where it is installed, and how many repositories each one can see. */
  accounts: { id: number; account: string; kind: string; repos: number | null }[];
  pending: { userCode: string; verificationUri: string } | null;
  error: string | null;
  /** What every commit carries besides its message. Both default on. */
  trailers: { signoff: boolean; coauthor: boolean };
  /** Who commits are authored as: the connected login, or the bot until there is one. */
  identity: { name: string; email: string };
  bot: { name: string; email: string };
}

/**
 * Connect GitHub the way GitHub Desktop does: a code, a browser tab, nothing pasted.
 *
 * The code is the whole interaction, so it is the largest thing on the row and it
 * is one click away from the clipboard — a login code the boss has to hunt for in
 * a paragraph is a broken login. The button next to it opens the page it goes in,
 * because those two facts are useless apart.
 */
function GithubPane() {
  const [busy, setBusy] = useState(false);
  const queries = useQueryClient();

  /**
   * Two ways this answer goes stale, and neither of them happens on this page.
   *
   * Installing the app happens on github.com, in another window, and the panel
   * had fetched once — so it went on saying "not installed anywhere" over a
   * backend that already knew better. Focus is the event that means "they are
   * back", and `refetchOnWindowFocus` is on by default, so the listener this
   * used to register is not code anybody here has to own.
   *
   * The device-code flow is the other one: poll while a code is outstanding,
   * stop the moment the token arrives. `false` is how `refetchInterval` says
   * stop, and `s?.pending` going null is the same condition the `clearInterval`
   * used to be spelled with.
   */
  const gh = useQuery({
    queryKey: ["gh"],
    queryFn: () => pull<GhStatus>("/api/auth/github"),
    refetchInterval: (q) => (q.state.data?.pending ? 3000 : false),
  });
  const s = gh.data ?? null;
  const load = () => void queries.invalidateQueries({ queryKey: ["gh"] });

  const connect = async () => {
    setBusy(true);
    await post("/api/auth/github", {});
    setBusy(false);
    void load();
  };

  const pending = s?.pending;
  return (
    <>
      {/* 真令牌不进沙盒 is already the note on 模型账号, and a sentence repeated on
          two panes stops being read on either. */}
      <Head title="GitHub" note="代码从这儿来" />

      <section>
        <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {!s ? (
            <Meta>读取中…</Meta>
          ) : !s.connected ? (
            <span className="text-[0.8125rem] font-medium text-accent">没连</span>
          ) : s.stale ? (
            <span className="text-[0.8125rem] font-medium text-accent">连过，但 GitHub 现在不认这个令牌了</span>
          ) : s.installed === false ? (
            // Authorized and installed are different acts, and only the second one
            // can reach a repository. Saying 已连 here would be a green tick over a
            // repo list that can never fill.
            <span className="text-[0.8125rem] font-medium text-accent">
              {s.account ? `@${s.account} 授权了` : "授权了"}，但 App 还没装到任何账号上
            </span>
          ) : (
            <span className="text-[0.8125rem]">
              {s.account ? `@${s.account}` : "已连"}
            </span>
          )}
          <span className="grow" />
          {s?.connected && (
            <Button
              size="sm"
              variant="quiet"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await post("/api/auth", { runtime: "github", clear: true });
                setBusy(false);
                void load();
              }}
            >
              断开
            </Button>
          )}
          {/* A dead token is a stuck state, so the way out is on the row that says
              so — not behind 断开 first. */}
          {s && (!s.connected || s.stale) && (
            <Button size="sm" disabled={busy || !!pending} onClick={connect}>
              {pending ? "等你在 GitHub 上批准…" : busy ? "去拿登录码…" : s.stale ? "重新连接" : "连接 GitHub"}
            </Button>
          )}
        </div>
        {/* What the pane's own title and note already say — 克隆私有仓库、推分支、
            开 PR — is cut. What is left is the part that is not obvious. */}
        <Meta className="block">一个连接管所有项目</Meta>

        {pending && <DeviceCode code={pending.userCode} url={pending.verificationUri} go="去 GitHub 输入" />}

        {/* Why it did not land, beside the button that tries again. */}
        {!pending && s?.error && <p className="mt-1.5 text-[0.75rem] text-accent">{s.error}</p>}
      </section>

      {/* Which accounts this login can actually work in, and how much each one
          can see. The boss asked "how do I install to several orgs" because the
          panel could not show that this is a list at all.

          No rule above it: the heading and the gap are the boundary. A rule here
          was the same token as the one inside the list below, so the section and
          its rows were drawn with the same mark. */}
      {s?.connected && !s.stale && (
        <section className="mt-6">
          <div className="flex items-baseline gap-2">
            <H2>装在哪些账号上</H2>
            <span className="grow" />
            {s.installUrl ? (
              <LinkButton href={s.installUrl} className="px-2 py-0.5 text-[0.75rem]">
                装到别的账号
              </LinkButton>
            ) : (
              <Tip label="config/default.yaml 里填上 github.appSlug，这里就是个直达链接。">
                <Meta>去 GitHub → 这个 App → Install App</Meta>
              </Tip>
            )}
          </div>
          {!s.accounts.length ? (
            <p className="text-[0.75rem] text-accent">
              一个也没有，这个连接看不见任何仓库。装的时候选所有仓库，或者挑几个。
            </p>
          ) : (
            /* Between the rows only. The enclosing pair made this the one list in
               the dialog wearing a frame, which is the mark a section boundary is
               supposed to be. */
            <div className="divide-y divide-rule-soft">
              {s.accounts.map((a) => (
                <div key={a.id} className="flex items-baseline gap-2 py-1.5">
                  <span className="text-[0.8125rem]">{a.account}</span>
                  <Badge>{a.kind === "Organization" ? "组织" : "个人"}</Badge>
                  <span className="grow" />
                  {/* Tabular figures: `86` and `5` share a right edge either way,
                      but proportional digits make the two counts look like two
                      different scales. */}
                  <Meta className="tabular-nums">{a.repos === null ? "数不出来" : `${a.repos} 个仓库`}</Meta>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Under the connection because both answers come from it: the author is
          this login, and these are conventions of the repositories it reaches. */}
      {s && <Commits s={s} onSaved={load} />}
    </>
  );
}

/**
 * What every commit this system writes carries besides its message.
 *
 * Here rather than in the yaml: they are decisions about a repository's
 * conventions, and the person making them is looking at this page. Both default
 * on — a repository with DCO refuses an unsigned commit at the last step of a
 * finished branch, and a diff an agent wrote should say so in the record.
 */
function Commits({ s, onSaved }: { s: GhStatus; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const set = async (next: { signoff?: boolean; coauthor?: boolean }) => {
    setBusy(true);
    await post("/api/git/trailers", next);
    setBusy(false);
    onSaved();
  };
  const bot = s.identity.name === s.bot.name;
  return (
    <section className="mt-6">
      <H2>提交</H2>
      <FieldGroup>
        {/* The author, stated rather than configured. It was a name in a yaml file
            that routed nowhere, so a `Signed-off-by` carrying it certified nothing
            and a reviewer clicking it got a 404.

            A row in the group rather than a sentence above it: it is the third
            fact about a commit, it shares the label column with the two switches,
            and the name stops being 11px mono Chinese prose with one word tinted
            darker. `role="group"` is already on `Field`; this names it. */}
        <Field aria-labelledby="t-author" className="items-center">
          <FieldTitle id="t-author">作者</FieldTitle>
          <FieldContent>
            <span className="font-mono text-[0.75rem] text-ink-2">{s.identity.name}</span>
            <Meta>{bot ? "还没连 GitHub，先用我们的机器人账号" : "取自你连的 GitHub 账号"}</Meta>
          </FieldContent>
        </Field>
        <Field className="items-center">
          <FieldLabel htmlFor="t-signoff">Sign-off</FieldLabel>
          <FieldContent>
            <Switch
              id="t-signoff"
              checked={s.trailers.signoff}
              disabled={busy}
              onCheckedChange={(v) => void set({ signoff: v })}
            />
            <Meta>开了 DCO 的仓库不收没有这行的提交</Meta>
          </FieldContent>
        </Field>
        <Field className="items-center">
          <FieldLabel htmlFor="t-coauthor">Co-author</FieldLabel>
          <FieldContent>
            <Switch
              id="t-coauthor"
              checked={s.trailers.coauthor}
              disabled={busy}
              onCheckedChange={(v) => void set({ coauthor: v })}
            />
            <Meta>把 {s.bot.name} 写进 Co-Authored-By</Meta>
          </FieldContent>
        </Field>
      </FieldGroup>
    </section>
  );
}

/** Can this machine build a sandbox at all. Four facts, one line each. */
function Env({ checks }: { checks: HostCheck[] }) {
  return (
    <>
      <Head title="环境" note="沙盒要用的" />
      {!checks.length && <Meta className="block py-2">读取中…</Meta>}
      {/* One idiom for row rules across the dialog: the list draws them, not the
          rows, so there is no `first:` exception to forget. */}
      <div className="divide-y divide-rule-soft">
        {checks.map((c) => (
          <div key={c.name} className="py-2">
            <div className="flex items-baseline gap-2">
              {c.ok ? (
                <Check size={12} strokeWidth={2.5} className="shrink-0 translate-y-0.5 text-ok" />
              ) : (
                <CircleAlert size={12} strokeWidth={2.5} className="shrink-0 translate-y-0.5 text-accent" />
              )}
              <span className={cn("text-[0.8125rem]", !c.ok && "text-accent")}>{c.name}</span>
              <Meta className="min-w-0 truncate">{c.detail}</Meta>
            </div>
            {/* Only the broken one gets the room: the command that fixes it. */}
            {!c.ok && c.fix && (
              <span className="mt-1 ml-5 block rounded-md bg-sunk px-2 py-1 font-mono text-[0.6875rem] leading-relaxed text-ink-2">
                {c.fix}
              </span>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

interface ServerInfo {
  running: boolean;
  /** Which address we drive. Overridable, because the default may be taken. */
  addr: string;
  /** Plain HTTP to a host that is neither loopback nor an encrypted overlay. */
  inClear: boolean;
  /**
   * Which of the three cases this is, and it decides which control is offered:
   * a server we did not start is one we may report on and never act on.
   */
  state: "ours" | "theirs" | "stuck" | "started" | "down";
  why: string | null;
  pid: string | null;
  config: string | null;
  argv: string[];
  /** True only for a server this orchestrator started. */
  restartable: boolean;
  /** Host paths our mounts need that the running config will not allow. */
  drift: { want: string[]; config: string } | null;
  containers: number;
  runningTurns: number;
}

/** One line each, because the difference between them is what to do next. */
const SERVER_STATE: Record<ServerInfo["state"], { zh: string; ok: boolean }> = {
  ours: { zh: "在跑，我们起的", ok: true },
  started: { zh: "刚起好", ok: true },
  theirs: { zh: "在跑，不是我们起的，直接用", ok: true },
  stuck: { zh: "在跑，但我们驱动不了", ok: false },
  down: { zh: "没在跑", ok: false },
};

/**
 * Is the container server up, is its config still right, and how we reach it.
 *
 * One component, because it was two and the seam was visible: a status section
 * closed with its own rule, the key's field group opened with another one four
 * pixels below it, and a counter was threaded between them so that changing the
 * key made the status re-ask instead of going on saying 在跑，直接用 over a key
 * the server has never heard of. Merged, the re-ask is a function call and the
 * two settings share one field table.
 *
 * The order is what the eye needs in the order it needs it: which of five states
 * this is and the one button for it, why if why adds anything, then the only
 * thing on this pane that fails silently, then the two values that are merely
 * settings. It read as five equal blocks before, and a status line has to win.
 *
 * `allowed_host_paths` is the most valuable thing on the pane and it is not a
 * control: when the allowlist stops covering the staged skills directory nothing
 * fails loudly — every container mounts an empty directory instead, and the
 * agents simply do not have the skills the boss ticked. Preflight builds the
 * exact line to paste, so it is rendered selectable rather than described.
 *
 * The key is read rather than invented: it is what stands between a local port
 * and "create a container", and a key made up on this side is one the server has
 * never heard of — which this panel cannot restart the server to teach it. 从服务器读
 * takes it out of the server's own config, server-side, so the value never
 * reaches the browser.
 */
function ServerPane(props: { current?: AuthRow; checks: HostCheck[]; onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const queries = useQueryClient();
  const server = useQuery({ queryKey: ["sandbox-server"], queryFn: () => pull<ServerInfo>("/api/sandbox-server") });
  const image = useQuery({ queryKey: ["sandbox-images"], queryFn: () => pull<{ current: string }>("/api/sandbox/images") });
  const d = server.data ?? null;
  const img = image.data?.current ?? "";
  const load = () => void queries.invalidateQueries({ queryKey: ["sandbox-server"] });

  const paths = props.checks.find((c) => c.name === "allowed_host_paths");
  const st = d ? SERVER_STATE[d.state] : null;
  // Two identifiers for one process, on one line. They were a Meta beside the
  // status and a Meta three rows below it, and neither is a fact you read on the
  // way to something else.
  const ident = [d?.pid && d.pid !== "?" ? `pid ${d.pid}` : null, d?.config].filter(Boolean).join(" · ");

  const restart = async () => {
    const yes = await ask({
      title: "重启沙盒服务器？",
      // The evidence beside the button: this is not a service bounce, it is
      // every container going away and every turn inside them dying with it.
      body:
        `所有容器都会没：${d?.containers ?? 0} 个组的沙盒，还有 ${d?.runningTurns ?? 0} 个正在跑的 turn。` +
        `\n\n没跑完的 turn 就白跑了，组会自己重开容器接着做，代码和分支不受影响。`,
      yes: "重启",
      danger: true,
    });
    if (!yes) return;
    setBusy(true);
    const r = await post("/api/sandbox-server/restart", {});
    setBusy(false);
    void load();
    if (r.ok) toast.success("重启了，容器会按需重开");
  };

  const start = async () => {
    setBusy(true);
    const r = await post("/api/sandbox-server/start", {});
    setBusy(false);
    void load();
    if (r.ok) toast.success("起来了");
  };

  /**
   * Adopt, replace or clear, and then ask the server again.
   *
   * The re-ask is the point of the merge: whether we can drive the server is a
   * function of the key, and clearing the key while the line above still reads
   * 在跑，直接用 is the shape this project keeps paying for — a stale answer that
   * looks like a healthy one.
   */
  const sendKey = async (body: Record<string, unknown>) => {
    setBusy(true);
    const res = await post("/api/auth", { runtime: "sandbox", ...body });
    setBusy(false);
    // Only on success. A rejected key wiped from the box makes the fix "paste it
    // again", which is never the fix.
    if (res.ok) setKey("");
    void load();
    props.onSaved();
  };

  return (
    <>
      <Head title="沙盒服务器" note="开容器的那个服务" />

      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {st ? (
          <>
            {st.ok ? (
              <Check size={12} strokeWidth={2.5} className="shrink-0 translate-y-0.5 text-ok" />
            ) : (
              <CircleAlert size={12} strokeWidth={2.5} className="shrink-0 translate-y-0.5 text-accent" />
            )}
            <span className={cn("text-[0.8125rem]", !st.ok && "text-accent")}>{st.zh}</span>
          </>
        ) : (
          <Meta>读取中…</Meta>
        )}
        <span className="grow" />
        {/* One control per state, and the two we must not offer are the point.
            A server we did not start is not ours to restart: killing it takes
            down whatever else on this machine was using it, and "we cannot
            drive it" is not evidence that nobody can. */}
        {d?.state === "down" ? (
          <Button size="sm" variant="go" disabled={busy} onClick={start}>
            {busy ? "起中…" : "起一个"}
          </Button>
        ) : d?.restartable ? (
          <Button size="sm" disabled={busy} onClick={restart}>
            {busy ? "重启中…" : "重启"}
          </Button>
        ) : d ? (
          <Tip label="这个进程不是我们起的，可能是你自己在用的那个。要重启就自己重启，之后这里会认得它。">
            <Button size="sm" disabled>
              重启
            </Button>
          </Tip>
        ) : null}
      </div>

      {/* Under the line it explains, indented past the icon, and only when it
          adds something — `没在跑` was rendering twice, once as the status and
          once as its own reason, which reads as a stuck panel. It was a bordered
          box on `sunk` too: a frame around one sentence, on the surface reserved
          for what a machine produced. */}
      {d?.why && d.why !== st?.zh && (
        <p className="mt-1 ml-5 text-[0.75rem] leading-relaxed text-ink-2">{d.why}</p>
      )}
      {ident && <Meta className="mt-1 ml-5 block truncate">{ident}</Meta>}

      {/* Silent when wrong, so it is loud here: a path missing from the
          allowlist mounts an empty directory rather than failing. */}
      {(d?.drift || (paths && !paths.ok)) && (
        <div className="mt-2.5 rounded-md bg-sunk px-3 py-2">
          <div className="text-[0.8125rem] text-accent">
            {d?.drift ? "配置里没允许我们要挂的路径" : paths!.detail}
          </div>
          <p className="mt-1 text-[0.75rem] text-ink-3">
            容器不报错，只挂个空目录，勾上的技能就这么没了。把这行写进配置，然后重启：
          </p>
          <pre className="mt-1.5 overflow-x-auto font-mono text-[0.6875rem] leading-relaxed text-ink-2 select-all">
            {d?.drift
              ? `allowed_host_paths = [${d.drift.want.map((p) => `"${p}"`).join(", ")}]`
              : paths?.fix?.split("\n").slice(-1)[0]!.trim()}
          </pre>
        </div>
      )}

      {/* The status band above is one section, these two values are another, and
          the gap is what says so. */}
      <FieldGroup className="mt-6">
        {/* The other way out of "that one is not ours", and the reason this is a
            control rather than a yaml key: the fix for a taken port is a
            different port, and an edit-and-restart is not a fix you make while
            reading this. */}
        <Field>
          <FieldLabel htmlFor="sb-addr">地址</FieldLabel>
          {/* A column, because the warning under the box is a third child and a
              two-column grid put it in the label gutter. */}
          <FieldContent className="flex-col items-stretch gap-1">
            <Input
              id="sb-addr"
              className="font-mono"
              placeholder="127.0.0.1:8080 或 https://host:port"
              defaultValue={d?.addr ?? ""}
              onKeyDown={async (e) => {
                if (e.key !== "Enter") return;
                const v = (e.target as HTMLInputElement).value;
                const r = await post("/api/sandbox-server/addr", { addr: v });
                void load();
                if (r.ok) toast.success(v.trim() ? `改成 ${v.trim()} 了` : "改回配置文件里的了");
              }}
            />
            {/* The server does not have to be on this machine — a Tailscale peer
                or a cloud box works. Over WireGuard plain HTTP is fine, which is
                why this warns rather than refuses: on the open internet the
                api_key and every container payload cross it in the clear. */}
            {d?.inClear && (
              <span className="text-[0.75rem] text-accent">
                不在本机，也不在加密内网，走的还是明文 http。密钥和容器流量都是裸的，用 https 或者 Tailscale。
              </span>
            )}
          </FieldContent>
        </Field>

        {/* One default for the machine, so registering a repository needs no
            answer here at all: a new project sets no image and gets this one,
            the same way it gets the remote's default branch without being
            asked. The per-project row overrides it and is usually left alone. */}
        <ImageRow
          label="默认镜像"
          value={img}
          busy={busy}
          placeholder="新项目默认用它，留空跟配置文件"
          onSave={async (v) => {
            setBusy(true);
            const r = await post("/api/sandbox/images", { image: v });
            setBusy(false);
            if (r.ok) {
              // Re-read rather than assume: what the row shows is the server's
              // answer, and a write that was accepted is not a write that stored
              // this exact string.
              void queries.invalidateQueries({ queryKey: ["sandbox-images"] });
              toast.success(v ? `以后新项目都用 ${v}` : "改回配置文件里的了");
            }
          }}
        />

        <Field>
          <FieldLabel htmlFor="sandbox-key">密钥</FieldLabel>
          <InputGroup>
            <Input
              id="sandbox-key"
              className="min-w-0 flex-1 font-mono"
              // What is stored, in the box that stores it — same as the accounts.
              placeholder={props.current ? `已存 ${props.current.hint}，粘新的就换掉` : "留空 = 服务器没开鉴权"}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            {/* The server owns this value, so it is read rather than invented. */}
            <Tip label="从沙盒服务器自己的配置里读（OPENSANDBOX_CONFIG、./sandbox.toml、~/.sandbox.toml）。值不经过浏览器。">
              <Button size="sm" disabled={busy} onClick={() => void sendKey({ mode: "api_key", adopt: true })}>
                从服务器读
              </Button>
            </Tip>
            {/* A key nobody told the server about locks the whole fleet out, and
                until this button existed there was no way back from the panel
                that put it there. */}
            {props.current && (
              <Button size="sm" variant="quiet" disabled={busy} onClick={() => void sendKey({ clear: true })}>
                清掉
              </Button>
            )}
            {/* Only once there is something to save, same as every other field in
                this dialog. A button that is always there and usually does
                nothing trains you to ignore it. */}
            {key.trim() && (
              <Button
                variant="go"
                size="sm"
                disabled={busy}
                onClick={() => void sendKey({ mode: "api_key", secret: key.trim() })}
              >
                存下
              </Button>
            )}
          </InputGroup>
        </Field>
      </FieldGroup>
      {/* No "now put this in the server's config" line: that instruction is what
          got followed halfway, and a key only this side knows locks the fleet out
          of every container. 存下 refuses a key the server rejects. */}
    </>
  );
}

/**
 * The one irreversible thing in this dialog, and the only place in the panel
 * that deletes rather than archives.
 *
 * 不做了 winds a requirement up and keeps every event, because what a group did
 * is the record. Removing a project is the boss saying they do not want the
 * record either — a different act, so it lives on its own page, behind its own
 * confirm, in the danger colour, and never next to a switch somebody flips while
 * working.
 *
 * The confirm carries what it costs (硬约束 5): how many requirements go with
 * it, and — the one thing a boss would be right to fear — that nothing on GitHub
 * is touched. The branches and PRs stay exactly where they are.
 */
function Remove({
  projectId, name, repoPath, groups, onRemoved,
}: {
  projectId: number;
  name: string;
  repoPath: string;
  groups: number;
  onRemoved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    const yes = await ask({
      title: `移除 ${name}？`,
      body:
        `${repoPath} 的 ${groups} 个需求、它们的容器、卡片、记录和附件都会删掉，删了找不回来。\n\n` +
        `GitHub 上什么都不动：分支还在，PR 还在，代码一行不少。移除的只是这台机器上的这份工作。`,
      yes: "移除",
      danger: true,
    });
    if (!yes) return;
    setBusy(true);
    const r = await del(`/api/projects/${projectId}`);
    setBusy(false);
    if (r.ok) onRemoved();
  };

  return (
    <>
      <Head title="移除项目" />
      {/* Two columns, one measure: what goes, what stays. It was one paragraph of
          running prose across the full panel, and a destructive decision read as
          an essay puts all the weight on the button being red. The confirm still
          says it in sentences — this is the part you scan before clicking. */}
      {/* Same left edge as every field row in the dialog: the boss arrives here
          from a pane of labelled values, and a column that moves between panes
          is the one thing a fixed grid is for. */}
      <dl className="grid max-w-[34rem] grid-cols-[var(--label)_minmax(0,1fr)] gap-x-4 gap-y-3 pt-1 text-[0.8125rem]">
        <dt className="font-semibold text-bad">删掉</dt>
        <dd className="min-w-0">
          <span className="font-mono text-[0.75rem]">{repoPath}</span> 的 {groups} 个需求
          <div className="mt-0.5 text-[0.75rem] text-ink-3">
            在跑的 turn 会停，容器、切片、卡片、提问、附件一起删，找不回来
          </div>
        </dd>
        <dt className="font-semibold text-ok">留着</dt>
        <dd className="min-w-0 text-ink-2">
          GitHub 上的分支、PR、代码
          {/* 不做了 archives and keeps every event. This does not, and the two
              buttons are one dialog apart. */}
          <div className="mt-0.5 text-[0.75rem] text-ink-3">想留下记录就用「不做了」封存，那个不删</div>
        </dd>
      </dl>
      <Button variant="danger" className="mt-5" disabled={busy} onClick={go}>
        {busy ? "移除中…" : "移除这个项目"}
      </Button>
    </>
  );
}
