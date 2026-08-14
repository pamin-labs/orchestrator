import { useEffect, useState } from "react";
import { Meta, Pane } from "../ui/bits";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { pull, post } from "../lib/api";
import { clock } from "../lib/utils";

/**
 * Where the fleet's credentials are set, and what is missing before it can run.
 *
 * Both halves are here because they fail together: a runtime with no credential
 * and a sandbox server that is not up look identical from the outside — agents
 * that do not answer. Naming the actual cause, with the command that fixes it,
 * is the difference between a five-second fix and an afternoon.
 *
 * A pasted secret is never read back. The value goes to the egress sidecar's
 * vault and the sandbox itself only ever holds a decoy, so there is nothing to
 * show and nothing worth stealing from this page.
 */

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

/**
 * How to get each credential, in the page that asks for it.
 *
 * Not a link: this page fetches nothing from a remote origin, and a URL is a
 * thing to go read somewhere else anyway. The command, what it produces and how
 * long it lasts is the whole answer.
 */
type Mode = "oauth_token" | "api_key" | "chatgpt";

interface RuntimeGuide {
  key: string;
  label: string;
  /** Every way this runtime can be paid for, in the order worth trying. */
  modes: Array<{ mode: Mode; label: string; how: string; note: string }>;
  /** Modes the orchestrator can obtain by running the CLI for you. */
  canLogin?: Mode;
}

const RUNTIMES: RuntimeGuide[] = [
  {
    key: "claude",
    label: "Claude",
    canLogin: "oauth_token",
    modes: [
      {
        mode: "oauth_token",
        label: "订阅 token",
        how: "claude setup-token",
        note: "在你自己的终端里跑，浏览器走一次 OAuth，吐出 sk-ant-oat01- 开头的 token。一年有效，吃订阅额度 —— 顶上的 5 小时/周额度也只有这条路有数。真值只进 egress sidecar，沙盒里是假的。",
      },
      {
        mode: "api_key",
        label: "API key",
        how: "console.anthropic.com → API keys",
        note: "sk-ant-api03- 开头，按 token 计费，不吃订阅额度（顶上不显示额度条）。兼容端点填 base URL。真值同样只进 sidecar。",
      },
    ],
  },
  {
    key: "codex",
    label: "Codex",
    canLogin: "chatgpt",
    modes: [
      {
        mode: "api_key",
        label: "API key",
        how: "platform.openai.com → API keys",
        note: "sk- 开头，按 token 计费。兼容端点填 base URL。真值只进 egress sidecar，沙盒里是假的 —— 和 claude 一样。",
      },
      {
        mode: "chatgpt",
        label: "ChatGPT 订阅",
        how: "codex login   然后把 ~/.codex/auth.json 整个文件内容粘进来",
        note: "用你的 ChatGPT 订阅，不按量付费。里面那个 refresh token 留在这儿，由 orchestrator 一家去刷新 —— codex 自己的 CI 文档说「别把同一份 auth.json 分给并发的任务」，而一支车队正好是十个并发。沙盒拿到的是一份形状对但值是假的 auth.json，真的 access token 由 sidecar 在出站时换上，和 claude 一样。你自己那份 ~/.codex/auth.json 我们不碰；但同一个登录在两处刷新，早晚有一边要重新登录一次。",
      },
    ],
  },
];

export function Settings() {
  const [rows, setRows] = useState<AuthRow[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);
  const [busy, setBusy] = useState(false);

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

  return (
    <div className="flex flex-col gap-4">
      <Pane>
        <Meta>环境</Meta>
        <div className="mt-2 flex flex-col gap-2">
          {checks.map((c) => (
            <div key={c.name} className="flex items-start gap-2 text-[0.8125rem]">
              <Badge tone={c.ok ? "muted" : "bad"}>{c.ok ? "OK" : "缺"}</Badge>
              <div className="min-w-0">
                <div className="text-ink-1">
                  {c.name} <span className="text-ink-3">— {c.detail}</span>
                </div>
                {!c.ok && c.fix && (
                  <div className="mt-0.5 break-all font-mono text-[0.75rem] text-ink-3">{c.fix}</div>
                )}
              </div>
            </div>
          ))}
          {!checks.length && <div className="text-[0.8125rem] text-ink-3">检查中…</div>}
        </div>
      </Pane>

      {RUNTIMES.map((g) => (
        <RuntimeAuth
          key={g.key}
          guide={g}
          current={rows.find((r) => r.runtime === g.key)}
          busy={busy}
          onSave={async (payload) => {
            setBusy(true);
            await post("/api/auth", { runtime: g.key, ...payload });
            setBusy(false);
            void load();
          }}
        />
      ))}
    </div>
  );
}

