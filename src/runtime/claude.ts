import type { StablePrompt } from "../prompt/assemble.ts";

/**
 * `claude -p` as one subprocess per turn.
 *
 * Chosen over the Agent SDK because swapping the model per turn is just a flag
 * (needed for per-slice difficulty tiering), a crashed turn cannot take the
 * orchestrator with it, and codex has the same shape (`codex exec resume`).
 *
 * Field names below were read off a real run, not guessed — see PLAN.md §5.
 */

export interface RateLimitInfo {
  status: string;
  rateLimitType: string;
  resetsAt: number;
  overageStatus?: string;
  isUsingOverage?: boolean;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  thinking: number;
}

export interface ToolSummary {
  name: string;
  /** One-line rendering of the call, for the timeline. Never the full input. */
  detail: string;
  ok?: boolean;
}

export interface TurnResult {
  sessionId: string;
  ok: boolean;
  /** completed | max_turns | api_error | … — straight from the CLI. */
  terminalReason: string;
  /** Final assistant text. */
  text: string;
  usage: Usage;
  costUsd: number;
  numTurns: number;
  /**
   * Non-empty means the agent tried something its clearance forbids. Headless
   * runs never prompt, so a denial is silent and the agent will invent a
   * workaround — the orchestrator turns these into escalations (PLAN.md §5).
   */
  permissionDenials: unknown[];
  /** Present when the CLI reported quota state; drives downgrade/suspend. */
  rateLimit?: RateLimitInfo;
  /** From modelUsage — the denominator for session rotation. */
  contextWindow?: number;
  toolSummaries: ToolSummary[];
  /** Paths the turn wrote, for narration and reconcile. */
  filesTouched: string[];
  /** Raw NDJSON path, if the caller asked for one. */
  logPath?: string;
}

export interface TurnHandlers {
  /** Streamed assistant text, for the live SSE feed. */
  onText?: (chunk: string) => void;
  /** Streamed thinking, if the role has thinking enabled. */
  onThinking?: (chunk: string) => void;
  /** A tool call started — drives the desk wall's "currently running" line. */
  onTool?: (t: ToolSummary) => void;
  /** The CLI's own status pings (requesting, …). */
  onStatus?: (status: string) => void;
  /** Called once the child exists, so intercept L3 can kill it. */
  onPid?: (pid: number) => void;
}

