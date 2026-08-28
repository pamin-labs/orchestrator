import { clip } from "../platform/process/text.ts";
import { JsonObject, JsonValue, jsonOr } from "../contracts/json.ts";
import type { TurnHandlers, TurnResult, TurnSpec, ToolSummary, Usage } from "./claude.ts";
import { promptPath, summarizeTool } from "./claude.ts";
import { runLineStream } from "./line-stream.ts";
import { shq } from "../platform/process/shell.ts";
import { z } from "zod";

/**
 * `codex exec --json` behind the same interface as the claude adapter.
 *
 * Same shape on purpose: a role is configuration, so which CLI runs a turn is a
 * config choice rather than a fork in the orchestrator.
 */
/**
 * Event names differ and were read off a real run rather than guessed:
 * `thread.started` carries the `thread_id` that `codex exec resume` wants,
 * `item.completed` carries `item.type`, `turn.completed` carries `usage`, and
 * `turn.failed` carries `error.message`.
 *
 * It also prints a non-JSON banner, so the parser tolerates junk lines rather than
 * assuming clean JSONL.
 */

function buildArgv(spec: Omit<TurnSpec, "runner">): string[] {
  const argv = spec.resumeSessionId ? ["exec", "resume", spec.resumeSessionId, "--json"] : ["exec", "--json"];
  argv.push("--skip-git-repo-check");
  // An empty model means "whatever the account allows": naming one is rejected
  // outright on a ChatGPT-account login, and that is not a reason to fail a turn.
  if (spec.stable.model.trim()) argv.push("-m", spec.stable.model);
  if (spec.stable.effort) argv.push("-c", `model_reasoning_effort="${spec.stable.effort}"`);
  // The boss's own setup is not this agent's. Same reason as the claude adapter's
  // `--setting-sources project,local`: inheriting a personal config.toml means the
  // role's model and effort are silently overridden, and the skill catalogue is
  // prefix tax on every turn.
  argv.push("--ignore-user-config", "--ignore-rules");
  // Web search, by the same rule as the claude side: `allowedTools` is a Claude
  // Code concept, but it is the one place that records which roles may look
  // things up, and two lists would drift.
  //
  // Measured on codex-cli 0.147, all four combinations run live:
  //   - search is ON by default, so granting it needs no flag
  //   - the documented `tools.web_search=true|false` key is ignored entirely —
  //     `false` still searched, which is the failure worth knowing about
  //   - `web_search="disabled"` works, and `web_search="live"` works
  // So this is written as a denial, not a grant. Everything else in the sandbox
  // is deny-only for the same reason: the default has to be the safe one.
  argv.push("-c", spec.stable.allowedTools.includes("WebSearch") ? 'web_search="live"' : 'web_search="disabled"');
  // No sandbox flags. The container is the boundary; asking the CLI to confine
  // itself inside one is the arrangement that produced silent refusals, a
  // no-op `sandbox_permissions` key and a macOS-only network override.
  argv.push("--dangerously-bypass-approvals-and-sandbox");
  for (const img of spec.images ?? []) argv.push("-i", img);
  return argv;
}

/**
 * What goes on disk, minus the command output.
 *
 * Same finding as the claude adapter's trimForLog, one CLI over: a turn's NDJSON
 * is mostly command output, and every measurement worth having from these files is
 * about shape — how many rounds, which tools, how many tokens, what failed. This
 * adapter was writing the raw line, so it kept all of it. Claude's version cannot
 * be reused: it trims `tool_use_result` and `message.content`, neither of which
 * codex emits. Everything long lands under `item`, so that is what gets clipped.
 */
const LOG_ITEM_CHARS = 400;
export type JsonMap = z.infer<typeof JsonObject>;

export function trimItem(l: JsonMap): JsonMap {
  const item = JsonObject.safeParse(l.item);
  if (!item.success) return l;
  const out: JsonMap = {};
  for (const [k, v] of Object.entries(item.data)) {
    out[k] =
      typeof v === "string" && v.length > LOG_ITEM_CHARS
        ? `${v.slice(0, LOG_ITEM_CHARS)}… [${v.length} chars omitted]`
        : v;
  }
  return { ...l, item: out };
}

const Counter = z.number().nonnegative();
const UsageSchema = z
  .object({
    input_tokens: Counter.optional(),
    cached_input_tokens: Counter.optional(),
    cache_write_input_tokens: Counter.optional(),
    output_tokens: Counter.optional(),
    reasoning_output_tokens: Counter.optional(),
  })
  .catchall(JsonValue);
