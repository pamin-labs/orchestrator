import { useEffect, useState } from "react";
import { Head, Input, Meta, Textarea } from "../../ui/bits";
import { Field, FieldContent, FieldGroup, FieldLabel, FieldTitle, InputGroup } from "../../ui/field";
import { Button } from "../../ui/button";
import { Segment, Segments } from "../../ui/segment";
import { Switch } from "../../ui/switch";
import { Tip } from "../../ui/tooltip";
import { post } from "../../lib/api";
import { clock } from "../../lib/utils";
import { DeviceCode, type AuthRow, type Mode } from "./shared";

interface Runtime {
  key: string;
  label: string;
  /** The mode this machine can obtain by running the CLI itself. */
  login?: Mode;
  modes: Array<{ mode: Mode; label: string; how: string; cost: string }>;
  urlEnv: string;
}

export const RUNTIMES: Runtime[] = [
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

export function CredPane({
  rows,
  prefs,
  waiting,
  onSaved,
  onWaitForLogin,
}: {
  rows: AuthRow[];
  prefs?: { claudeCoauthor: boolean };
  /** Which runtime has a login in flight, if any. */
  waiting?: string;
  onSaved: () => void;
  onWaitForLogin: (runtime: string, since: number) => void;
}) {
  return (
    <>
      <Head title="模型账号" note="真令牌不进沙盒" />
      {RUNTIMES.map((r) => (
        <Credential
          key={r.key}
          runtime={r}
          current={rows.find((x) => x.runtime === r.key)}
          // Only the account being logged into. One flag for both meant
          // a claude login also froze codex's button for five minutes.
          waiting={waiting === r.key}
          claudeCoauthor={r.key === "claude" ? (prefs?.claudeCoauthor ?? true) : undefined}
          onSaved={onSaved}
          onWaitForLogin={(since) => onWaitForLogin(r.key, since)}
        />
      ))}
    </>
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
                <a href={link} target="_blank" rel="noopener" className="shrink-0 text-[0.75rem] text-accent underline">
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
            {mode !== "api_key" && baseUrl.trim() && <Meta className="block">自建网关，头部不显示额度</Meta>}
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
