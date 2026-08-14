import { useEffect, useState } from "react";
import { Check, CircleAlert } from "lucide-react";
import { H2, Input, Meta, Pane, Textarea } from "../ui/bits";
import { Field, FieldContent, FieldGroup, FieldLabel, FieldTitle, InputGroup } from "../ui/field";
import { Accordion, AccordionBody, AccordionItem, AccordionTrigger } from "../ui/accordion";
import { Button } from "../ui/button";
import { Segment, Segments } from "../ui/segment";
import { Tip } from "../ui/tooltip";
import { pull, post } from "../lib/api";
import { clock, cn } from "../lib/utils";

/**
 * Can this machine work? Two credentials and five facts.
 *
 * Everything here is a label and a value, so everything is one grid: a fixed
 * first column, values aligned down the page, a hairline between rows. The
 * alignment is the design — a heading and a paragraph per field is what made
 * the first version read as a questionnaire.
 *
 * State is carried by ink, not by badges. A credential nobody has pasted is the
 * accent, because the fleet is stopped until they do, and that is the only thing
 * the accent means anywhere on this page.
 *
 * Behaviour is Radix (硬约束 4). The explanations that used to sit under every
 * field are in the code now; the page keeps the command and the cost.
 */

type Mode = "oauth_token" | "api_key" | "chatgpt";

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
      { mode: "oauth_token", label: "订阅", how: "claude setup-token", cost: "一年有效，走订阅额度" },
      { mode: "api_key", label: "API key", how: "console.anthropic.com", cost: "按量计费，不显示额度" },
    ],
  },
  {
    key: "codex",
    label: "Codex",
    login: "chatgpt",
    urlEnv: "OPENAI_BASE_URL",
    modes: [
      { mode: "chatgpt", label: "订阅", how: "codex login", cost: "走订阅额度，本机统一刷新" },
      { mode: "api_key", label: "API key", how: "platform.openai.com", cost: "按量计费" },
    ],
  },
];

/** Host facts only. The credential rows are the 凭据 section, said once. */
const isCredential = (c: HostCheck) => c.name.startsWith("credential:");

export function Settings() {
  const [rows, setRows] = useState<AuthRow[]>([]);
  const [checks, setChecks] = useState<HostCheck[]>([]);
  const [open, setOpen] = useState("");
  /** Until when to keep asking, because a login finishes in another window. */
  const [pollUntil, setPollUntil] = useState(0);

  const load = async () => {
    const [a, p] = await Promise.all([
      pull<{ runtimes: AuthRow[] }>("/api/auth"),
      pull<{ checks: HostCheck[] }>("/api/preflight"),
    ]);
    setRows(a?.runtimes ?? []);
    setChecks(p?.checks ?? []);
  };
  useEffect(() => {
    void load();
  }, []);

  /**
   * A login lands in another window, so nothing here can know when.
   *
   * The CLI stores the credential itself the moment it exits; the only missing
   * piece is the panel noticing. Two seconds is well inside the time it takes to
   * click through an OAuth screen, and the window closes on its own — a poll
   * that runs forever is a poll somebody has to remember to stop.
   */
  useEffect(() => {
    if (!pollUntil) return;
    const t = setInterval(() => {
      if (Date.now() > pollUntil) setPollUntil(0);
      else void load();
    }, 2000);
    return () => clearInterval(t);
  }, [pollUntil]);

  return (
    <Pane className="max-w-[46rem]">
      <H2 className="mb-1.5">凭据</H2>
      <Accordion value={open} onValueChange={setOpen} className="border-t border-rule">
        {RUNTIMES.map((r) => (
          <Credential
            key={r.key}
            runtime={r}
            current={rows.find((x) => x.runtime === r.key)}
            waiting={pollUntil > Date.now()}
            onSaved={load}
            onWaitForLogin={() => setPollUntil(Date.now() + 300_000)}
          />
        ))}
      </Accordion>

      <H2 className="mt-9 mb-1.5">环境</H2>
      <FieldGroup>
        {checks
          .filter((c) => !isCredential(c))
          .map((c) => (
            <Field key={c.name} data-invalid={!c.ok}>
              <FieldTitle>
                {c.ok ? (
                  <Check size={12} strokeWidth={2.5} className="shrink-0 translate-y-0.5 text-ok" />
                ) : (
                  <CircleAlert size={12} strokeWidth={2.5} className="shrink-0 translate-y-0.5" />
                )}
                {c.name}
              </FieldTitle>
              <div className="min-w-0">
                <Meta className="break-all">{c.detail}</Meta>
                {!c.ok && c.fix && (
                  <span className="mt-1 block rounded bg-sunk px-2 py-1 font-mono text-[0.6875rem] leading-relaxed text-ink-2">
                    {c.fix}
                  </span>
                )}
              </div>
            </Field>
          ))}
        {!checks.length && <Meta className="block py-2">检查中…</Meta>}
      </FieldGroup>

      <H2 className="mt-9 mb-1.5">沙盒服务器</H2>
      <SandboxKey current={rows.find((x) => x.runtime === "sandbox")} onSaved={load} />
    </Pane>
  );
}

