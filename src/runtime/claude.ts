import type { StablePrompt } from "../prompt/assemble.ts";
import { shq } from "../mech/util/shq.ts";

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
  /**
   * How much of each subscription window is gone, 0-100.
   *
   * codex volunteers both in every `token_count` event. claude's stream never
   * carries a percentage — 267 real rate_limit_events in this repo's logs had
   * only status and a reset time — so on that side these are filled in by
   * mech/ops/subusage.ts and the fields stay undefined when it cannot reach the API.
   */
  fiveHourPercent?: number;
  weeklyPercent?: number;
  /** Unix seconds, per window. `resetsAt` above stays the five-hour one. */
  weeklyResetsAt?: number;
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
  numTurns: number;
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
  /** Called once the turn is running, so intercept L3 can stop it. */
  onAbort?: (abort: () => void) => void;
}

/**
 * How a turn actually runs.
 *
 * The CLI runs inside the group's sandbox, not on this machine, so an adapter
 * cannot spawn — it hands a command to whoever owns the boundary. Two methods
 * because that is all a turn needs: somewhere to put the prompt (the exec API
 * has no stdin) and a stream of stdout lines to parse.
 *
 * `mech/sandbox/sandbox.ts` implements it; tests pass a fake.
 */
export interface TurnRunner {
  /** Write a file inside the sandbox. Cheap — measured at ~5ms. */
  put(path: string, data: string): Promise<void>;
  /** Run a shell command, yielding stdout a line at a time. */
  lines(
    cmd: string,
    opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string>; signal?: AbortSignal },
  ): AsyncGenerator<string, { code: number; err: string }, void>;
}

/**
 * Where a call's prompt lands inside the sandbox — one file per call.
 *
 * It used to be a single fixed name, overwritten every turn. That held only
 * because the scheduler keys every group-less job to slot 0, so exactly one
 * standing turn runs at a time across the whole fleet and nothing else ever
 * wrote it. Both halves of that are accidents: a project sandbox is shared by
 * every standing role, and the index calls run in one too. Two writers, one
 * path, and the loser reads the other's prompt.
 */
export const promptPath = (): string => `/tmp/orch-prompt-${crypto.randomUUID()}.txt`;

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
   * Image attachments for this turn, as paths.
   *
   * Only codex needs them: it has `-i/--image` and no file-reading tool that
   * handles images, while claude opens the path with Read. Paths, never contents —
   * an inlined image is thousands of tokens on every turn that carries it.
   */
  images?: string[];
  /**
   * Extra environment for the child. This is how the agent learns where the
   * orchestrator is and who it is (ORCH_URL / ORCH_TOKEN) — identity travels in
   * the process environment, never in a request body the agent could edit.
   */
  env?: Record<string, string>;
  signal?: AbortSignal;
  /** The sandbox this turn runs in. */
  runner: TurnRunner;
}

export function buildArgv(spec: Omit<TurnSpec, "runner">): string[] {
  const s = spec.stable;
  const argv = [
    "-p",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose", // required alongside stream-json in print mode
    "--model",
    s.model,
    // The container is the boundary, so the process inside it does not need a
    // second one. This flag is what makes the deny-list profile — and every
    // silent refusal it used to cause — unnecessary.
    "--dangerously-skip-permissions",
    // `user` is included, and inside the container that means something different
    // than it did on this machine. Measured on the host, inheriting the boss's
    // global CLAUDE.md, plugins and skills pushed a trivial haiku turn to ~195k
    // cached input tokens — which is why this said `project,local` for months.
    // A turn runs in a container now, where HOME is `/root` and the only thing in
    // it is what we put there: the read-only mount of the skills the boss ticked.
    //
    // It has to be here, measured: with `project,local` the CLI does not look at
    // `$HOME/.claude/skills` at all, so the mount was invisible and every ticked
    // skill did nothing.
    "--setting-sources",
    "user,project,local",
    "--strict-mcp-config",
    "--append-system-prompt",
    s.systemAppend,
    // What is loaded, not what is permitted: `--dangerously-skip-permissions`
    // above bypasses every permission check, so `--allowedTools` alongside it is
    // inert. `--tools` is the one that pays, so this picks the built-in set.
    // `allowedTools` in the role yaml still feeds it (assemble.ts).
    //
    // `--disable-slash-commands` used to sit here too. Its help line is "Disable
    // all skills", which is exactly what it did: an agent could not use a skill at
    // all. Now the boss picks which skills get staged into the read-only mount
    // (`skills.ts`), so the catalogue in the prefix is the set that was ticked
    // rather than the ~180 on the boss's machine that measured ~46k tokens.
    "--tools",
    s.tools.join(","),
  ];
  // Already clamped to what this provider accepts (providers.ts), because effort
  // is part of the hashed prefix and the hash has to describe what was sent.
  if (s.effort) argv.push("--effort", s.effort);
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
  usage?: Record<string, any>;
  modelUsage?: Record<string, { contextWindow?: number }>;
};

