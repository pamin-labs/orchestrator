import { useEffect, useState } from "react";
import { Check, CircleAlert, ExternalLink } from "lucide-react";
import { Empty, H2, Input, Meta, Pane } from "../ui/bits";
import { Button } from "../ui/button";
import { Tip } from "../ui/tooltip";
import { pull, post } from "../lib/api";
import { clock, cn } from "../lib/utils";

/**
 * The wiring, on one page, because it is one question: can this machine work?
 *
 * Two credentials and a handful of facts about the host. Every one of them is
 * either fine or blocking, nothing in between, so the page is a list of rows
 * that say which. The accent — everywhere else "waiting on the boss" — is exactly
 * right on a credential nobody has pasted: the fleet is stopped until they do.
 *
 * No cards. A row is a hairline and a gutter; the form opens under the row it
 * belongs to, on `rail`, so the fields have a visible owner.
 */

type Mode = "oauth_token" | "api_key" | "chatgpt";

interface AuthRow {
  runtime: string;
  mode: Mode;
  hint: string;
  baseUrl?: string;
  updatedAt: number;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

interface Runtime {
  key: string;
  label: string;
  /** The mode the orchestrator can obtain by running the CLI on this machine. */
  login?: Mode;
  modes: Array<{ mode: Mode; label: string; how: string; note: string }>;
  /** What a custom endpoint becomes inside the sandbox. */
  urlEnv: string;
}

const RUNTIMES: Runtime[] = [
  {
    key: "claude",
    label: "Claude",
    login: "oauth_token",
    urlEnv: "ANTHROPIC_BASE_URL",
    modes: [
      {
        mode: "oauth_token",
        label: "订阅",
        how: "claude setup-token",
        note: "一年有效，走订阅额度。顶上的 5 小时/周额度也只有这条路有数。",
      },
      {
        mode: "api_key",
        label: "API key",
        how: "console.anthropic.com → API keys",
        note: "按 token 计费，不占订阅额度，顶上不显示额度条。",
      },
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
        label: "订阅",
        how: "codex login，或粘贴 ~/.codex/auth.json",
        note: "走 ChatGPT 订阅。刷新由这台机器一家做：codex 自己的文档说别把同一份登录分给并发任务，而一支车队正好是十个。",
      },
      { mode: "api_key", label: "API key", how: "platform.openai.com → API keys", note: "按 token 计费。" },
    ],
  },
];