export interface TurnSpec {
  stable: StablePrompt;
  prompt: string;
  cwd: string;
  /** Continue this session. Omit to start one (pass `newSessionId` instead). */
  resumeSessionId?: string;
  /** Force a specific id for a fresh session, so we can record it up front. */
  newSessionId?: string;
  maxTurns?: number;
  /** Wall-clock cap; the watchdog also enforces one at the job level. */
  timeoutMs?: number;
  /** Write raw NDJSON here for later inspection (never into the context). */
  logPath?: string;
  /**
   * Extra environment for the child. This is how the agent learns where the
   * orchestrator is and who it is (ORCH_URL / ORCH_TOKEN) — identity travels in
   * the process environment, never in a request body the agent could edit.
   */
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export function buildArgv(spec: TurnSpec): string[] {
  const s = spec.stable;
  const argv = [
    "-p",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose", // required alongside stream-json in print mode
    "--model",
    s.model,
    "--settings",
    s.settingsPath,
    "--permission-mode",
    "acceptEdits",
    // Exclude user-level settings. Measured: inheriting the boss's global
    // CLAUDE.md, plugins and skills pushed a trivial haiku turn to ~195k cached
    // input tokens. Agents should follow their role prompt, not the boss's
    // personal setup.
    "--setting-sources",
    "project,local",
    "--strict-mcp-config",
    "--append-system-prompt",
    s.systemAppend,
    // `--allowedTools` gates permission; it does NOT trim the tool definitions
    // injected into the prompt. Measured: the built-in set plus skills and slash
    // commands is ~46k cached tokens of prefix on every turn. `--tools` picks
    // the built-in set, and `--disable-slash-commands` drops the skill catalogue.
    "--tools",
    s.tools.join(","),
    "--disable-slash-commands",
    "--allowedTools",
    ...s.allowedTools,
  ];
  for (const d of s.addDirs) argv.push("--add-dir", d);
  if (spec.resumeSessionId) argv.push("--resume", spec.resumeSessionId);
  else if (spec.newSessionId) argv.push("--session-id", spec.newSessionId);
  if (spec.maxTurns) argv.push("--max-turns", String(spec.maxTurns));
  return argv;
}

/** One line of stream-json. Only the fields we consume are typed. */
type Line = {
  type: string;
  subtype?: string;
  session_id?: string;
  status?: string;
  message?: { content?: Array<Record<string, any>> };
  tool_use_result?: { stdout?: string; stderr?: string; interrupted?: boolean };
  event?: {
    type: string;
    delta?: { type: string; text?: string; thinking?: string };
    content_block?: { type: string; name?: string; input?: Record<string, any> };
  };
  rate_limit_info?: RateLimitInfo;
  // result
  is_error?: boolean;
  terminal_reason?: string;
  result?: string;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: Record<string, any>;
  modelUsage?: Record<string, { contextWindow?: number }>;
  permission_denials?: unknown[];
};

const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

export async function runTurn(spec: TurnSpec, h: TurnHandlers = {}): Promise<TurnResult> {
  const proc = Bun.spawn(["claude", ...buildArgv(spec)], {
    cwd: spec.cwd,
    stdin: new TextEncoder().encode(spec.prompt),
    stdout: "pipe",
    stderr: "pipe",
    env: spec.env ? { ...process.env, ...spec.env } : undefined,
    signal: spec.signal,
  });
  h.onPid?.(proc.pid);

  const timer = spec.timeoutMs
    ? setTimeout(() => proc.kill("SIGTERM"), spec.timeoutMs)
    : undefined;

  const log = spec.logPath ? Bun.file(spec.logPath).writer() : undefined;
  const acc = newAccumulator(spec);

  try {
    for await (const line of ndjson(proc.stdout)) {
      log?.write(JSON.stringify(trimForLog(line)) + "\n");
      consume(line, acc, h);
    }
    await proc.exited;
  } finally {
    if (timer) clearTimeout(timer);
    await log?.end();
  }

  if (!acc.sawResult) {
    const stderr = await new Response(proc.stderr).text();
    acc.result.ok = false;
    acc.result.terminalReason = acc.result.terminalReason || "no_result";
    acc.result.text ||= stderr.trim().split("\n").slice(-5).join("\n");
  }
  return acc.result;
}

interface Acc {
  result: TurnResult;
  sawResult: boolean;
  files: Set<string>;
}

function newAccumulator(spec: TurnSpec): Acc {
  return {
    sawResult: false,
    files: new Set(),
    result: {
      sessionId: spec.resumeSessionId ?? spec.newSessionId ?? "",
      ok: false,
      terminalReason: "",
      text: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, thinking: 0 },
      costUsd: 0,
      numTurns: 0,
      permissionDenials: [],
      toolSummaries: [],
      filesTouched: [],
      logPath: spec.logPath,
    },
  };
}

function consume(l: Line, acc: Acc, h: TurnHandlers): void {
  const r = acc.result;
  switch (l.type) {
    case "system":
      if (l.session_id) r.sessionId = l.session_id;
      if (l.subtype === "status" && l.status) h.onStatus?.(l.status);
      return;

    case "rate_limit_event":
      if (l.rate_limit_info) r.rateLimit = l.rate_limit_info;
      return;

    case "stream_event": {
      const ev = l.event;
      if (!ev) return;
      if (ev.type === "content_block_delta") {
        const d = ev.delta;
        if (d?.type === "text_delta" && d.text) h.onText?.(d.text);
        else if (d?.type === "thinking_delta" && d.thinking) h.onThinking?.(d.thinking);
      } else if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
        // At content_block_start the input has not streamed yet, so this is the
        // tool's name and nothing else. Recorded, but not announced: "Bash" alone
        // on the desk wall tells the boss less than the previous line did.
        const t = summarizeTool(ev.content_block.name ?? "?", ev.content_block.input ?? {});
        r.toolSummaries.push(t);
      }
      return;
    }

    case "assistant": {
      for (const block of l.message?.content ?? []) {
        if (block.type === "text" && typeof block.text === "string") r.text = block.text;
        if (block.type === "tool_use") {
          const name = String(block.name ?? "?");
          const input = (block.input ?? {}) as Record<string, any>;
          if (WRITE_TOOLS.has(name) && typeof input.file_path === "string") {
            acc.files.add(input.file_path);
          }
          // The assistant message carries the complete input, so this is where a
          // useful one-line summary first exists. Replace the name-only
          // placeholder the stream left, then announce it.
          const full = summarizeTool(name, input);
          const placeholder = r.toolSummaries.findIndex((t) => t.name === name && t.detail === name);
          if (placeholder !== -1) r.toolSummaries[placeholder] = full;
          else if (!r.toolSummaries.some((t) => t.detail === full.detail)) r.toolSummaries.push(full);
          if (full.detail !== name) h.onTool?.(full);
        }
      }
      return;
    }

    case "user": {
      const tur = l.tool_use_result;
      const last = r.toolSummaries.at(-1);
      if (tur && last && last.ok === undefined) {
        last.ok = !tur.interrupted && !tur.stderr;
      }
      return;
    }

    case "result": {
      acc.sawResult = true;
      r.ok = l.is_error !== true;
      r.terminalReason = l.terminal_reason ?? (r.ok ? "completed" : "error");
      if (typeof l.result === "string" && l.result) r.text = l.result;
      r.numTurns = l.num_turns ?? 0;
      r.costUsd = l.total_cost_usd ?? 0;
      r.permissionDenials = l.permission_denials ?? [];
      const u = l.usage ?? {};
      r.usage = {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheCreate: u.cache_creation_input_tokens ?? 0,
        thinking: u.output_tokens_details?.thinking_tokens ?? 0,
      };
      for (const m of Object.values(l.modelUsage ?? {})) {
        if (m.contextWindow) r.contextWindow = m.contextWindow;
      }
      r.filesTouched = [...acc.files];
      return;
    }
  }
}