function Credential(props: {
  runtime: Runtime;
  current?: AuthRow;
  /** A login is in flight; the page is asking every couple of seconds. */
  waiting: boolean;
  onSaved: () => void;
  onWaitForLogin: () => void;
}) {
  const r = props.runtime;
  const cur = props.current;
  const [mode, setMode] = useState<Mode>(cur?.mode ?? r.modes[0]!.mode);
  const [secret, setSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState(cur?.baseUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const spec = r.modes.find((m) => m.mode === mode) ?? r.modes[0]!;

  const save = async () => {
    setBusy(true);
    await post("/api/auth", { runtime: r.key, mode, secret: secret.trim(), baseUrl: baseUrl.trim() || undefined });
    setBusy(false);
    setSecret("");
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
    if (url) props.onWaitForLogin();
    props.onSaved();
  };

  return (
    <AccordionItem value={r.key} className="border-b border-rule-soft">
      <AccordionTrigger
        className={cn(
          "grid grid-cols-[10rem_minmax(0,1fr)] items-baseline gap-x-4 py-2",
          !cur && "[&_[data-slot=field-label]]:text-accent",
        )}
      >
        <FieldTitle>{r.label}</FieldTitle>
        <span className="flex min-w-0 items-baseline gap-2">
          {cur ? (
            <>
              <span className="text-[0.75rem] text-ink-2">
                {r.modes.find((m) => m.mode === cur.mode)?.label ?? cur.mode}
              </span>
              <Meta>{cur.hint}</Meta>
              {cur.baseUrl && <Meta className="min-w-0 truncate">{cur.baseUrl}</Meta>}
              <span className="grow" />
              <Meta>{clock(cur.updatedAt)}</Meta>
            </>
          ) : (
            <span className="text-[0.75rem] font-medium text-accent">没配</span>
          )}
        </span>
      </AccordionTrigger>

      <AccordionBody>
        <FieldGroup className="border-t-0 pb-1">
          <Field className="border-b-0 pt-0">
            <FieldTitle className="text-ink-3">怎么拿</FieldTitle>
            <FieldContent className="flex-wrap gap-x-3 gap-y-1">
              <Segments value={mode} onValueChange={(v) => setMode(v as Mode)}>
                {r.modes.map((m) => (
                  <Segment key={m.mode} value={m.mode}>
                    {m.label}
                  </Segment>
                ))}
              </Segments>
              <Meta className="text-ink-2">{spec.how}</Meta>
              <Meta className="min-w-0 truncate">{spec.cost}</Meta>
              <span className="grow" />
              {r.login === mode && (
                <Tip label="在这台机器上跑一次官方 CLI 的登录，用它本地的登录信息换出 token。仅限官方账号；自建网关走 API key。">
                  <Button size="sm" disabled={busy || props.waiting} onClick={login}>
                    {busy || props.waiting ? "等你在浏览器里批准…" : "从本机登录"}
                  </Button>
                </Tip>
              )}
            </FieldContent>
          </Field>

          {link && (
            <Field className="border-b-0">
              <FieldTitle className="text-ink-3">登录页</FieldTitle>
              {/* One line: the address is 400 characters of PKCE and nobody
                  reads it. It stays selectable for the case where the browser
                  that opened it is not the one you want to log in with. */}
              <span className="flex min-w-0 items-baseline gap-2">
                <a href={link} target="_blank" rel="noopener" className="shrink-0 text-[0.75rem] text-accent underline">
                  浏览器没开就点这里
                </a>
                <Meta className="min-w-0 truncate">{link}</Meta>
              </span>
            </Field>
          )}

          <Field className="border-b-0" orientation={mode === "chatgpt" ? "vertical" : "horizontal"}>
            <FieldLabel htmlFor={`${r.key}-secret`} className="text-ink-3">
              {mode === "chatgpt" ? "auth.json" : "token"}
            </FieldLabel>
            {mode === "chatgpt" ? (
              <Textarea
                id={`${r.key}-secret`}
                className="min-h-16"
                placeholder="~/.codex/auth.json 的完整内容"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
            ) : (
              <Input
                id={`${r.key}-secret`}
                type="password"
                className="font-mono"
                placeholder="粘贴进来，存下之后看不到"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
            )}
          </Field>

          <Field className="border-b-0 pb-3.5">
            <FieldLabel htmlFor={`${r.key}-url`} className="text-ink-3">
              API 地址
            </FieldLabel>
            <InputGroup>
              <Input
                id={`${r.key}-url`}
                className="min-w-0 flex-1 font-mono"
                placeholder={`可选，自建网关 → ${r.urlEnv}`}
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
              {cur && (
                <Button
                  size="sm"
                  variant="quiet"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    await post("/api/auth", { runtime: r.key, clear: true });
                    setBusy(false);
                    props.onSaved();
                  }}
                >
                  清掉
                </Button>
              )}
              <Button variant="go" size="sm" disabled={busy || !secret.trim()} onClick={save}>
                存下
              </Button>
            </InputGroup>
          </Field>
        </FieldGroup>
      </AccordionBody>
    </AccordionItem>
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

  const generate = () => {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    setKey(btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
  };

  const save = async () => {
    setBusy(true);
    await post("/api/auth", { runtime: "sandbox", mode: "api_key", secret: key.trim() });
    setBusy(false);
    setKey("");
    props.onSaved();
  };

  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="sandbox-key">
          密钥
          <Meta>{props.current ? props.current.hint : "没设"}</Meta>
        </FieldLabel>
        <InputGroup>
          <Input
            id="sandbox-key"
            className="min-w-0 flex-1 font-mono"
            placeholder="留空 = 服务器没开鉴权"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <Tip label="32 字节，来自浏览器的密码学随机源">
            <Button size="sm" onClick={generate}>
              生成
            </Button>
          </Tip>
          <Button variant="go" size="sm" disabled={busy || !key.trim()} onClick={save}>
            存下
          </Button>
        </InputGroup>
      </Field>
      {key.trim() && (
        <Field className="border-b-0">
          <FieldTitle className="text-ink-3">另一半</FieldTitle>
          <span className="min-w-0 rounded bg-sunk px-2 py-1 font-mono text-[0.6875rem] leading-relaxed break-all text-ink-2">
            ~/.sandbox.toml → [server] api_key = "{key.trim()}"
          </span>
        </Field>
      )}
    </FieldGroup>
  );
}