export function Settings() {
  const [rows, setRows] = useState<AuthRow[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  const load = async () => {
    const [a, p] = await Promise.all([
      pull<{ runtimes: AuthRow[] }>("/api/auth"),
      pull<{ checks: Check[] }>("/api/preflight"),
    ]);
    setRows(a?.runtimes ?? []);
    setChecks(p?.checks ?? []);
  };
  useEffect(() => {
    void load();
  }, []);

  const missing = RUNTIMES.filter((r) => !rows.some((x) => x.runtime === r.key));

  return (
    <Pane className="max-w-[52rem]">
      <H2>凭据</H2>
      {missing.length > 0 && (
        <Empty>
          {missing.map((r) => r.label).join(" 和 ")}还没配。没有凭据的 turn 根本不会被派出去，队列会等着
          —— 不会烧掉一轮去撞 401。
        </Empty>
      )}
      <div className="mt-2 border-t border-rule">
        {RUNTIMES.map((r) => (
          <Credential
            key={r.key}
            runtime={r}
            current={rows.find((x) => x.runtime === r.key)}
            open={open === r.key}
            onToggle={() => setOpen(open === r.key ? null : r.key)}
            onSaved={load}
          />
        ))}
      </div>

      <H2 className="mt-9">这台机器</H2>
      <div className="border-t border-rule">
        {checks.map((c) => (
          <div key={c.name} className="flex items-baseline gap-3 border-b border-rule-soft py-2">
            <span className={cn("shrink-0 translate-y-0.5", c.ok ? "text-ok" : "text-bad")}>
              {c.ok ? <Check size={13} strokeWidth={2.5} /> : <CircleAlert size={13} strokeWidth={2.5} />}
            </span>
            <span className="w-36 shrink-0 text-[0.8125rem] text-ink">{c.name}</span>
            <span className="min-w-0 flex-1">
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
    </Pane>
  );
}

function Credential(props: {
  runtime: Runtime;
  current?: AuthRow;
  open: boolean;
  onToggle: () => void;
  onSaved: () => void;
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
    setLink(url);
    // Opened for you and printed as text: a popup blocker eating the one
    // actionable thing on the page is worse than a link nobody clicks.
    if (url) window.open(url, "_blank", "noopener");
    setBusy(false);
    props.onSaved();
  };

  return (
    <div className={cn("border-b border-rule-soft", props.open && "bg-rail")}>
      <button
        onClick={props.onToggle}
        className="flex w-full cursor-pointer items-baseline gap-3 px-2 py-2.5 text-left"
      >
        <span className="w-36 shrink-0 text-[0.8125rem] font-medium text-ink">{r.label}</span>
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
      </button>

      {props.open && (
        <div className="px-2 pb-3.5">
          <div className="flex flex-wrap items-center gap-1">
            {r.modes.map((m) => (
              <button
                key={m.mode}
                onClick={() => setMode(m.mode)}
                className={cn(
                  "cursor-pointer rounded px-2 py-0.5 text-[0.75rem] transition-colors",
                  mode === m.mode ? "bg-sunk font-medium text-ink" : "text-ink-3 hover:text-ink",
                )}
              >
                {m.label}
              </button>
            ))}
            <span className="grow" />
            {r.login === mode && (
              <Tip label="在这台机器上跑一次官方 CLI 的登录，用它本地的登录信息换出 token。仅限官方账号；自建网关走 API key。">
                <Button size="sm" disabled={busy} onClick={login}>
                  {busy ? "等浏览器…" : "从本机登录"}
                </Button>
              </Tip>
            )}
          </div>

          <div className="mt-2 text-[0.75rem] leading-relaxed text-ink-3">
            <span className="font-mono text-ink-2">{spec.how}</span>
            <span className="mx-1.5">·</span>
            {spec.note}
          </div>

          {link && (
            <div className="mt-2 flex items-baseline gap-1.5 text-[0.75rem] text-ink-3">
              <ExternalLink size={12} strokeWidth={1.75} className="shrink-0 translate-y-0.5" />
              <span className="min-w-0 break-all">
                没自己打开的话点这里：
                <a href={link} target="_blank" rel="noopener" className="font-mono text-accent underline">
                  {link}
                </a>
                。批准完这一页会自己更新。
              </span>
            </div>
          )}

          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {mode === "chatgpt" ? (
              <textarea
                className="min-h-20 w-full resize-y rounded-md border border-rule bg-paper px-2 py-1 font-mono text-[0.6875rem] leading-relaxed text-ink transition-colors placeholder:text-ink-3 focus:border-accent focus:ring-3 focus:ring-accent-soft focus:outline-none"
                placeholder="~/.codex/auth.json 的完整内容"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
            ) : (
              <Input
                type="password"
                className="min-w-0 flex-1 font-mono"
                placeholder="粘贴进来，存下之后就看不到了"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
            )}
            <Input
              className="min-w-0 flex-1 font-mono"
              placeholder={`API 地址（可选，自建网关填这里 → ${r.urlEnv}）`}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            <Button variant="go" size="sm" disabled={busy || !secret.trim()} onClick={save}>
              存下
            </Button>
          </div>

          <Meta className="mt-2 block leading-relaxed">
            真值只写进沙盒外面的 egress sidecar，容器里放的是格式对、值是假的那一份。存下会回收正在跑的沙盒
            —— 它们的 sidecar 里还是旧凭据 —— 下一轮自动重建。
          </Meta>
        </div>
      )}
    </div>
  );
}
