import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell, Box, Coins, Gauge, GitBranch, KeyRound, ListChecks, MonitorCog, Server,
  SlidersHorizontal, Sparkles, Timer, Trash2, X,
} from "lucide-react";
import { H2, Head, Meta, Pane } from "../ui/bits";
import { Field, FieldContent, FieldGroup, FieldTitle } from "../ui/field";
import { Tip } from "../ui/tooltip";
import { pull, post } from "../lib/api";
import { Knobs } from "./knobs";
import { cn, repoHref } from "../lib/utils";
import { ThemeChoice } from "../ui/theme";
import type { ProjectConfig } from "./project";
import { Skills } from "./skills";
import { CredPane, RUNTIMES } from "./settings/credentials";
import { EnvPane, ServerPane, type ServerInfo } from "./settings/environment";
import { GithubPane, type GhStatus } from "./settings/github";
import { ProjectPane, type ProjectSection } from "./settings/project";
import { type AuthRow, type HostCheck } from "./settings/shared";

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
  /**
   * GitHub changes in another window too: device authorization while a code is
   * pending, and App installation when focus returns. Keep that coordination in
   * the dialog shell; the pane only owns the controls that start those actions.
   */
  const gh = useQuery({
    queryKey: ["gh"],
    queryFn: () => pull<GhStatus>("/api/auth/github"),
    enabled: open && section === "github",
    refetchInterval: (q) => (q.state.data?.pending ? 3000 : false),
  });
  const refreshGh = () => void queries.invalidateQueries({ queryKey: ["gh"] });
  const sandboxServer = useQuery({
    queryKey: ["sandbox-server"],
    queryFn: () => pull<ServerInfo>("/api/sandbox-server"),
    enabled: open && section === "server",
  });
  const sandboxImages = useQuery({
    queryKey: ["sandbox-images"],
    queryFn: () => pull<{ current: string }>("/api/sandbox/images"),
    enabled: open && section === "server",
  });
  const refreshServer = () => void queries.invalidateQueries({ queryKey: ["sandbox-server"] });
  const refreshImages = () => void queries.invalidateQueries({ queryKey: ["sandbox-images"] });
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
  const projectSection: ProjectSection | null =
    here === "gates" || here === "sandbox" || here === "remove" ? here : null;

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
                <GithubPane status={gh.data ?? null} onRefresh={refreshGh} />
              ) : here === "host" ? (
                <EnvPane checks={checks.filter((c) => !isCredential(c))} />
              ) : here === "server" ? (
                <ServerPane
                  current={rows.find((x) => x.runtime === "sandbox")}
                  checks={checks}
                  server={sandboxServer.data ?? null}
                  image={sandboxImages.data?.current ?? ""}
                  onRefreshServer={refreshServer}
                  onRefreshImages={refreshImages}
                  onSaved={load}
                />
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
              ) : proj && projectSection ? (
                <ProjectPane
                  section={projectSection}
                  data={proj}
                  busy={busy}
                  projectId={projectId!}
                  projectName={projectName}
                  groupCount={groupCount ?? 0}
                  patch={patch}
                  onRemoved={() => {
                    onOpenChange(false);
                    onRemoved?.();
                  }}
                />
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
