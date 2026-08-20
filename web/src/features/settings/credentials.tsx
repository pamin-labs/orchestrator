import { useEffect, useState } from "react";
import { api, mutate } from "../../shared/api";
import { clock } from "../../shared/format";
import { Head, Input, Meta, Textarea } from "../../ui/bits";
import { Button } from "../../ui/button";
import { Field, FieldContent, FieldGroup, FieldLabel, FieldTitle, InputGroup } from "../../ui/field";
import { Segment, Segments } from "../../ui/segment";
import { Switch } from "../../ui/switch";
import { Tip } from "../../ui/tooltip";
import { type AuthRow, DeviceCode, type Mode, ModeSchema } from "./auth";
import {
  ClaudeLoginFlowSchema as ClaudeLoginSchema,
  CodexLoginFlowSchema as CodexLoginSchema,
} from "../../../../src/contracts/login-flow";
import { Trans } from "@lingui/react/macro";
import { t } from "@lingui/core/macro";
import { msg } from "@lingui/core/macro";
import { i18n } from "../../i18n";
import type { MessageDescriptor } from "@lingui/core";

export interface Runtime {
  key: "claude" | "codex";
  label: string;
  /** The mode this machine can obtain by running the CLI itself. */
  login?: Mode;
  /** `msg` at module scope, `i18n._` at call scope: this table is built once at
   *  import, and a resolved string would freeze at whatever locale was active. */
  modes: Array<{ mode: Mode; label: MessageDescriptor; how: MessageDescriptor | string; cost: MessageDescriptor }>;
  urlEnv: string;
}