const WindowSchema = z
  .object({
    used_percent: Counter.max(100).optional(),
    window_minutes: Counter.optional(),
    resets_in_seconds: Counter.optional(),
  })
  .catchall(JsonValue);
type Window = z.infer<typeof WindowSchema>;

/** One valid Codex NDJSON event. Unknown fields remain available to the log. */
const LineSchema = z
  .object({
    type: z.string(),
    thread_id: z.string().optional(),
    item: z
      .object({
        type: z.string().optional(),
        text: z.string().optional(),
        message: z.string().optional(),
        command: z.string().optional(),
        path: z.string().optional(),
      })
      .catchall(JsonValue)
      .optional(),
    usage: UsageSchema.optional(),
    error: z.object({ message: z.string().optional() }).catchall(JsonValue).optional(),
    message: z.string().optional(),
    /** token_count carries the account's own quota state, both windows, as percentages. */
    rate_limits: z
      .object({ primary: WindowSchema.optional(), secondary: WindowSchema.optional() })
      .catchall(JsonValue)
      .optional(),
    info: z.object({ model_context_window: Counter.optional() }).catchall(JsonValue).nullable().optional(),
  })
  .catchall(JsonValue);
type Line = z.infer<typeof LineSchema>;

/**
 * What one codex turn cost, in the shape the rest of the system bills in.
 *
 * `input_tokens` here is the whole prompt, cached part included — the opposite of
 * claude, whose `input_tokens` counts only what the cache missed. Reporting
 * codex's total under the same name made one number wrong in three places: the
 * cache ratio, the budget (double-counting cached tokens), and the rotation
 * ceiling, which a single 438k turn cleared — so every codex agent started a new
 * session every turn and re-read the repo to find out where it was.
 */
/**
 * Exported because that subtraction is the difference between the two runtimes and
 * it is written down once. `pageindex.ts` had a second copy that took the two
 * shapes as a pair of key names — exactly the part that is *not* shared — and so
 * billed the indexer, the most frequent model call in the system, twice for its
 * cached tokens.
 */
export function codexUsage(u: z.infer<typeof UsageSchema> = {}): Usage {
  return {
    input: Math.max(0, (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0)),
    output: u.output_tokens ?? 0,
    cacheRead: u.cached_input_tokens ?? 0,
    cacheCreate: u.cache_write_input_tokens ?? 0,
    thinking: u.reasoning_output_tokens ?? 0,
  };
}

async function runTurn(spec: TurnSpec, h: TurnHandlers = {}): Promise<TurnResult> {
  // codex has no --append-system-prompt, so the stable half leads the first
  // message of a thread. It must NOT lead the rest: `codex exec resume` replays
  // the thread server-side, so re-sending the role prompt, the contract, the
  // onboarding pack and the lessons every turn both pays for them again and moves
  // the boundary of what the provider can match as an unchanged prefix — the
  // opposite of what resuming is for. A changed stable half rotates the session
  // (needsRotation compares the hash), which is where the new one gets sent.
  const input = spec.resumeSessionId ? spec.prompt : `${spec.stable.systemAppend}\n\n---\n\n${spec.prompt}`;

  // No stdin on the exec API, so the prompt travels as a file in the sandbox.
  // One file per call — a project sandbox is shared by every standing role.
  const promptFile = promptPath();
  await spec.runner.put(promptFile, input);
  const cmd = `codex ${buildArgv(spec).map(shq).join(" ")} < ${promptFile}; rc=$?; rm -f ${promptFile}; exit $rc`;

  const result: TurnResult = {
    sessionId: spec.resumeSessionId ?? "",
    ok: false,
    terminalReason: "",
    text: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, thinking: 0 },
    numTurns: 0,
    toolSummaries: [],
    filesTouched: [],
    ...(spec.logPath === undefined ? {} : { logPath: spec.logPath }),
  };
  const files = new Set<string>();

  // Weighed as it arrives, before anything trims it: what a turn costs is what the
  // provider sent. A completed item that is neither the model's own message nor an
  // error is a tool's output coming back, which is the half `load.ts` calls 90% of
  // a transcript — a claim measured once by hand and never since.
  const transcript = { bytes: 0, toolBytes: 0 };
  const tail = await runLineStream(spec, cmd, h.onAbort, (raw) => {
    if (!raw.startsWith("{")) return undefined; // banners and friends
    const l = jsonOr(raw, LineSchema.nullable(), null);
    if (!l) return undefined;
    transcript.bytes += raw.length;
    if (isToolItem(l)) transcript.toolBytes += raw.length;
    consume(l, result, files, h);
    return trimItem(l);
  });
  result.transcript = transcript;

  result.filesTouched = [...files];
  if (!result.terminalReason) {
    result.terminalReason = "no_result";
    result.text ||= tail.err.trim().split("\n").slice(-5).join("\n");
  }
  return result;
}

