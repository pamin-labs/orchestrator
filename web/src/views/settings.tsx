import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import {
  Box, Check, CircleAlert, KeyRound, ListChecks, MonitorCog, Server, SlidersHorizontal, Sparkles, X,
} from "lucide-react";
import { H2, Head, Input, Meta, Pane, Textarea } from "../ui/bits";
import { Field, FieldContent, FieldGroup, FieldLabel, InputGroup } from "../ui/field";
import { Button, LinkButton } from "../ui/button";
import { toast } from "sonner";
import { Segment, Segments } from "../ui/segment";
import { Tip } from "../ui/tooltip";
import { pull, post } from "../lib/api";
import { clock, cn, repoHref } from "../lib/utils";
import { ThemeChoice } from "../ui/theme";
import { Gates, Sandbox, type ProjectConfig } from "./project";
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
export type Section = "cred" | "host" | "server" | "skills" | "prefs" | "gates" | "sandbox";

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
      { mode: "oauth_token", label: "订阅", how: "claude setup-token", cost: "一年有效" },
      { mode: "api_key", label: "API 密钥", how: "console.anthropic.com", cost: "不显示额度" },
    ],
  },
  {
    key: "codex",
    label: "Codex",
    login: "chatgpt",
    urlEnv: "OPENAI_BASE_URL",
    modes: [
      { mode: "chatgpt", label: "订阅", how: "codex login", cost: "本机统一刷新" },
      { mode: "api_key", label: "API 密钥", how: "platform.openai.com", cost: "不显示额度" },
    ],
  },
];

/** Host facts only. The credential rows are the 账号 section, said once. */
const isCredential = (c: HostCheck) => c.name.startsWith("credential:");

const NAV: Array<{ key: Section; zh: string; icon: typeof KeyRound; project?: true }> = [
  // 凭据 named the storage, not the thing: what is picked here is which account
  // the fleet works as, and the boss thinks of it as an account.
  { key: "cred", zh: "账号", icon: KeyRound },
  { key: "host", zh: "环境", icon: MonitorCog },
  { key: "server", zh: "沙盒服务器", icon: Server },
  // This machine's skills, not this project's: the same staged directory is
  // mounted into every group of every project.
  { key: "skills", zh: "技能", icon: Sparkles },
  { key: "prefs", zh: "偏好", icon: SlidersHorizontal },
  { key: "gates", zh: "闸门", icon: ListChecks, project: true },
  { key: "sandbox", zh: "沙盒", icon: Box, project: true },
];