export const RUNTIMES: Runtime[] = [
  {
    key: "claude",
    label: "Claude",
    login: "oauth_token",
    urlEnv: "ANTHROPIC_BASE_URL",
    modes: [
      {
        mode: "oauth_token",
        label: msg`Subscription`,
        how: msg`Run claude setup-token in the container`,
        cost: msg`Valid for one year`,
      },
      { mode: "api_key", label: msg`API key`, how: "console.anthropic.com", cost: msg`Usage not displayed` },
    ],
  },
  {
    key: "codex",
    label: "Codex",
    login: "chatgpt",
    urlEnv: "OPENAI_BASE_URL",
    modes: [
      {
        mode: "chatgpt",
        label: msg`Subscription`,
        how: msg`Log in within the container; no need to install codex locally`,
        cost: msg`Refreshed locally`,
      },
      { mode: "api_key", label: msg`API key`, how: "platform.openai.com", cost: msg`Usage not displayed` },
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
      <Head title={t`Model account`} note={t`Real tokens don't enter the sandbox`} />
      {RUNTIMES.map((runtime) => (
        <CredentialRow
          key={runtime.key}
          runtime={runtime}
          rows={rows}
          {...(prefs !== undefined ? { prefs } : {})}
          {...(waiting !== undefined ? { waiting } : {})}
          onSaved={onSaved}
          onWaitForLogin={onWaitForLogin}
        />
      ))}
    </>
  );
}

function CredentialRow({
  runtime,
  rows,
  prefs,
  waiting,
  onSaved,
  onWaitForLogin,
}: {
  runtime: Runtime;
  rows: AuthRow[];
  prefs?: { claudeCoauthor: boolean };
  waiting?: string;
  onSaved: () => void;
  onWaitForLogin: (runtime: string, since: number) => void;
}) {
  const current = rows.find((row) => row.runtime === runtime.key);
  return (
    <Credential
      runtime={runtime}
      {...(current ? { current } : {})}
      waiting={waiting === runtime.key}
      {...(runtime.key === "claude" ? { claudeCoauthor: prefs?.claudeCoauthor ?? true } : {})}
      onSaved={onSaved}
      onWaitForLogin={(since) => onWaitForLogin(runtime.key, since)}
    />
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
interface CredentialProps {
  runtime: Runtime;
  current?: AuthRow;
  /** A login is in flight; the page is asking every couple of seconds. */
  waiting: boolean;
  /** Claude Code's own commit trailer. Only this runtime has one. */
  claudeCoauthor?: boolean;
  onSaved: () => void;
  onWaitForLogin: (since: number) => void;
}

interface CredentialForm {
  mode: Mode;
  secret: string;
  baseUrl: string;
  busy: boolean;
}

interface LoginFlow {
  link: string | null;
  device: { code: string; url: string; expiresAt: number } | null;
  paste: string;
}

type Change<T> = (patch: Partial<T>) => void;

function credentialJson(runtime: Runtime, mode: Mode, values: { secret: string; baseUrl?: string }) {
  if (runtime.key === "claude") {
    if (mode === "chatgpt") throw new Error("ChatGPT login belongs to codex");
    return { runtime: runtime.key, mode, ...values };
  }
  if (mode === "oauth_token") throw new Error("Claude OAuth token belongs to claude");
  return { runtime: runtime.key, mode, ...values };
}

function useCredential(props: CredentialProps) {
  const savedBaseUrl = props.current?.baseUrl ?? "";
  const [form, setForm] = useState<CredentialForm>(() => {
    return {
      mode: props.current ? props.current.mode : props.runtime.modes[0]!.mode,
      secret: "",
      baseUrl: savedBaseUrl,
      busy: false,
    };
  });
  const [login, setLogin] = useState<LoginFlow>({ link: null, device: null, paste: "" });
  const updatedAt = props.current ? props.current.updatedAt : 0;
  const changeForm: Change<CredentialForm> = (patch) => setForm((current) => ({ ...current, ...patch }));
  const changeLogin: Change<LoginFlow> = (patch) => setLogin((current) => ({ ...current, ...patch }));

  // The OAuth address is worth showing until the credential it fetches arrives,
  // and not one render longer.
  useEffect(() => {
    changeLogin({ link: null, device: null });
  }, [updatedAt]);
  // Stop showing a code that has stopped working. An expired code that still
  // looks live is the same failure as a panel saying the app is not installed
  // after it has been.
  useEffect(() => {
    if (!login.device) return;
    const t = setTimeout(() => changeLogin({ device: null }), Math.max(0, login.device.expiresAt - Date.now()));
    return () => clearTimeout(t);
  }, [login.device]);

  return { props, form, login, changeForm, changeLogin, savedBaseUrl, updatedAt };
}

type CredentialState = ReturnType<typeof useCredential>;

function Credential(props: CredentialProps) {
  const state = useCredential(props);
  const { form, savedBaseUrl, changeForm } = state;
  const dirty = !!form.secret.trim() || form.baseUrl.trim() !== savedBaseUrl;
  const save = async () => {
    const url = form.baseUrl.trim();
    const json = credentialJson(props.runtime, form.mode, {
      secret: form.secret.trim(),
      ...(url ? { baseUrl: url } : {}),
    });
    changeForm({ busy: true });
    const res = await mutate(api.auth.$post({ json }));
    changeForm({ busy: false });
    // Only on success. A rejected token used to be wiped from the box while a
    // toast explained why it was rejected, so the fix was to paste it again.
    if (res.ok) changeForm({ secret: "" });
    props.onSaved();
  };
  return (
    <section className="mt-6 first:mt-0">
      <CredentialHeader state={state} />
      <CredentialIntro state={state} />

      {/* The gap the group's own top rule used to stand in for. */}
      <FieldGroup className="mt-1.5">
        <SecretField state={state} />
        <LoginProgress state={state} />
        <CredentialSettings state={state} />
      </FieldGroup>
      <div className="mt-2 flex items-center gap-2">
        <span className="grow" />
        {props.current && (
          <Button
            size="sm"
            variant="quiet"
            disabled={form.busy}
            onClick={async () => {
              changeForm({ busy: true });
              await mutate(api.auth.$post({ json: { runtime: props.runtime.key, clear: true } }));
              changeForm({ busy: false, secret: "", baseUrl: "" });
              props.onSaved();
            }}
          >
            <Trans>Clear</Trans>
          </Button>
        )}
        {/* Only once there is something to save, same as every other field here. */}
        {dirty && (
          <Button variant="go" size="sm" disabled={form.busy} onClick={() => void save()}>
            <Trans>Save</Trans>
          </Button>
        )}
      </div>
    </section>
  );
}

function CredentialIntro({ state }: { state: CredentialState }) {
  const { props, form } = state;
  const spec = props.runtime.modes.find((candidate) => candidate.mode === form.mode) ?? props.runtime.modes[0]!;
  // How to get one, and what it costs — instructions for a decision already
  // made. A configured account sitting on its own mode needs none of it.
  if (props.current && props.current.mode === form.mode) return null;
  return (
    <Meta className="mb-1.5 block">
      {typeof spec.how === "string" ? spec.how : i18n._(spec.how)} · {i18n._(spec.cost)}
    </Meta>
  );
}

function CredentialHeader({ state }: { state: CredentialState }) {
  const { props, form, changeForm } = state;
  return (
    <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="font-display text-name font-semibold">{props.runtime.label}</span>
      <CredentialStatus state={state} />
      <span className="grow" />
      <Segments
        value={form.mode}
        onValueChange={(value) => {
          const parsed = ModeSchema.safeParse(value);
          if (parsed.success) changeForm({ mode: parsed.data });
        }}
      >
        {props.runtime.modes.map((m) => (
          <Segment key={m.mode} value={m.mode}>
            {i18n._(m.label)}
          </Segment>
        ))}
      </Segments>
    </div>
  );
}

function CredentialStatus({ state }: { state: CredentialState }) {
  const { props, form } = state;
  if (!props.current)
    return (
      <span className="text-secondary font-medium text-accent">
        <Trans>Not configured</Trans>
      </span>
    );
  const labels = Object.fromEntries(props.runtime.modes.map((mode) => [mode.mode, i18n._(mode.label)]));
  return (
    <>
      {/* Which mode is stored is only worth a word when it is not the one
          being looked at: the pressed segment on the right already says
          that, and a label repeating it is the same fact 30rem apart.
          When they differ it is the whole point of the row. */}
      {props.current.mode !== form.mode && (
        <span className="text-secondary text-ink-2">存的是{labels[props.current.mode] ?? props.current.mode}</span>
      )}
      {/* The masked tail is in the box it was pasted into, not here as well. */}
      <Meta>{clock(props.current.updatedAt)}</Meta>
    </>
  );
}

function secretPlaceholder(props: CredentialProps, form: CredentialForm, fallback: string) {
  if (!props.current || props.current.mode !== form.mode) return fallback;
  return `已存 ${props.current.hint}，粘新的就换掉`;
}

const SECRET_LABEL = { oauth_token: msg`Token`, api_key: msg`API key` } as const;

function SecretField({ state }: { state: CredentialState }) {
  const { props, form, changeForm, changeLogin, updatedAt } = state;
  /**
   * Sign in, whichever way this runtime does it.
   *
   * Both run the official CLI in the utility container — nothing is installed on
   * this machine and nothing forges an OAuth exchange. They differ in what the
   * boss does with the page: codex prints a code to type there, claude prints a
   * code to bring back, so claude gets the input below.
   */
  const signIn = async () => {
    changeForm({ busy: true });
    if (props.runtime.key === "codex") {
      const res = await mutate(api.auth.codex.device.$post(), false, CodexLoginSchema);
      changeForm({ busy: false });
      if (!res.ok) return;
      changeLogin({ device: res.data });
    } else {
      const res = await mutate(api.auth.claude.login.$post(), false, ClaudeLoginSchema);
      changeForm({ busy: false });
      if (!res.ok) return;
      // Not opened from here. The CLI opens the browser itself, so doing it too
      // gives the boss two tabs of the same OAuth flow — and finishing the wrong
      // one leaves the other waiting forever.
      changeLogin({ link: res.data.url });
    }
    props.onWaitForLogin(updatedAt);
  };

  const mode = form.mode;
  if (mode === "chatgpt") {
    return <ChatgptSecretField state={state} signIn={signIn} />;
  }
  const login = props.runtime.login === mode && <Login busy={form.busy} waiting={props.waiting} onClick={signIn} />;
  return (
    <Field orientation="horizontal">
      {/* The label is what this mode calls the thing. It said `token` under an
          API key too, which is two words for one field. */}
      <FieldLabel htmlFor={`${props.runtime.key}-secret`} className="text-ink-3">
        {i18n._(SECRET_LABEL[mode])}
      </FieldLabel>
      <InputGroup>
        <Input
          id={`${props.runtime.key}-secret`}
          type="password"
          className="min-w-0 flex-1 font-mono"
          placeholder={secretPlaceholder(props, form, t`Paste it; hidden after saving`)}
          value={form.secret}
          onChange={(e) => changeForm({ secret: e.target.value })}
        />
        {/* The alternative to pasting, next to the box it replaces. */}
        {login}
      </InputGroup>
    </Field>
  );
}

function ChatgptSecretField({ state, signIn }: { state: CredentialState; signIn: () => void }) {
  const { props, form, changeForm } = state;
  return (
    <Field orientation="vertical">
      <span className="flex items-center gap-2">
        <FieldLabel htmlFor={`${props.runtime.key}-secret`} className="text-ink-3">
          auth.json
        </FieldLabel>
        <span className="grow" />
        {/* Beside the label, because the box below is a block and the button
            is the other way to fill it. */}
        {props.runtime.login === "chatgpt" && <Login busy={form.busy} waiting={props.waiting} onClick={signIn} />}
      </span>
      <Textarea
        id={`${props.runtime.key}-secret`}
        className="min-h-16"
        placeholder={secretPlaceholder(props, form, t`Full contents of ~/.codex/auth.json`)}
        value={form.secret}
        onChange={(e) => changeForm({ secret: e.target.value })}
      />
    </Field>
  );
}

function LoginProgress({ state }: { state: CredentialState }) {
  const { form, login, changeForm, changeLogin } = state;
  const sendCode = async () => {
    const code = login.paste.trim();
    if (!code) return;
    changeForm({ busy: true });
    const res = await mutate(api.auth.claude.login.code.$post({ json: { code } }));
    changeForm({ busy: false });
    if (res.ok) changeLogin({ paste: "" });
  };
  return (
    <>
      {login.device && (
        <Field orientation="vertical">
          <DeviceCode code={login.device.code} url={login.device.url} go={t`Go to ChatGPT to enter code`} />
          <div className="mt-1.5 flex items-baseline gap-2">
            {/* The real expiry, not a remembered one. `15 分钟` was written into
                the copy while `expiresAt` sat two lines up driving the timer
                that clears this block. */}
            <Meta>到 {clock(login.device.expiresAt)} 前有效</Meta>
            <span className="grow" />
            <Button
              size="sm"
              variant="quiet"
              onClick={async () => {
                await mutate(api.auth.codex.device.cancel.$post());
                changeLogin({ device: null });
              }}
            >
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </Field>
      )}

      {login.link && (
        <>
          <Field>
            {/* Not a FieldLabel: there is no control on this row to focus, and a
                label pointing at nothing is what a screen reader reads out. */}
            <FieldTitle className="text-ink-3">
              <Trans>Login page</Trans>
            </FieldTitle>
            {/* One line: the address is 400 characters of PKCE and nobody reads
                it. It stays selectable for the case where the browser that opened
                it is not the one you want to log in with. */}
            <span className="flex min-w-0 items-baseline gap-2">
              <a
                href={login.link}
                target="_blank"
                rel="noopener"
                className="shrink-0 text-secondary text-accent underline"
              >
                <Trans>Open login page</Trans>
              </a>
              <Meta className="min-w-0 truncate">{login.link}</Meta>
            </span>
          </Field>
          {/* The half that has no equivalent in the codex flow. `claude
              setup-token` sits at `Paste code here` until something answers,
              and the only thing that can is the boss — hard constraint 5: the
              thing to do next is beside the evidence for doing it. */}
          <Field orientation="vertical">
            <FieldLabel htmlFor="claude-code" className="text-ink-3">
              <Trans>Code from page</Trans>
            </FieldLabel>
            <InputGroup>
              <Input
                id="claude-code"
                className="min-w-0 flex-1 font-mono"
                placeholder={t`After approval, copy the code from that page`}
                value={login.paste}
                onChange={(e) => changeLogin({ paste: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void sendCode();
                }}
              />
              <Button size="sm" disabled={form.busy || !login.paste.trim()} onClick={() => void sendCode()}>
                <Trans>Submit</Trans>
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
                  await mutate(api.auth.claude.login.cancel.$post());
                  changeLogin({ link: null, paste: "" });
                }}
              >
                <Trans>Cancel</Trans>
              </Button>
            </div>
          </Field>
        </>
      )}
    </>
  );
}

function CredentialSettings({ state }: { state: CredentialState }) {
  const { props, form, changeForm } = state;
  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${props.runtime.key}-url`} className="text-ink-3">
          <Trans>API address</Trans>
        </FieldLabel>
        <FieldContent className="flex-col items-stretch gap-1">
          <Input
            id={`${props.runtime.key}-url`}
            className="font-mono"
            placeholder={`可选，自建网关 → ${props.runtime.urlEnv}`}
            value={form.baseUrl}
            onChange={(e) => changeForm({ baseUrl: e.target.value })}
          />
          {/* Under the address that causes it, not under the account. Usage is
              only ever read from the provider's own endpoint, so a gateway
              account has no window to show and the header would look broken
              rather than deliberate. */}
          {form.mode !== "api_key" && form.baseUrl.trim() && (
            <Meta className="block">
              <Trans>Custom gateway; usage not displayed in header</Trans>
            </Meta>
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
              disabled={form.busy}
              onCheckedChange={async (value) => {
                changeForm({ busy: true });
                await mutate(api.git.trailers.$post({ json: { claudeCoauthor: value } }));
                changeForm({ busy: false });
                props.onSaved();
              }}
            />
            <Meta>
              <Trans>Claude Code writes this in Co-Authored-By when committing</Trans>
            </Meta>
          </FieldContent>
        </Field>
      )}
    </>
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
    <Tip
      label={t`Run the official CLI's login once in the tool container; store the credential here. No setup needed locally. Official accounts only; custom gateways use API key.`}
    >
      <Button size="sm" disabled={busy || waiting} onClick={onClick}>
        {busy || waiting ? t`Waiting for you to approve in the browser…` : t`Log in`}
      </Button>
    </Tip>
  );
}