/** One short line per call — the timeline shows these, never the raw input. */
/**
 * What goes on disk, minus the part that made it 123 MB.
 *
 * A turn's NDJSON is 90% tool results — whole files, whole diffs, whole test runs —
 * and every measurement worth having from these logs is about *shape*: how many
 * rounds, which tools, how many tokens, what failed. So results keep their first
 * line and their size, and the body goes. Measured on this repo's own logs: ~10x
 * before gzip, on top of gzip's own 3.5x.
 *
 * The tool *input* is kept whole: it is small, and it is the half that says what
 * the agent was trying to do — which is what anyone reading a log afterwards is
 * looking for.
 */
const LOG_RESULT_CHARS = 400;

const clipForLog = (v: unknown): unknown => {
  if (typeof v !== "string" || v.length <= LOG_RESULT_CHARS) return v;
  return `${v.slice(0, LOG_RESULT_CHARS)}… [${v.length} chars omitted]`;
};

export function trimForLog(line: any): any {
  // `tool_use_result` is where the payload actually is: measured on a real turn,
  // 90.2% of the file, against 0% for the `tool_result` block inside `content`.
  // Trimming only the latter cut 17%, which is how a fix that looks right and is
  // aimed at the wrong field reads in a size chart.
  if (line?.tool_use_result && typeof line.tool_use_result === "object") {
    const r: any = { ...line.tool_use_result };
    for (const k of Object.keys(r)) r[k] = clipForLog(r[k]);
    line = { ...line, tool_use_result: r };
  }
  const content = line?.message?.content;
  if (!Array.isArray(content)) return line;
  const trimmed = content.map((c: any) => {
    if (c?.type !== "tool_result") return c;
    const text = typeof c.content === "string" ? c.content : JSON.stringify(c.content ?? "");
    if (text.length <= LOG_RESULT_CHARS) return c;
    return { ...c, content: `${text.slice(0, LOG_RESULT_CHARS)}… [${text.length} chars omitted]` };
  });
  return { ...line, message: { ...line.message, content: trimmed } };
}

export function summarizeTool(name: string, input: Record<string, any>): ToolSummary {
  let detail = name;
  if (typeof input.command === "string") detail = `${name}: ${clip(input.command, 90)}`;
  else if (typeof input.file_path === "string") detail = `${name}: ${input.file_path}`;
  else if (typeof input.pattern === "string") detail = `${name}: ${clip(input.pattern, 60)}`;
  else if (typeof input.prompt === "string") detail = `${name}: ${clip(input.prompt, 60)}`;
  return { name, detail };
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

/** Split a byte stream into lines, tolerating partial reads. */
export async function* ndjsonLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, unknown> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield line;
    }
  }
  const tail = buf.trim();
  if (tail) yield tail;
}

/** Split a byte stream into JSON values, one per line, tolerating partial reads. */
export async function* ndjson(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Line, void, unknown> {
  for await (const line of ndjsonLines(stream)) yield safeParse(line);
}

function safeParse(line: string): Line {
  try {
    return JSON.parse(line) as Line;
  } catch {
    // The CLI prints the occasional non-JSON line (login prompts, warnings).
    // Surfacing it as text beats crashing the turn.
    return { type: "system", subtype: "noise", status: line };
  }
}
