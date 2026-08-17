import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  Box,
  Coins,
  Gauge,
  GitBranch,
  KeyRound,
  ListChecks,
  MonitorCog,
  Server,
  SlidersHorizontal,
  Sparkles,
  Timer,
  Trash2,
  X,
} from "lucide-react";
import { H2, Head, Meta, Pane } from "../ui/bits";
import { Field, FieldContent, FieldGroup, FieldTitle } from "../ui/field";
import { Tip } from "../ui/tooltip";
import { api, mutate, readApi } from "../lib/api";
import { Knobs } from "./knobs";
import { cn, repoHref } from "../lib/utils";
import { ThemeChoice } from "../ui/theme";
import { ImageChoicesSchema, ProjectConfigSchema, type ProjectPatch } from "./project";
import { Skills } from "./skills";
import { CredPane, RUNTIMES } from "./settings/credentials";
import { EnvPane, ServerInfoSchema, ServerPane } from "./settings/environment";
import { GithubPane, GhStatusSchema } from "./settings/github";
import { ProjectPane, type ProjectSection } from "./settings/project";
import { AuthRowSchema, HostCheckSchema, type AuthRow, type HostCheck } from "./settings/shared";
import { z } from "zod";
import type { InferResponseType } from "hono/client";

const AuthResponseSchema: z.ZodType<InferResponseType<typeof api.auth.$get, 200>> = z.object({
  runtimes: z.array(AuthRowSchema),
  trailers: z.object({ signoff: z.boolean(), coauthor: z.boolean(), claudeCoauthor: z.boolean() }),
});
const PreflightResponseSchema: z.ZodType<InferResponseType<typeof api.preflight.$get, 200>> = z.object({
  checks: z.array(HostCheckSchema),
});
type Signin = { runtime: string; since: number; until: number };
type AuthResponse = z.infer<typeof AuthResponseSchema>;
const EMPTY_AUTH: AuthResponse = {
  runtimes: [],
  trailers: { signoff: false, coauthor: false, claudeCoauthor: false },
};
const EMPTY_PREFLIGHT = { checks: [] as HostCheck[] };

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
 * docs/design/ui.md bans modal-as-first-thought. This is the fifth thought, and settings
 * is the one surface here nobody is ever *in*: you come to fix something and go
 * back to the work, which is exactly what closing a dialog does and what
 * navigating back from a view does not.
 *
 * Behaviour is Radix (硬约束 4): focus trap, Esc, restored focus, aria wiring.
 */

export const SectionSchema = z.enum([
  "cred",
  "github",
  "host",
  "server",
  "skills",
  "sched",
  "models",
  "turn",
  "boxdefaults",
  "notify",
  "prefs",
  "gates",
  "sandbox",
  "remove",
]);
export type Section = z.infer<typeof SectionSchema>;

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

const PROJECT_SECTIONS = new Set<Section>(["gates", "sandbox", "remove"]);
const NO_SECTION_CHANGE = (_section: Section): void => {};
const NO_REMOVAL = (): void => {};