const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

export async function runTurn(spec: TurnSpec, h: TurnHandlers = {}): Promise<TurnResult> {
  // The exec API has no stdin, so the prompt travels as a file. It is the same
  // bytes either way, and the agent can already read everything in its own
  // sandbox.
  const promptFile = promptPath();
  await spec.runner.put(promptFile, spec.prompt);
  // Removed by the shell that read it: nothing else knows when this file stops
  // being needed, and a `/tmp` full of transcripts is the container's problem.
  const cmd = `claude ${buildArgv(spec).map(shq).join(" ")} < ${promptFile}; rc=$?; rm -f ${promptFile}; exit $rc`;

  const ac = new AbortController();
  spec.signal?.addEventListener("abort", () => ac.abort(), { once: true });
  h.onAbort?.(() => ac.abort());

  const log = spec.logPath ? Bun.file(spec.logPath).writer() : undefined;
  const acc = newAccumulator(spec);

  const stream = spec.runner.lines(cmd, {
    cwd: spec.cwd,
    timeoutMs: spec.timeoutMs,
    env: spec.env,
    signal: ac.signal,
  });
  let tail = { code: -1, err: "" };
  try {
    while (true) {
      const step = await stream.next();
      if (step.done) {
        tail = step.value;
        break;
      }
      const line = safeParse(step.value);
      log?.write(JSON.stringify(trimForLog(line)) + "\n");
      consume(line, acc, h);
    }
  } finally {
    await log?.end();
  }

  if (!acc.sawResult) {
    acc.result.ok = false;
    acc.result.terminalReason = acc.result.terminalReason || "no_result";
    acc.result.text ||= tail.err.trim().split("\n").slice(-5).join("\n");
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
      numTurns: 0,
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
  if (typeof input.command === "string") detail = `${name}: ${clip(unwrapShell(input.command), 90)}`;
  else if (typeof input.file_path === "string") detail = `${name}: ${input.file_path}`;
  else if (typeof input.pattern === "string") detail = `${name}: ${clip(input.pattern, 60)}`;
  else if (typeof input.prompt === "string") detail = `${name}: ${clip(input.prompt, 60)}`;
  return { name, detail };
}

/**
 * The command the agent meant, without the shell it was handed to.
 *
 * codex reports every command as `/bin/zsh -lc '…'`, so the desk wall showed
 * eleven characters of shell before the part that says what is happening — and
 * with the line clipped at 90, that boilerplate was crowding out the end of every
 * `orch ctx query`. Also drops a `2>&1 | head -40` tail for the same reason.
 */
function unwrapShell(cmd: string): string {
  const m = /^\s*(?:\/[\w/.-]*)?(?:sh|bash|zsh)\s+-[a-z]*c\s+(['"])([\s\S]*)\1\s*$/.exec(cmd.trim());
  return (m?.[2] ?? cmd).trim();
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
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
