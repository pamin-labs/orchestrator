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
  mode: "oauth_token" | "api_key";
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

const RUNTIMES: [string, string, string][] = [
  ["claude", "Claude", "claude setup-token 产出的一年期 token，或者 API key"],
  ["codex", "Codex", "OpenAI API key，或者 ~/.codex/auth.json 里的那一串"],
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

      {RUNTIMES.map(([runtime, label, help]) => {
        const cur = rows.find((r) => r.runtime === runtime);
        return (
          <RuntimeAuth
            key={runtime}
            runtime={runtime}
            label={label}
            help={help}
            current={cur}
            busy={busy}
            onSave={async (payload) => {
              setBusy(true);
              await post("/api/auth", { runtime, ...payload });
              setBusy(false);
              void load();
            }}
          />
        );
      })}
    </div>
  );
}

function RuntimeAuth(props: {
  runtime: string;
  label: string;
  help: string;
  current?: AuthRow;
  busy: boolean;
  onSave: (p: { mode: string; secret: string; baseUrl?: string }) => Promise<void>;
}) {
  const [mode, setMode] = useState<"oauth_token" | "api_key">(props.current?.mode ?? "oauth_token");
  const [secret, setSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState(props.current?.baseUrl ?? "");

  return (
    <Pane>
      <Meta>{props.label}</Meta>
      <div className="mt-1 text-[0.75rem] text-ink-3">{props.help}</div>
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
          onChange={(e) => setMode(e.target.value as "oauth_token" | "api_key")}
        >
          <option value="oauth_token">订阅 token</option>
          <option value="api_key">API key</option>
        </select>
        <input
          className="min-w-0 flex-1 rounded border border-rule bg-paper px-2 py-1 font-mono text-[0.8125rem] text-ink-1"
          type="password"
          placeholder="粘贴进来，存下就看不到了"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
      </div>
      {mode === "api_key" && (
        <input
          className="mt-2 w-full rounded border border-rule bg-paper px-2 py-1 font-mono text-[0.8125rem] text-ink-1"
          placeholder="base URL（可选，兼容端点填这里）"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      )}
      <div className="mt-3 flex items-center gap-3">
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
        <div className="text-[0.75rem] text-ink-3">
          存下会回收所有正在跑的沙盒（它们的 sidecar 里还是旧凭据），下一轮自动重建。
        </div>
      </div>
      {mode === "api_key" && (
        <div className="mt-2 text-[0.75rem] text-ink-3">
          用 API key 的话顶上不显示 5 小时/周额度 —— 那两个数只有订阅账号才报。
        </div>
      )}
    </Pane>
  );
}