export function SettingsDialog({
  open,
  onOpenChange,
  initial,
  onSection = NO_SECTION_CHANGE,
  projectId,
  projectName,
  groupCount,
  onRemoved = NO_REMOVAL,
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
    onSection(k);
  };
  const here = projectId === null && PROJECT_SECTIONS.has(section) ? "cred" : section;

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
          <Dialog.Title className="sr-only">{NAV.find((n) => n.key === here)!.zh}</Dialog.Title>
          <Dialog.Close
            aria-label="关掉"
            className="absolute top-3 right-3 grid size-6.5 cursor-pointer place-items-center rounded-md
                       text-ink-3 transition-colors hover:bg-sunk hover:text-ink"
          >
            <X size={14} strokeWidth={1.75} />
          </Dialog.Close>
          <SettingsContent
            open={open}
            section={here}
            onSection={pick}
            projectId={projectId}
            {...(projectName !== undefined ? { projectName } : {})}
            groupCount={groupCount ?? 0}
            onOpenChange={onOpenChange}
            onRemoved={onRemoved}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SettingsContent({
  open,
  section,
  onSection,
  projectId,
  projectName,
  groupCount,
  onOpenChange,
  onRemoved,
}: {
  open: boolean;
  section: Section;
  onSection: (section: Section) => void;
  projectId: number | null;
  projectName?: string;
  groupCount: number;
  onOpenChange: (open: boolean) => void;
  onRemoved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [signin, setSignin] = useState<Signin | null>(null);

  const queries = useQueryClient();
  // A credential landing changes more than the row it landed on: 主机 goes green
  // and the header's readiness with it. Invalidating the lot rather than listing
  // them is safe here — this fires when a human clicks 保存, not on a timer.
  const load = () => void queries.invalidateQueries();

  const { authData, rows, prefs, checks, proj } = useSettingsData(open, projectId, signin);
  useSigninEnd(authData, signin, setSignin);

  const patch = async (body: ProjectPatch) => {
    setBusy(true);
    await mutate(api.project[":id"].config.$post({ param: { id: String(projectId) }, json: body }));
    setBusy(false);
    void queries.invalidateQueries({ queryKey: ["project", projectId] });
  };

  const items = NAV.filter((n) => !n.project || projectId !== null);

  return (
    <>
      {/* The scope is the grouping, not a sentence on each page explaining
          which of the two it is. */}
      <SettingsNavigation
        items={items}
        section={section}
        rows={rows}
        checks={checks}
        projectId={projectId}
        {...(projectName !== undefined ? { projectName } : {})}
        project={proj}
        onSection={onSection}
      />

      {/* The label column is set once, here, rather than per pane. Three panes
          had picked three widths, so switching between them moved every value
          sideways — and a width chosen inside a pane is a width the next pane
          cannot know about. 5rem holds the longest label in the dialog
          (基线分支, API 密钥). */}
      <div className="flex min-h-0 flex-col px-6 pt-4 pb-5 [--label:5rem]">
        <SettingsPanes
          open={open}
          section={section}
          rows={rows}
          {...(prefs !== undefined ? { prefs } : {})}
          signin={signin}
          checks={checks}
          proj={proj}
          projectId={projectId}
          {...(projectName !== undefined ? { projectName } : {})}
          groupCount={groupCount}
          busy={busy}
          patch={patch}
          onSaved={load}
          onWaitForLogin={(runtime, since) => setSignin({ runtime, since, until: Date.now() + 300_000 })}
          onOpenChange={onOpenChange}
          onRemoved={onRemoved}
        />
      </div>
    </>
  );
}

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
function useSettingsData(open: boolean, projectId: number | null, signin: Signin | null) {
  const { data: authData = EMPTY_AUTH } = useQuery({
    queryKey: ["auth"],
    queryFn: async () => (await readApi(api.auth.$get(), AuthResponseSchema)) ?? EMPTY_AUTH,
    enabled: open,
    refetchInterval: signin ? 2000 : false,
  });
  const { data: preflightData = EMPTY_PREFLIGHT } = useQuery({
    queryKey: ["preflight"],
    queryFn: async () => (await readApi(api.preflight.$get(), PreflightResponseSchema)) ?? EMPTY_PREFLIGHT,
    enabled: open,
  });
  const { data: proj = null } = useQuery({
    queryKey: ["project", projectId, "config"],
    queryFn: () => readApi(api.project[":id"].config.$get({ param: { id: String(projectId) } }), ProjectConfigSchema),
    enabled: open && projectId !== null,
  });
  const { runtimes: rows, trailers: prefs } = authData;
  return { authData, rows, prefs, checks: preflightData.checks, proj };
}

/**
 * Ends a login in flight, on either outcome.
 *
 * Landed: a login that has arrived is a row with a newer `updatedAt` than the
 * one we started from — the panel polled on a timer alone before, so the
 * credential arrived, the row updated, and both buttons stayed
 * "等你在浏览器里批准…" for the rest of the five minutes.
 *
 * Timed out: on its own clock rather than folded into the landed check, because
 * that one only runs when the answer *changes* — and a login that never
 * completes is precisely the case where the answer never changes.
 */
function useSigninEnd(authData: AuthResponse, signin: Signin | null, setSignin: (s: Signin | null) => void) {
  useEffect(() => {
    if (!signin) return;
    const row = authData.runtimes.find((r) => r.runtime === signin.runtime);
    // `authData`, not `rows`: TanStack hands back the same object while the
    // answer is unchanged, and `rows` is a fresh array on every render.
    if (row && row.updatedAt > signin.since) setSignin(null);
  }, [authData, signin, setSignin]);
  useEffect(() => {
    if (!signin) return;
    const t = setTimeout(() => setSignin(null), Math.max(0, signin.until - Date.now()));
    return () => clearTimeout(t);
  }, [signin, setSignin]);
}

/** The right-hand pane for the current section. One record, not a switch. */
function SettingsPanes({
  open,
  section,
  rows,
  prefs,
  signin,
  checks,
  proj,
  projectId,
  projectName,
  groupCount,
  busy,
  patch,
  onSaved,
  onWaitForLogin,
  onOpenChange,
  onRemoved,
}: {
  open: boolean;
  section: Section;
  rows: AuthRow[];
  prefs?: z.infer<typeof AuthResponseSchema>["trailers"];
  signin: Signin | null;
  checks: HostCheck[];
  proj: z.infer<typeof ProjectConfigSchema> | null;
  projectId: number | null;
  projectName?: string;
  groupCount: number;
  busy: boolean;
  patch: (body: ProjectPatch) => Promise<void>;
  onSaved: () => void;
  onWaitForLogin: (runtime: string, since: number) => void;
  onOpenChange: (open: boolean) => void;
  onRemoved: () => void;
}) {
  const projectPane = (projectSection: ProjectSection) =>
    proj && projectId !== null ? (
      <ProjectPane
        section={projectSection}
        data={proj}
        busy={busy}
        projectId={projectId}
        {...(projectName !== undefined ? { projectName } : {})}
        groupCount={groupCount}
        patch={patch}
        onRemoved={() => {
          onOpenChange(false);
          onRemoved();
        }}
      />
    ) : (
      <Meta className="block py-2">读取中…</Meta>
    );

  const panes: Record<Section, React.ReactNode> = {
    cred: (
      <CredPane
        rows={rows}
        {...(prefs !== undefined ? { prefs } : {})}
        {...(signin ? { waiting: signin.runtime } : {})}
        onSaved={onSaved}
        onWaitForLogin={onWaitForLogin}
      />
    ),
    github: <GithubSettings open={open} section={section} />,
    host: <EnvPane checks={checks.filter((c) => !isCredential(c))} />,
    server: <SandboxServerSettings open={open} section={section} rows={rows} checks={checks} onSaved={onSaved} />,
    skills: <Skills projectId={projectId} />,
    sched: <Knobs section="sched" />,
    models: <Knobs section="models" />,
    turn: <Knobs section="turn" />,
    boxdefaults: <Knobs section="boxdefaults" />,
    notify: <Knobs section="notify" />,
    prefs: <Preferences />,
    gates: projectPane("gates"),
    sandbox: projectPane("sandbox"),
    remove: projectPane("remove"),
  };
  return <Pane>{panes[section]}</Pane>;
}

/**
 * GitHub changes in another window too: device authorization while a code is
 * pending, and App installation when focus returns. Keep that coordination in
 * the dialog shell; the pane only owns the controls that start those actions.
 */
function GithubSettings({ open, section }: { open: boolean; section: Section }) {
  const queries = useQueryClient();
  const { data: status = null } = useQuery({
    queryKey: ["gh"],
    queryFn: () => readApi(api.auth.github.$get(), GhStatusSchema),
    enabled: open && section === "github",
    refetchInterval: (q) => (q.state.data?.pending ? 3000 : false),
  });
  const refresh = () => void queries.invalidateQueries({ queryKey: ["gh"] });
  return <GithubPane status={status} onRefresh={refresh} />;
}

function SandboxServerSettings({
  open,
  section,
  rows,
  checks,
  onSaved,
}: {
  open: boolean;
  section: Section;
  rows: AuthRow[];
  checks: HostCheck[];
  onSaved: () => void;
}) {
  const queries = useQueryClient();
  const enabled = open && section === "server";
  const { data: server = null } = useQuery({
    queryKey: ["sandbox-server"],
    queryFn: () => readApi(api["sandbox-server"].$get(), ServerInfoSchema),
    enabled: open && section === "server",
  });
  const { data: images } = useQuery({
    queryKey: ["sandbox-images"],
    queryFn: () => readApi(api.sandbox.images.$get(), ImageChoicesSchema),
    enabled,
  });
  const refreshServer = () => void queries.invalidateQueries({ queryKey: ["sandbox-server"] });
  const refreshImages = () => void queries.invalidateQueries({ queryKey: ["sandbox-images"] });
  const current = rows.find((row) => row.runtime === "sandbox");

  return (
    <ServerPane
      {...(current ? { current } : {})}
      checks={checks}
      server={server}
      image={images ? images.current : ""}
      onRefreshServer={refreshServer}
      onRefreshImages={refreshImages}
      onSaved={onSaved}
    />
  );
}

function Preferences() {
  return (
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
  );
}

export function needsCredentials(rows: AuthRow[]) {
  return RUNTIMES.some((runtime) => !rows.some((row) => row.runtime === runtime.key));
}

export function needsHostAttention(checks: HostCheck[]) {
  return checks.some((check) => !isCredential(check) && !check.ok);
}

export function needsGates(project: { config: { gates?: unknown[] | undefined } } | null) {
  if (!project) return false;
  return !(project.config.gates ?? []).length;
}

function SettingsNavigation({
  items,
  section,
  rows,
  checks,
  projectId,
  projectName,
  project,
  onSection,
}: {
  items: typeof NAV;
  section: Section;
  rows: AuthRow[];
  checks: HostCheck[];
  projectId: number | null;
  projectName?: string;
  project: z.infer<typeof ProjectConfigSchema> | null;
  onSection: (section: Section) => void;
}) {
  // What is waiting on the boss, on the item that holds it. Same dot as the one on
  // the gear in the header, which is where they saw it before they clicked.
  const nags: Partial<Record<Section, boolean>> = {
    cred: needsCredentials(rows),
    host: needsHostAttention(checks),
    gates: needsGates(project),
  };

  return (
    <nav className="flex min-h-0 flex-col gap-4 overflow-y-auto border-r border-rule bg-rail px-2.5 py-4">
      <SettingsGroup
        items={items}
        project={false}
        label="服务器"
        note="所有项目共用"
        section={section}
        nags={nags}
        onSection={onSection}
      />
      {projectId !== null && (
        // Same shape as 服务器 above it: the group names the scope, the small
        // line says which one, and the path is a hover away.
        <SettingsGroup
          items={items}
          project
          label="项目"
          {...(projectName !== undefined ? { note: projectName } : {})}
          {...(project ? { hint: project.repoPath } : {})}
          section={section}
          nags={nags}
          onSection={onSection}
        />
      )}
    </nav>
  );
}

function SettingsGroup({
  items,
  project,
  label,
  note,
  hint,
  section,
  nags,
  onSection,
}: {
  items: typeof NAV;
  project: boolean;
  label: string;
  note?: string;
  hint?: string;
  section: Section;
  nags: Partial<Record<Section, boolean>>;
  onSection: (section: Section) => void;
}) {
  return (
    <Group label={label} {...(note !== undefined ? { note } : {})} {...(hint !== undefined ? { hint } : {})}>
      {items
        .filter((item) => Boolean(item.project) === project)
        .map((item) => (
          <Item
            key={item.key}
            n={item}
            on={section === item.key}
            nag={!!nags[item.key]}
            go={() => onSection(item.key)}
          />
        ))}
    </Group>
  );
}

function Group({
  label,
  note,
  hint,
  children,
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
  n,
  on,
  nag,
  go,
}: {
  n: { key: Section; zh: string; icon: typeof KeyRound };
  on: boolean;
  nag: boolean;
  go: () => void;
}) {
  const Icon = n.icon;
  return (
    <button
      type="button"
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
