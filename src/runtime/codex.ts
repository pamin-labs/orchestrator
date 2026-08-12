import type { TurnHandlers, TurnResult, TurnSpec, ToolSummary } from "./claude.ts";
import { ndjsonLines, summarizeTool } from "./claude.ts";

/**
 * `codex exec --json` behind the same interface as the claude adapter.
 *
 * Same shape on purpose: a role is configuration, so which CLI runs a turn should
 * be a config choice too, not a fork in the orchestrator. Event names differ, and
 * they were read off a real run rather than guessed:
 *
 *   thread.started   { thread_id }              <- the id `codex exec resume` wants
 *   turn.started
 *   item.completed   { item: { type, ... } }    <- agent_message | command_execution | error | …
 *   turn.completed   { usage: { input_tokens, cached_input_tokens, output_tokens, … } }
 *   turn.failed      { error: { message } }
 *
 * It also prints a non-JSON banner ("Reading prompt from stdin…"), so the parser
 * has to tolerate junk lines rather than assume clean JSONL.
 */

export function buildArgv(spec: TurnSpec): string[] {
  const argv = spec.resumeSessionId
    ? ["exec", "resume", spec.resumeSessionId, "--json"]
    : ["exec", "--json"];
  argv.push("--skip-git-repo-check");
  // An empty model means "whatever the account allows": naming one is rejected
  // outright on a ChatGPT-account login, and that is not a reason to fail a turn.
  if (spec.stable.model.trim()) argv.push("-m", spec.stable.model);
  // codex sandboxes through its own config rather than a settings file, and its
  // filesystem policy is set per invocation.
  argv.push("-c", "sandbox_permissions=[]");
  return argv;
}

/** Refusal-shaped, as opposed to informational. */
const REFUSAL =
  /\b(not permitted|permission|denied|refus|forbidden|blocked|sandbox|not allowed|unauthorized|policy)\b/i;

const clip = (s: string, n = 120) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

type Line = {
  type?: string;
  thread_id?: string;
  item?: { type?: string; text?: string; message?: string; command?: string; path?: string };
  usage?: Record<string, number>;
  error?: { message?: string };
  message?: string;
};

export async function runTurn(spec: TurnSpec, h: TurnHandlers = {}): Promise<TurnResult> {
  // codex takes system-level instruction as part of the prompt: it has no
  // equivalent of --append-system-prompt, so the stable half leads the message.
  // The delta still lands last, which is what the cache cares about.
  const input = `${spec.stable.systemAppend}\n\n---\n\n${spec.prompt}`;

  const proc = Bun.spawn(["codex", ...buildArgv(spec)], {
    cwd: spec.cwd,
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
    env: spec.env ? { ...process.env, ...spec.env } : undefined,
    signal: spec.signal,
  });
  h.onPid?.(proc.pid);

  const timer = spec.timeoutMs ? setTimeout(() => proc.kill("SIGTERM"), spec.timeoutMs) : undefined;
  const log = spec.logPath ? Bun.file(spec.logPath).writer() : undefined;

  const result: TurnResult = {
    sessionId: spec.resumeSessionId ?? "",
    ok: false,
    terminalReason: "",
    text: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, thinking: 0 },
    // codex reports tokens but not money, so cost is attributed from tokens
    // upstream rather than invented here.
    costUsd: 0,
    numTurns: 0,
    permissionDenials: [],
    toolSummaries: [],
    filesTouched: [],
    logPath: spec.logPath,
  };
  const files = new Set<string>();

  try {
    for await (const raw of ndjsonLines(proc.stdout)) {
      log?.write(raw + "\n");
      if (!raw.startsWith("{")) continue; // the stdin banner and friends
      let l: Line;
      try {
        l = JSON.parse(raw) as Line;
      } catch {
        continue;
      }

      switch (l.type) {
        case "thread.started":
          if (l.thread_id) result.sessionId = l.thread_id;
          break;
        case "turn.started":
          result.numTurns++;
          break;
        case "item.completed": {
          const it = l.item ?? {};
          if (it.type === "agent_message" && it.text) {
            result.text = it.text;
            h.onText?.(it.text);
          } else if (it.type === "error") {
            // codex uses `error` items for refusals AND for notices. Live, a
            // "skill descriptions were shortened" notice became a permission
            // denial and would have escalated to the boss for nothing, so only
            // refusal-shaped messages count.
            const msg = it.message ?? "";
            if (REFUSAL.test(msg)) result.permissionDenials.push({ tool: "codex", message: msg });
            else result.toolSummaries.push({ name: "notice", detail: clip(msg) });
          } else if (it.type) {
            const t: ToolSummary = summarizeTool(it.type, {
              command: it.command,
              file_path: it.path,
            });
            result.toolSummaries.push(t);
            h.onTool?.(t);
            if (it.path) files.add(it.path);
          }
          break;
        }
        case "turn.completed": {
          const u = l.usage ?? {};
          result.usage = {
            input: u.input_tokens ?? 0,
            output: u.output_tokens ?? 0,
            cacheRead: u.cached_input_tokens ?? 0,
            cacheCreate: u.cache_write_input_tokens ?? 0,
            thinking: u.reasoning_output_tokens ?? 0,
          };
          result.ok = true;
          result.terminalReason = "completed";
          break;
        }
        case "turn.failed":
        case "error":
          result.ok = false;
          result.terminalReason = "error";
          result.text = l.error?.message ?? l.message ?? result.text;
          break;
      }
    }
    await proc.exited;
  } finally {
    if (timer) clearTimeout(timer);
    await log?.end();
  }

  result.filesTouched = [...files];
  if (!result.terminalReason) {
    const stderr = await new Response(proc.stderr).text();
    result.terminalReason = "no_result";
    result.text ||= stderr.trim().split("\n").slice(-5).join("\n");
  }
  return result;
}
