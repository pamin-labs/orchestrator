import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import {
  Box, Check, CircleAlert, Coins, Gauge, GitBranch, KeyRound, ListChecks, MonitorCog, Server,
  SlidersHorizontal, Sparkles, Timer, Trash2, X,
} from "lucide-react";
import { H2, Head, Input, Meta, Pane, Textarea } from "../ui/bits";
import { Field, FieldContent, FieldGroup, FieldLabel, FieldTitle, InputGroup } from "../ui/field";
import { Button, LinkButton } from "../ui/button";
import { toast } from "sonner";
import { Segment, Segments } from "../ui/segment";
import { Switch } from "../ui/switch";
import { Badge } from "../ui/badge";
import { Tip } from "../ui/tooltip";
import { ask } from "../ui/confirm";
import { pull, post, del } from "../lib/api";
import { Knobs } from "./knobs";
import { clock, cn, repoHref } from "../lib/utils";
import { ThemeChoice } from "../ui/theme";
import { Gates, ImageRow, Sandbox, type ProjectConfig } from "./project";
import { Skills } from "./skills";

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

type Mode = "oauth_token" | "api_key" | "chatgpt";
export type Section =
  | "cred" | "github" | "host" | "server" | "skills"
  | "sched" | "models" | "turn"
  | "prefs" | "gates" | "sandbox" | "remove";

interface AuthRow {
  runtime: string;
  mode: Mode;
  hint: string;
  baseUrl?: string;
  updatedAt: number;
}

interface HostCheck {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

interface Runtime {
  key: string;
  label: string;
  /** The mode this machine can obtain by running the CLI itself. */
  login?: Mode;
  modes: Array<{ mode: Mode; label: string; how: string; cost: string }>;
  urlEnv: string;
}

const RUNTIMES: Runtime[] = [
  {
    key: "claude",
    label: "Claude",
    login: "oauth_token",
    urlEnv: "ANTHROPIC_BASE_URL",
    modes: [
      { mode: "oauth_token", label: "订阅", how: "容器里跑 claude setup-token", cost: "一年有效" },
      { mode: "api_key", label: "API 密钥", how: "console.anthropic.com", cost: "不显示额度" },
    ],
  },
  {
    key: "codex",
    label: "Codex",
    login: "chatgpt",
    urlEnv: "OPENAI_BASE_URL",
    modes: [
      { mode: "chatgpt", label: "订阅", how: "在容器里登录，本机不用装 codex", cost: "本机统一刷新" },
      { mode: "api_key", label: "API 密钥", how: "platform.openai.com", cost: "不显示额度" },
    ],
  },
];

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
  const [rows, setRows] = useState<AuthRow[]>([]);
  const [prefs, setPrefs] = useState<{ claudeCoauthor?: boolean }>({});
  const [checks, setChecks] = useState<HostCheck[]>([]);
  const [proj, setProj] = useState<ProjectConfig | null>(null);
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

  const load = async () => {
    const [a, p, c] = await Promise.all([
      pull<{ runtimes: AuthRow[]; trailers: { claudeCoauthor: boolean } }>("/api/auth"),
      pull<{ checks: HostCheck[] }>("/api/preflight"),
      projectId ? pull<ProjectConfig>(`/api/project/${projectId}/config`) : Promise.resolve(null),
    ]);
    setRows(a?.runtimes ?? []);
    setPrefs(a?.trailers ?? {});
    setChecks(p?.checks ?? []);
    setProj(c);
  };
  useEffect(() => {
    if (open) void load();
  }, [open, projectId]);

  /**
   * A login lands in another window, so nothing here can know when.
   *
   * The CLI stores the credential itself the moment it exits; the only missing
   * piece is the panel noticing. Two seconds is well inside the time it takes to
   * click through an OAuth screen, and the window closes on its own — a poll
   * that runs forever is a poll somebody has to remember to stop.
   */
  useEffect(() => {
    if (!signin) return;
    const t = setInterval(() => {
      if (Date.now() > signin.until) setSignin(null);
      else void load();
    }, 2000);
    return () => clearInterval(t);
  }, [signin]);

