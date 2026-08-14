import { useEffect, useState } from "react";
import { Check, CircleAlert } from "lucide-react";
import { H2, Input, Meta, Pane, Textarea } from "../ui/bits";
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

/** The grid every row on this page sits on. */
export const ROW = "grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-x-4";

export function Settings() {
  const [rows, setRows] = useState<AuthRow[]>([]);
  const [checks, setChecks] = useState<HostCheck[]>([]);
  const [open, setOpen] = useState("");

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

  return (
    <Pane className="max-w-[46rem]">
      <H2 className="mb-1.5">凭据</H2>
      <Accordion value={open} onValueChange={setOpen} className="border-t border-rule">
        {RUNTIMES.map((r) => (
          <Credential key={r.key} runtime={r} current={rows.find((x) => x.runtime === r.key)} onSaved={load} />
        ))}
      </Accordion>

      <H2 className="mt-9 mb-1.5">环境</H2>
      <div className="border-t border-rule">
        {checks.map((c) => (
          <div key={c.name} className={cn(ROW, "border-b border-rule-soft py-2")}>
            <span className={cn("flex items-baseline gap-1.5 text-[0.8125rem]", c.ok ? "text-ink" : "text-accent")}>
              {c.ok ? (
                <Check size={12} strokeWidth={2.5} className="shrink-0 translate-y-0.5 text-ok" />
              ) : (
                <CircleAlert size={12} strokeWidth={2.5} className="shrink-0 translate-y-0.5" />
              )}
              <span className="min-w-0 truncate">{c.name}</span>
            </span>
            <span className="min-w-0">
              <Meta className="break-all">{c.detail}</Meta>
              {!c.ok && c.fix && (
                <span className="mt-1 block rounded bg-sunk px-2 py-1 font-mono text-[0.6875rem] leading-relaxed text-ink-2">
                  {c.fix}
                </span>
              )}
            </span>
          </div>
        ))}
        {!checks.length && <Meta className="block py-2">检查中…</Meta>}
      </div>

      <H2 className="mt-9 mb-1.5">沙盒服务器</H2>
      <SandboxKey current={rows.find((x) => x.runtime === "sandbox")} onSaved={load} />
    </Pane>
  );
}

function Credential(props: { runtime: Runtime; current?: AuthRow; onSaved: () => void }) {
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
    setLink(url);
    // Opened for you and printed as well: a popup blocker eating the one
    // actionable thing on the page is worse than a link nobody clicks.
    if (url) window.open(url, "_blank", "noopener");
    setBusy(false);
    props.onSaved();
  };

  return (
    <AccordionItem value={r.key} className="border-b border-rule-soft">
      <AccordionTrigger className={cn(ROW, "py-2")}>
        <span className={cn("text-[0.8125rem]", cur ? "text-ink" : "font-medium text-accent")}>
          {cur ? r.label : `${r.label} 没配`}
        </span>
        {cur && (
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="text-[0.75rem] text-ink-2">
              {r.modes.find((m) => m.mode === cur.mode)?.label ?? cur.mode}
            </span>
            <Meta>{cur.hint}</Meta>
            {cur.baseUrl && <Meta className="min-w-0 truncate">{cur.baseUrl}</Meta>}
            <span className="grow" />
            <Meta>{clock(cur.updatedAt)}</Meta>
          </span>
        )}
      </AccordionTrigger>

      <AccordionBody>
        <div className="space-y-2 pt-2 pb-3.5">
          <div className={ROW}>
            <Segments value={mode} onValueChange={(v) => setMode(v as Mode)}>
              {r.modes.map((m) => (
                <Segment key={m.mode} value={m.mode}>
                  {m.label}
                </Segment>
              ))}
            </Segments>
            <span className="flex min-w-0 items-baseline gap-2">
              <Meta className="text-ink-2">{spec.how}</Meta>
              <Meta className="min-w-0 truncate">{spec.cost}</Meta>
              <span className="grow" />
              {r.login === mode && (
                <Tip label="在这台机器上跑一次官方 CLI 的登录，用它本地的登录信息换出 token。仅限官方账号；自建网关走 API key。">
                  <Button size="sm" disabled={busy} onClick={login}>
                    {busy ? "等浏览器…" : "从本机登录"}
                  </Button>
                </Tip>
              )}
            </span>
          </div>

          {link && (
            <div className={ROW}>
              <Meta>没自动打开</Meta>
              <a
                href={link}
                target="_blank"
                rel="noopener"
                className="min-w-0 break-all font-mono text-[0.75rem] text-accent underline"
              >
                {link}
              </a>
            </div>
          )}

          <div className={ROW}>
            <Meta>{mode === "chatgpt" ? "auth.json" : "token"}</Meta>
            {mode === "chatgpt" ? (
              <Textarea
                className="min-h-16"
                placeholder="~/.codex/auth.json 的完整内容"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
            ) : (
              <Input
                type="password"
                className="font-mono"
                placeholder="粘贴进来，存下之后看不到"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
            )}
          </div>

          <div className={ROW}>
            <Meta>API 地址</Meta>
            <span className="flex items-center gap-2">
              <Input
                className="min-w-0 flex-1 font-mono"
                placeholder={`可选，自建网关 → ${r.urlEnv}`}
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
              <Button variant="go" size="sm" disabled={busy || !secret.trim()} onClick={save}>
                存下
              </Button>
            </span>
          </div>
        </div>
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
    <div className="border-t border-rule">
      <div className={cn(ROW, "border-b border-rule-soft py-2")}>
        <Meta>{props.current ? props.current.hint : "没设"}</Meta>
        <span className="flex items-center gap-2">
          <Input
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
        </span>
      </div>
      {key.trim() && (
        <div className={cn(ROW, "py-2")}>
          <Meta>另一半</Meta>
          <span className="min-w-0 rounded bg-sunk px-2 py-1 font-mono text-[0.6875rem] leading-relaxed break-all text-ink-2">
            ~/.sandbox.toml → [server] api_key = "{key.trim()}"
          </span>
        </div>
      )}
    </div>
  );
}