function RuntimeAuth(props: {
  guide: RuntimeGuide;
  current?: AuthRow;
  busy: boolean;
  onSave: (p: { mode: string; secret: string; baseUrl?: string }) => Promise<void>;
}) {
  const g = props.guide;
  const [mode, setMode] = useState<Mode>(props.current?.mode ?? g.modes[0]!.mode);
  const [secret, setSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState(props.current?.baseUrl ?? "");
  const [loggingIn, setLoggingIn] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const chosen = g.modes.find((m) => m.mode === mode) ?? g.modes[0]!;

  return (
    <Pane>
      <Meta>{g.label}</Meta>
      {/* Where the value comes from, next to the box that wants it. */}
      <div className="mt-2 rounded border border-rule-soft bg-sunk p-2">
        <div className="font-mono text-[0.75rem] text-ink-1">{chosen.how}</div>
        <div className="mt-1 text-[0.75rem] text-ink-3">{chosen.note}</div>
      </div>
      {props.current && (
        <div className="mt-2 text-[0.75rem] text-ink-3">
          现在用的是 <span className="font-mono">{props.current.mode}</span>{" "}
          <span className="font-mono">{props.current.hint}</span>，{clock(props.current.updatedAt)} 配的
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          className="rounded border border-rule bg-paper px-2 py-1 text-[0.8125rem] text-ink-1"
          value={mode}
          onChange={(e) => setMode(e.target.value as Mode)}
        >
          {g.modes.map((m) => (
            <option key={m.mode} value={m.mode}>
              {m.label}
            </option>
          ))}
        </select>
        {mode === "chatgpt" ? (
          <textarea
            className="min-h-24 w-full rounded border border-rule bg-paper px-2 py-1 font-mono text-[0.75rem] text-ink-1"
            placeholder="~/.codex/auth.json 的完整内容"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        ) : (
          <input
            className="min-w-0 flex-1 rounded border border-rule bg-paper px-2 py-1 font-mono text-[0.8125rem] text-ink-1"
            type="password"
            placeholder="粘贴进来，存下就看不到了"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        )}
      </div>
      {mode === "api_key" && (
        <input
          className="mt-2 w-full rounded border border-rule bg-paper px-2 py-1 font-mono text-[0.8125rem] text-ink-1"
          placeholder="base URL（可选，兼容端点填这里）"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          variant="go"
          disabled={props.busy || !secret.trim()}
          onClick={async () => {
            await props.onSave({ mode, secret: secret.trim(), baseUrl: baseUrl.trim() || undefined });
            setSecret("");
          }}
        >
          存下
        </Button>
        {g.canLogin === mode && (
          <Button
            disabled={loggingIn}
            onClick={async () => {
              setLoggingIn(true);
              setLink(null);
              const r = await post("/api/auth/login", { runtime: g.key });
              let url: string | null = null;
              try {
                url = r.ok ? (JSON.parse(r.text).url ?? null) : null;
              } catch {
                url = null;
              }
              setLink(url);
              // Opened for you, and shown as text as well: a popup blocker
              // swallowing the one actionable thing on the page is worse than
              // a link nobody clicks.
              if (url) window.open(url, "_blank", "noopener");
            }}
          >
            {loggingIn ? "等浏览器…" : "点这里登录"}
          </Button>
        )}
        <div className="text-[0.75rem] text-ink-3">
          {g.canLogin === mode
            ? "「点这里登录」直接在这台机器上跑一次官方 CLI 的登录，不用你自己敲命令、不用复制粘贴。"
            : "存下会回收所有正在跑的沙盒（它们的 sidecar 里还是旧凭据），下一轮自动重建。"}
        </div>
      </div>
      {link && (
        <div className="mt-2 break-all text-[0.75rem] text-ink-3">
          浏览器没自己打开的话，手动开这个：<span className="font-mono text-ink-1">{link}</span>
          <div className="mt-1">批准之后凭据会自己存下 —— 这一页会自己变。</div>
        </div>
      )}
      {mode === "api_key" && (
        <div className="mt-2 text-[0.75rem] text-ink-3">
          用 API key 的话顶上不显示 5 小时/周额度 —— 那两个数只有订阅账号才报。
        </div>
      )}
    </Pane>
  );
}