  /** It landed. Stop asking, and give the button back. */
  useEffect(() => {
    if (!signin) return;
    const row = rows.find((r) => r.runtime === signin.runtime);
    if (row && row.updatedAt > signin.since) setSignin(null);
  }, [rows, signin]);

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    await post(`/api/project/${projectId}/config`, body);
    setBusy(false);
    void load();
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
                <>
                  <Head title="模型账号" note="真令牌不进沙盒" />
                  {RUNTIMES.map((r) => (
                    <Credential
                      key={r.key}
                      runtime={r}
                      current={rows.find((x) => x.runtime === r.key)}
                      // Only the account being logged into. One flag for both meant
                      // a claude login also froze codex's button for five minutes.
                      waiting={signin?.runtime === r.key}
                      claudeCoauthor={r.key === "claude" ? (prefs.claudeCoauthor ?? true) : undefined}
                      onSaved={load}
                      onWaitForLogin={(since) =>
                        setSignin({ runtime: r.key, since, until: Date.now() + 300_000 })
                      }
                    />
                  ))}
                </>
              ) : here === "github" ? (
                <GithubPane />
              ) : here === "host" ? (
                <Env checks={checks.filter((c) => !isCredential(c))} />
              ) : here === "server" ? (
                <ServerPane current={rows.find((x) => x.runtime === "sandbox")} checks={checks} onSaved={load} />
              ) : here === "skills" ? (
                <Skills projectId={projectId} />
              ) : here === "sched" || here === "models" || here === "turn" ? (
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

/**
 * One account: what is stored, how it is paid for, and the two things to paste.
 *
 * The mode sits on the title line because it is what this account *is* — a field
 * called 怎么拿 with a selector, a command and a price crammed into one row was
 * four facts wearing one label. One save at the end covers the token and the base
 * URL together: they are one credential, and hanging 存下 off the URL row while
 * disabling it unless a token was typed meant a gateway address could not be
 * changed on its own.
 */
function Credential(props: {
  runtime: Runtime;
  current?: AuthRow;
  /** A login is in flight; the page is asking every couple of seconds. */
  waiting: boolean;
  /** Claude Code's own commit trailer. Only this runtime has one. */
  claudeCoauthor?: boolean;
  onSaved: () => void;
  onWaitForLogin: (since: number) => void;
}) {
  const r = props.runtime;
  const cur = props.current;
  const [mode, setMode] = useState<Mode>(cur?.mode ?? r.modes[0]!.mode);
  const [secret, setSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState(cur?.baseUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  /** codex's device login: a code, a link, and when it stops being either. */
  const [device, setDevice] = useState<{ code: string; url: string; expiresAt: number } | null>(null);
  /** claude's: the code goes the other way, from that page back to the CLI. */
  const [paste, setPaste] = useState("");
  const spec = r.modes.find((m) => m.mode === mode) ?? r.modes[0]!;
  const dirty = !!secret.trim() || baseUrl.trim() !== (cur?.baseUrl ?? "");
  // The OAuth address is worth showing until the credential it fetches arrives,
  // and not one render longer.
  useEffect(() => {
    setLink(null);
    setDevice(null);
  }, [cur?.updatedAt]);
  // Stop showing a code that has stopped working. An expired code that still
  // looks live is the same failure as a panel saying the app is not installed
  // after it has been.
  useEffect(() => {
    if (!device) return;
    const t = setTimeout(() => setDevice(null), Math.max(0, device.expiresAt - Date.now()));
    return () => clearTimeout(t);
  }, [device?.expiresAt]);
  /**
   * What is stored, in the box that stores it.
   *
   * The secret itself never comes back from the server, so the box is empty after
   * a login and read as "nothing was saved". The masked tail is what the boss has
   * to tell two tokens apart, and it belongs where the value would be — the same
   * mode's row is the only place it is now said.
   */
  const held = cur?.mode === mode ? `已存 ${cur.hint}，粘新的就换掉` : null;

  const save = async () => {
    setBusy(true);
    const res = await post("/api/auth", {
      runtime: r.key,
      mode,
      secret: secret.trim(),
      baseUrl: baseUrl.trim() || undefined,
    });
    setBusy(false);
    // Only on success. A rejected token used to be wiped from the box while a
    // toast explained why it was rejected, so the fix was to paste it again.
    if (res.ok) setSecret("");
    props.onSaved();
  };

  /**
   * Sign in, whichever way this runtime does it.
   *
   * Both run the official CLI in the utility container — nothing is installed on
   * this machine and nothing forges an OAuth exchange. They differ in what the
   * boss does with the page: codex prints a code to type there, claude prints a
   * code to bring back, so claude gets the input below.
   */
  const sendCode = async () => {
    const code = paste.trim();
    if (!code) return;
    setBusy(true);
    const res = await post("/api/auth/claude/login/code", { code });
    setBusy(false);
    if (res.ok) setPaste("");
  };

  const signIn = async () => {
    setBusy(true);
    const res = await post(r.key === "codex" ? "/api/auth/codex/device" : "/api/auth/claude/login", {});
    setBusy(false);
    if (!res.ok) return;
    const got = JSON.parse(res.text);
    if (r.key === "codex") setDevice(got);
    // Not opened from here. The CLI opens the browser itself, so doing it too
    // gives the boss two tabs of the same OAuth flow — and finishing the wrong
    // one leaves the other waiting forever.
    else setLink(got.url ?? null);
    props.onWaitForLogin(cur?.updatedAt ?? 0);
  };

  return (
    <section className="mt-6 first:mt-0">
      <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-display text-[0.9375rem] font-semibold">{r.label}</span>
        {cur ? (
          <>
            {/* Which mode is stored is only worth a word when it is not the one
                being looked at: the pressed segment on the right already says
                that, and a label repeating it is the same fact 30rem apart.
                When they differ it is the whole point of the row. */}
            {cur.mode !== mode && (
              <span className="text-[0.75rem] text-ink-2">
                存的是{r.modes.find((m) => m.mode === cur.mode)?.label ?? cur.mode}
              </span>
            )}
            {/* The masked tail is in the box it was pasted into, not here as well. */}
            <Meta>{clock(cur.updatedAt)}</Meta>
          </>
        ) : (
          <span className="text-[0.75rem] font-medium text-accent">没配</span>
        )}
        <span className="grow" />
        <Segments value={mode} onValueChange={(v) => setMode(v as Mode)}>
          {r.modes.map((m) => (
            <Segment key={m.mode} value={m.mode}>
              {m.label}
            </Segment>
          ))}
        </Segments>
      </div>
      {/* How to get one, and what it costs — instructions for a decision already
          made. An account that is configured and sitting on its own mode needs
          none of it, and two accounts each explaining themselves is most of the
          pane's height spent on the case where there is nothing to do. */}
      {(!cur || cur.mode !== mode) && (
        <Meta className="mb-1.5 block">
          {spec.how} · {spec.cost}
        </Meta>
      )}

      {/* The gap the group's own top rule used to stand in for. */}
      <FieldGroup className="mt-1.5">
        <Field orientation={mode === "chatgpt" ? "vertical" : "horizontal"}>
          {/* The label is what this mode calls the thing. It said `token` under an
              API key too, which is two words for one field. */}
          {mode === "chatgpt" ? (
            <span className="flex items-center gap-2">
              <FieldLabel htmlFor={`${r.key}-secret`} className="text-ink-3">
                auth.json
              </FieldLabel>
              <span className="grow" />
              {/* Beside the label, because the box below is a block and the button
                  is the other way to fill it. */}
              {r.login === mode && <Login busy={busy} waiting={props.waiting} onClick={signIn} />}
            </span>
          ) : (
            <FieldLabel htmlFor={`${r.key}-secret`} className="text-ink-3">
              {mode === "api_key" ? "API 密钥" : "令牌"}
            </FieldLabel>
          )}
          {mode === "chatgpt" ? (
            <Textarea
              id={`${r.key}-secret`}
              className="min-h-16"
              placeholder={held ?? "~/.codex/auth.json 的完整内容"}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          ) : (
            <InputGroup>
              <Input
                id={`${r.key}-secret`}
                type="password"
                className="min-w-0 flex-1 font-mono"
                placeholder={held ?? "粘贴进来，存下之后看不到"}
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
              {/* The alternative to pasting, next to the box it replaces. */}
              {r.login === mode && <Login busy={busy} waiting={props.waiting} onClick={signIn} />}
            </InputGroup>
          )}
        </Field>

        {device && (
          <Field orientation="vertical">
            <DeviceCode code={device.code} url={device.url} go="去 ChatGPT 输入" />
            <div className="mt-1.5 flex items-baseline gap-2">
              {/* The real expiry, not a remembered one. `15 分钟` was written into
                  the copy while `expiresAt` sat two lines up driving the timer
                  that clears this block. */}
              <Meta>到 {clock(device.expiresAt)} 前有效</Meta>
              <span className="grow" />
              <Button
                size="sm"
                variant="quiet"
                onClick={async () => {
                  await post("/api/auth/codex/device/cancel", {});
                  setDevice(null);
                }}
              >
                取消
              </Button>
            </div>
          </Field>
        )}

        {link && (
          <>
            <Field>
              {/* Not a FieldLabel: there is no control on this row to focus, and a
                  label pointing at nothing is what a screen reader reads out. */}
              <FieldTitle className="text-ink-3">登录页</FieldTitle>
              {/* One line: the address is 400 characters of PKCE and nobody reads
                  it. It stays selectable for the case where the browser that opened
                  it is not the one you want to log in with. */}
              <span className="flex min-w-0 items-baseline gap-2">
                <a
                  href={link}
                  target="_blank"
                  rel="noopener"
                  className="shrink-0 text-[0.75rem] text-accent underline"
                >
                  打开登录页
                </a>
                <Meta className="min-w-0 truncate">{link}</Meta>
              </span>
            </Field>
            {/* The half that has no equivalent in the codex flow. `claude
                setup-token` sits at `Paste code here` until something answers,
                and the only thing that can is the boss — hard constraint 5: the
                thing to do next is beside the evidence for doing it. */}
            <Field orientation="vertical">
              <FieldLabel htmlFor={`${r.key}-code`} className="text-ink-3">
                页面给的码
              </FieldLabel>
              <InputGroup>
                <Input
                  id={`${r.key}-code`}
                  className="min-w-0 flex-1 font-mono"
                  placeholder="批准完那一页会给一串码，贴这儿"
                  value={paste}
                  onChange={(e) => setPaste(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void sendCode();
                  }}
                />
                <Button size="sm" disabled={busy || !paste.trim()} onClick={() => void sendCode()}>
                  交上去
                </Button>
              </InputGroup>
              {/* No validity line here: this flow hands back no expiry, and the
                  one that was written in said 10 分钟 on nothing. */}
              <div className="mt-1.5 flex items-baseline gap-2">
                <span className="grow" />
                <Button
                  size="sm"
                  variant="quiet"
                  onClick={async () => {
                    await post("/api/auth/claude/login/cancel", {});
                    setLink(null);
                    setPaste("");
                  }}
                >
                  取消
                </Button>
              </div>
            </Field>
          </>
        )}

        <Field>
          <FieldLabel htmlFor={`${r.key}-url`} className="text-ink-3">
            API 地址
          </FieldLabel>
          <FieldContent className="flex-col items-stretch gap-1">
            <Input
              id={`${r.key}-url`}
              className="font-mono"
              placeholder={`可选，自建网关 → ${r.urlEnv}`}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            {/* Under the address that causes it, not under the account. Usage is
                only ever read from the provider's own endpoint, so a gateway
                account has no window to show and the header would look broken
                rather than deliberate. */}
            {mode !== "api_key" && baseUrl.trim() && (
              <Meta className="block">自建网关，头部不显示额度</Meta>
            )}
          </FieldContent>
        </Field>

        {/* Beside the account, because it is a setting for this CLI rather than
            for this project's history — the git trailers are in the GitHub pane
            and they are a different decision. Left alone the CLI adds this to
            any commit an agent makes by hand, and until now nothing in the panel
            could reach it. */}
        {props.claudeCoauthor !== undefined && (
          <Field className="items-center">
            <FieldLabel htmlFor="claude-coauthor" className="text-ink-3">
              Co-author
            </FieldLabel>
            <FieldContent>
              <Switch
                id="claude-coauthor"
                checked={props.claudeCoauthor}
                disabled={busy}
                onCheckedChange={async (v) => {
                  setBusy(true);
                  await post("/api/git/trailers", { claudeCoauthor: v });
                  setBusy(false);
                  props.onSaved();
                }}
              />
              <Meta>Claude Code 自己提交时写进 Co-Authored-By</Meta>
            </FieldContent>
          </Field>
        )}
      </FieldGroup>

      <div className="mt-2 flex items-center gap-2">
        <span className="grow" />
        {cur && (
          <Button
            size="sm"
            variant="quiet"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await post("/api/auth", { runtime: r.key, clear: true });
              setBusy(false);
              setSecret("");
              setBaseUrl("");
              props.onSaved();
            }}
          >
            清掉
          </Button>
        )}
        {/* Only once there is something to save, same as every other field here. */}
        {dirty && (
          <Button variant="go" size="sm" disabled={busy} onClick={save}>
            存下
          </Button>
        )}
      </div>
    </section>
  );
}

/**
 * A device code, the way both flows show one.
 *
 * The code is the interaction, not the link: the link alone opens a page asking
 * for a code the boss does not have. Large, monospace, wide tracking because it
 * is typed into another window character by character, and one click from the
 * clipboard.
 */
function DeviceCode({ code, url, go }: { code: string; url: string; go: string }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-3 rounded-md bg-sunk px-3 py-2.5">
      <code className="font-mono text-[1.375rem] leading-none font-semibold tracking-[0.3em] select-all">{code}</code>
      <Button
        size="sm"
        variant="quiet"
        onClick={() => {
          void navigator.clipboard.writeText(code);
          toast.success("登录码复制好了");
        }}
      >
        复制
      </Button>
      <span className="grow" />
      <LinkButton href={url} className="px-2 py-0.5 text-[0.75rem]">
        {go}
      </LinkButton>
    </div>
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
  const [s, setS] = useState<GhStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => setS(await pull<GhStatus>("/api/auth/github"));

  /**
   * Look again when the boss comes back.
   *
   * Installing the app happens on github.com, in another window, and the panel
   * had fetched once — so it went on saying "not installed anywhere" over a
   * backend that already knew better. Focus is the event that means "they are
   * back"; a timer is either slower than the person staring at the screen or
   * spends the hour's request budget on nothing.
   */
  useEffect(() => {
    const back = () => void load();
    window.addEventListener("focus", back);
    return () => window.removeEventListener("focus", back);
  }, []);
  useEffect(() => {
    void load();
  }, []);

  /**
   * The authorisation lands in another window, so nothing here can know when.
   *
   * Same shape as the CLI logins above: poll while there is a code outstanding,
   * stop the moment the token arrives. The server is the one actually polling
   * GitHub; this only notices.
   */
  useEffect(() => {
    if (!s?.pending) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [s?.pending?.userCode]);

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

/**
 * Run the official CLI's login and keep what it hands back.
 *
 * Both runtimes now go through the utility container — `codex login
 * --device-auth` and `claude setup-token` under a pty. The real CLI does the
 * whole OAuth exchange either way; nothing here forges one.
 */
function Login({ busy, waiting, onClick }: { busy: boolean; waiting: boolean; onClick: () => void }) {
  return (
    <Tip label="在工具容器里跑一次官方 CLI 的登录，拿到的凭据存在这儿。本机什么都不用装。仅限官方账号；自建网关走 API key。">
      <Button size="sm" disabled={busy || waiting} onClick={onClick}>
        {busy || waiting ? "等你在浏览器里批准…" : "登录"}
      </Button>
    </Tip>
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
  const [d, setD] = useState<ServerInfo | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [img, setImg] = useState("");
  const load = async () => setD(await pull<ServerInfo>("/api/sandbox-server"));
  useEffect(() => {
    void pull<{ current: string }>("/api/sandbox/images").then((r) => setImg(r?.current ?? ""));
  }, []);
  useEffect(() => {
    void load();
  }, []);

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
              setImg(v);
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