export function SettingsDialog({
  open, onOpenChange, initial, projectId, projectName,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Which section the hash asked for. After that the left rail owns it. */
  initial: Section;
  projectId: number | null;
  projectName?: string;
}) {
  const [section, setSection] = useState<Section>(initial);
  useEffect(() => setSection(initial), [initial]);
  const [rows, setRows] = useState<AuthRow[]>([]);
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
      pull<{ runtimes: AuthRow[] }>("/api/auth"),
      pull<{ checks: HostCheck[] }>("/api/preflight"),
      projectId ? pull<ProjectConfig>(`/api/project/${projectId}/config`) : Promise.resolve(null),
    ]);
    setRows(a?.runtimes ?? []);
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
                <Item key={n.key} n={n} on={here === n.key} nag={!!nags[n.key]} go={() => setSection(n.key)} />
              ))}
            </Group>
            {projectId && (
              // Same shape as 服务器 above it: the group names the scope, the small
              // line says which one, and the path is a hover away.
              <Group label="项目" note={projectName} hint={proj?.repoPath}>
                {items.filter((n) => n.project).map((n) => (
                  <Item key={n.key} n={n} on={here === n.key} nag={!!nags[n.key]} go={() => setSection(n.key)} />
                ))}
              </Group>
            )}
          </nav>

          <div className="flex min-h-0 flex-col px-6 pt-4 pb-5">
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
                  <Head title="账号" note="真令牌不进沙盒" />
                  {RUNTIMES.map((r) => (
                    <Credential
                      key={r.key}
                      runtime={r}
                      current={rows.find((x) => x.runtime === r.key)}
                      // Only the account being logged into. One flag for both meant
                      // a claude login also froze codex's button for five minutes.
                      waiting={signin?.runtime === r.key}
                      onSaved={load}
                      onWaitForLogin={(since) =>
                        setSignin({ runtime: r.key, since, until: Date.now() + 300_000 })
                      }
                    />
                  ))}
                  <Github />
                </>
              ) : here === "host" ? (
                <Env checks={checks.filter((c) => !isCredential(c))} />
              ) : here === "server" ? (
                <SandboxKey current={rows.find((x) => x.runtime === "sandbox")} onSaved={load} />
              ) : here === "skills" ? (
                <Skills projectId={projectId} />
              ) : here === "prefs" ? (
                <>
                  <Head title="偏好" note="只在这台机器上，不跟着项目走" />
                  <FieldGroup>
                    <Field>
                      <FieldLabel>主题</FieldLabel>
                      <FieldContent>
                        <ThemeChoice />
                      </FieldContent>
                    </Field>
                  </FieldGroup>
                </>
              ) : proj ? (
                here === "gates" ? (
                  <Gates d={proj} patch={patch} />
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
  // A GitHub project's origin is a place you can go, so it is a link rather than
  // a hover string. A locally-added one keeps its path on the tooltip, which is
  // still where that project actually is.
  const href = repoHref(hint);
  const line = <Meta className="mb-1.5 block truncate px-2">{note}</Meta>;
  return (
    <div>
      <H2 className="mb-1 truncate px-2">{label}</H2>
      {note && (hint && !href ? <Tip label={hint}>{line}</Tip> : line)}
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="mb-1.5 block truncate px-2 text-[0.6875rem] text-ink-3 hover:text-accent hover:underline"
        >
          {hint}
        </a>
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
  const spec = r.modes.find((m) => m.mode === mode) ?? r.modes[0]!;
  const dirty = !!secret.trim() || baseUrl.trim() !== (cur?.baseUrl ?? "");
  // The OAuth address is worth showing until the credential it fetches arrives,
  // and not one render longer.
  useEffect(() => setLink(null), [cur?.updatedAt]);
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

  const login = async () => {
    setBusy(true);
    setLink(null);
    const res = await post("/api/auth/login", { runtime: r.key });
    let url: string | null = null;
    try {
      url = res.ok ? (JSON.parse(res.text).url ?? null) : null;
    } catch {
      url = null;
    }
    // Not opened from here. Both CLIs open the browser themselves, so doing it
    // too gives the boss two tabs of the same OAuth flow — and finishing the
    // wrong one leaves the other waiting forever.
    setLink(url);
    setBusy(false);
    // The credential arrives on its own once the browser comes back; from here
    // the only job is to notice.
    if (url) props.onWaitForLogin(cur?.updatedAt ?? 0);
    props.onSaved();
  };

  return (
    <section className="border-t border-rule py-3.5 first:border-t-0 first:pt-0">
      <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-display text-[0.9375rem] font-semibold">{r.label}</span>
        {cur ? (
          <>
            <span className="text-[0.75rem] text-ink-2">
              {r.modes.find((m) => m.mode === cur.mode)?.label ?? cur.mode}
            </span>
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
      <Meta className="mb-1.5 block">
        {spec.how} · {spec.cost}
      </Meta>

      <FieldGroup className="[--label:4.5rem]">
        <Field className="py-1.5" orientation={mode === "chatgpt" ? "vertical" : "horizontal"}>
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
              {r.login === mode && <Login busy={busy} waiting={props.waiting} onClick={login} />}
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
              {r.login === mode && <Login busy={busy} waiting={props.waiting} onClick={login} />}
            </InputGroup>
          )}
        </Field>

        {link && (
          <Field className="py-1.5">
            <span className="text-[0.8125rem] text-ink-3">登录页</span>
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
                浏览器没开就点这里
              </a>
              <Meta className="min-w-0 truncate">{link}</Meta>
            </span>
          </Field>
        )}

        <Field className="border-b-0 py-1.5">
          <FieldLabel htmlFor={`${r.key}-url`} className="text-ink-3">
            API 地址
          </FieldLabel>
          <Input
            id={`${r.key}-url`}
            className="min-w-0 flex-1 font-mono"
            placeholder={`可选，自建网关 → ${r.urlEnv}`}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </Field>
      </FieldGroup>

      {/* Said here because a rule enforces it elsewhere: usage is only read from
          the provider's own endpoint, so a gateway account has no window to show
          and the header would look broken rather than deliberate. */}
      {mode !== "api_key" && baseUrl.trim() && (
        <Meta className="mt-1.5 block">自建网关，头部不显示额度</Meta>
      )}

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

interface GhStatus {
  connected: boolean;
  account: string | null;
  /** Stored, and GitHub no longer answers for it. */
  stale: boolean;
  /** Authorized, but the app is installed nowhere it could read. `null` = could not tell. */
  installed: boolean | null;
  installUrl: string | null;
  /** A GitHub App client id is configured at all. */
  configured: boolean;
  pending: { userCode: string; verificationUri: string } | null;
  error: string | null;
}

/**
 * Connect GitHub the way GitHub Desktop does: a code, a browser tab, nothing pasted.
 *
 * The code is the whole interaction, so it is the largest thing on the row and it
 * is one click away from the clipboard — a login code the boss has to hunt for in
 * a paragraph is a broken login. The button next to it opens the page it goes in,
 * because those two facts are useless apart.
 */
function Github() {
  const [s, setS] = useState<GhStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => setS(await pull<GhStatus>("/api/auth/github"));
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
    <section className="border-t border-rule py-3.5">
      <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-display text-[0.9375rem] font-semibold">GitHub</span>
        {!s?.connected ? (
          <span className="text-[0.75rem] font-medium text-accent">没连</span>
        ) : s.stale ? (
          <span className="text-[0.75rem] font-medium text-accent">连过，但 GitHub 现在不认这个令牌了</span>
        ) : s.installed === false ? (
          // Authorized and installed are different acts, and only the second one
          // can reach a repository. Saying 已连 here would be a green tick over a
          // repo list that can never fill.
          <span className="text-[0.75rem] font-medium text-accent">
            {s.account ? `@${s.account} 授权了` : "授权了"}，但 App 还没装到任何仓库上
          </span>
        ) : (
          <span className="text-[0.75rem] text-ink-2">{s.account ? `@${s.account}` : "已连"}</span>
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
        {/* The way out of "authorized but useless", beside the line that says it. */}
        {s?.installed === false &&
          (s.installUrl ? (
            <LinkButton href={s.installUrl} className="px-2 py-0.5 text-[0.75rem]">
              去装上
            </LinkButton>
          ) : (
            <Tip label="config/default.yaml 里填上 github.appSlug，这里就是个直达链接。">
              <Meta>去 GitHub → 这个 App → Install App</Meta>
            </Tip>
          ))}
        {/* A dead token is a stuck state, so the way out is on the row that says
            so — not behind 断开 first. */}
        {(!s?.connected || s.stale) && (
          <Button size="sm" disabled={busy || !!pending} onClick={connect}>
            {pending ? "等你在 GitHub 上批准…" : busy ? "去拿登录码…" : s?.stale ? "重新连接" : "连接 GitHub"}
          </Button>
        )}
      </div>
      <Meta className="mb-1.5 block">
        克隆私有仓库、推分支、开 PR 用的。真令牌不进沙盒，出站时才换上
      </Meta>

      {pending && (
        <div className="mt-2 flex flex-wrap items-center gap-3 rounded-md border border-rule bg-sunk px-3 py-2.5">
          {/* The one thing to read on this screen. Wide tracking because the code
              is typed into another window character by character. */}
          <code className="font-mono text-[1.375rem] leading-none font-semibold tracking-[0.3em] select-all">
            {pending.userCode}
          </code>
          <Button
            size="sm"
            variant="quiet"
            onClick={() => {
              void navigator.clipboard.writeText(pending.userCode);
              toast.success("登录码复制好了");
            }}
          >
            复制
          </Button>
          <span className="grow" />
          <LinkButton href={pending.verificationUri} className="px-2 py-0.5 text-[0.75rem]">
            去 GitHub 输入
          </LinkButton>
        </div>
      )}

      {/* Why it did not land, beside the button that tries again. */}
      {!pending && s?.error && <Meta className="mt-1.5 block text-accent">{s.error}</Meta>}
      {/* Both switches, because both are invisible from here and both fail later
          rather than now — the expiry one works today and is dead tomorrow. */}
      {s && !s.configured && !s.connected && (
        <Meta className="mt-1.5 block">
          还没配 GitHub App：Developer settings → GitHub Apps 建一个，勾上 Enable Device Flow，
          关掉 Optional Features 里的 user token 过期（开着 8 小时就失效，续期要 client secret），
          Client ID 填进 config/default.yaml 的 github.clientId
        </Meta>
      )}
    </section>
  );
}

/** Run the official CLI's login here and keep what it hands back. */
function Login({ busy, waiting, onClick }: { busy: boolean; waiting: boolean; onClick: () => void }) {
  return (
    <Tip label="在这台机器上跑一次官方 CLI 的登录，拿它换出凭据。仅限官方账号；自建网关走 API key。">
      <Button size="sm" disabled={busy || waiting} onClick={onClick}>
        {busy || waiting ? "等你在浏览器里批准…" : "从本机登录"}
      </Button>
    </Tip>
  );
}

/** Can this machine build a sandbox at all. Four facts, one line each. */
function Env({ checks }: { checks: HostCheck[] }) {
  return (
    <>
      <Head title="环境" note="沙盒要用的" />
      {!checks.length && <Meta className="block py-2">检查中…</Meta>}
      {checks.map((c) => (
        <div key={c.name} className="border-t border-rule-soft py-2 first:border-t-0">
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
            <span className="mt-1 ml-5 block rounded bg-sunk px-2 py-1 font-mono text-[0.6875rem] leading-relaxed text-ink-2">
              {c.fix}
            </span>
          )}
        </div>
      ))}
    </>
  );
}

/**
 * The key this orchestrator uses to drive opensandbox-server.
 *
 * Generated rather than typed: a key somebody invents is `orch123`, and this one
 * is what stands between a local port and "create a container". 32 bytes from
 * the platform CSPRNG, base64url so it survives a TOML string.
 */
function SandboxKey(props: { current?: AuthRow; onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);

  /** Read it out of the server's own config, server-side. */
  const adopt = async () => {
    setBusy(true);
    const res = await post("/api/auth", { runtime: "sandbox", mode: "api_key", adopt: true });
    setBusy(false);
    if (res.ok) setKey("");
    props.onSaved();
  };

  const save = async () => {
    setBusy(true);
    const res = await post("/api/auth", { runtime: "sandbox", mode: "api_key", secret: key.trim() });
    setBusy(false);
    if (res.ok) setKey("");
    props.onSaved();
  };

  return (
    <>
      <Head title="沙盒服务器" note="开容器的那个服务" />
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="sandbox-key">密钥</FieldLabel>
          <InputGroup>
            <Input
              id="sandbox-key"
              className="min-w-0 flex-1 font-mono"
              // What is stored, in the box that stores it — same as the accounts.
              placeholder={
                props.current
                  ? `已存 ${props.current.hint}，粘新的就换掉`
                  : "留空 = 服务器没开鉴权"
              }
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            {/* The server owns this value, so it is read rather than invented.
                A key generated here would be one the server has never heard of,
                and the panel cannot restart the server to teach it. */}
            <Tip label="从沙盒服务器自己的配置里读（OPENSANDBOX_CONFIG、./sandbox.toml、~/.sandbox.toml）。值不经过浏览器。">
              <Button size="sm" disabled={busy} onClick={adopt}>
                从服务器读
              </Button>
            </Tip>
            {/* A key nobody told the server about locks the whole fleet out, and
                until this button existed there was no way back from the panel
                that put it there. */}
            {props.current && (
              <Button
                size="sm"
                variant="quiet"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  await post("/api/auth", { runtime: "sandbox", clear: true });
                  setBusy(false);
                  setKey("");
                  props.onSaved();
                }}
              >
                清掉
              </Button>
            )}
            <Button variant="go" size="sm" disabled={busy || !key.trim()} onClick={save}>
              存下
            </Button>
          </InputGroup>
        </Field>
        {/* No "now put this in the server's config" line any more: that
            instruction is what got followed halfway, and a key only this side
            knows locks the fleet out of every container.存下 refuses a key the
            server rejects. */}
      </FieldGroup>
    </>
  );
}