export { buildArgv as buildCodexArgv, runTurn as runCodexTurn };

/** The same cut `consumeItem` makes, asked of the raw line: everything that is
 *  not the model talking and not an error is a tool reporting back. */
const isToolItem = (l: Line): boolean =>
  l.type === "item.completed" && !!l.item?.type && l.item.type !== "agent_message" && l.item.type !== "error";

function consume(l: Line, result: TurnResult, files: Set<string>, h: TurnHandlers): void {
  if (l.type === "item.completed") {
    consumeItem(l.item ?? {}, result, files, h);
  } else if (l.type === "token_count") {
    consumeTokenCount(l, result);
  } else {
    consumeTurn(l, result);
  }
}

function consumeTurn(l: Line, result: TurnResult): void {
  if (l.type === "thread.started") {
    if (l.thread_id) result.sessionId = l.thread_id;
  } else if (l.type === "turn.started") {
    result.numTurns++;
  } else {
    consumeTurnResult(l, result);
  }
}

function consumeTurnResult(l: Line, result: TurnResult): void {
  if (l.type === "turn.completed") {
    result.usage = codexUsage(l.usage);
    result.ok = true;
    result.terminalReason = "completed";
    return;
  }
  if (l.type !== "turn.failed" && l.type !== "error") return;
  result.ok = false;
  result.terminalReason = "error";
  result.text = failureText(l, result.text);
}

function failureText(l: Line, fallback: string): string {
  return l.error?.message ?? l.message ?? fallback;
}

function consumeItem(it: NonNullable<Line["item"]>, result: TurnResult, files: Set<string>, h: TurnHandlers): void {
  if (it.type === "agent_message" && it.text) {
    consumeAgentMessage(it.text, result, h);
  } else if (it.type === "error") {
    consumeNotice(it.message, result);
  } else {
    consumeTool(it, result, files, h);
  }
}

function consumeAgentMessage(text: string, result: TurnResult, h: TurnHandlers): void {
  result.text = text;
  h.onText?.(text);
}

function consumeNotice(message: string | undefined, result: TurnResult): void {
  result.toolSummaries.push({ name: "notice", detail: clip(message ?? "", 120, true) });
}

function consumeTool(it: NonNullable<Line["item"]>, result: TurnResult, files: Set<string>, h: TurnHandlers): void {
  if (!it.type) return;
  const t: ToolSummary = summarizeTool(it.type, toolDetails(it));
  result.toolSummaries.push(t);
  h.onTool?.(t);
  if (it.path) files.add(it.path);
}

function toolDetails(it: NonNullable<Line["item"]>) {
  return {
    ...(it.command ? { command: it.command } : {}),
    ...(it.path ? { file_path: it.path } : {}),
  };
}

function consumeTokenCount(l: Line, result: TurnResult): void {
  // The only place either CLI hands over a real quota percentage. primary
  // is the 5-hour window (299 minutes), secondary the weekly one (10079).
  // The same event carries the model's real context window, which is the
  // denominator session rotation needs — 272000 for the gpt-5.6 family.
  if (l.info?.model_context_window) result.contextWindow = l.info.model_context_window;
  consumeRateLimit(l.rate_limits, result);
}

function consumeRateLimit(limits: Line["rate_limits"], result: TurnResult): void {
  if (!limits) return;
  const { primary, secondary } = limits;
  if (!primary && !secondary) return;
  const now = Math.floor(Date.now() / 1000);
  const fiveHourPercent = windowPercent(primary);
  const weeklyPercent = windowPercent(secondary);
  const weeklyResetsAt = weeklyResetAt(secondary, now);
  result.rateLimit = {
    status: "allowed",
    rateLimitType: "five_hour",
    resetsAt: resetAt(primary, now),
    ...(fiveHourPercent === undefined ? {} : { fiveHourPercent }),
    ...(weeklyPercent === undefined ? {} : { weeklyPercent }),
    ...(weeklyResetsAt === undefined ? {} : { weeklyResetsAt }),
  };
}

function resetAt(window: Window | undefined, now: number): number {
  return now + (window?.resets_in_seconds ?? 0);
}

function windowPercent(window: Window | undefined): number | undefined {
  return window?.used_percent;
}

function weeklyResetAt(window: Window | undefined, now: number): number | undefined {
  if (!window) return undefined;
  return now + (window.resets_in_seconds ?? 0);
}
