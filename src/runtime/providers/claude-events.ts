import { z } from "zod";
import { type Json, JsonObject, JsonValue, jsonOr } from "../../contracts/json.ts";
import { clip } from "../../platform/process/text.ts";
import type { ToolSummary, TurnHandlers, TurnResult, TurnSpec, Usage } from "./contract.ts";

const Input = z
  .object({
    command: z.string().optional(),
    file_path: z.string().optional(),
    pattern: z.string().optional(),
    prompt: z.string().optional(),
  })
  .catchall(JsonValue);
export type ToolInput = z.infer<typeof Input>;
type JsonMap = z.infer<typeof JsonObject>;

const MessageBlock = z
  .object({
    type: z.string(),
    name: z.string().optional(),
    text: z.string().optional(),
    content: JsonValue.optional(),
    input: Input.optional(),
  })
  .catchall(JsonValue);

export const UsageSchema = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
    output_tokens_details: z.object({ thinking_tokens: z.number().optional() }).optional(),
  })
  .catchall(JsonValue)
  .catch({});

const LineSchema = z
  .object({
    type: z.string(),
    subtype: z.string().optional(),
    session_id: z.string().optional(),
    status: z.string().optional(),
    message: z
      .object({ content: z.array(MessageBlock).optional() })
      .catchall(JsonValue)
      .optional(),
    tool_use_result: z
      .object({ stdout: z.string().optional(), stderr: z.string().optional(), interrupted: z.boolean().optional() })
      .catchall(JsonValue)
      .optional(),
    event: z
      .object({
        type: z.string(),
        delta: z.object({ type: z.string(), text: z.string().optional(), thinking: z.string().optional() }).optional(),
        content_block: z.object({ type: z.string(), name: z.string().optional(), input: Input.optional() }).optional(),
      })
      .catchall(JsonValue)
      .optional(),
    rate_limit_info: z
      .object({
        status: z.string(),
        rateLimitType: z.string(),
        resetsAt: z.number(),
        overageStatus: z.string().optional(),
        isUsingOverage: z.boolean().optional(),
        fiveHourPercent: z.number().optional(),
        weeklyPercent: z.number().optional(),
        weeklyResetsAt: z.number().optional(),
      })
      .catchall(JsonValue)
      .optional(),
    is_error: z.boolean().optional(),
    terminal_reason: z.string().optional(),
    result: z.string().optional(),
    num_turns: z.number().optional(),
    usage: UsageSchema.optional(),
    modelUsage: z.record(z.string(), z.object({ contextWindow: z.number().optional() }).catchall(JsonValue)).optional(),
  })
  .catchall(JsonValue);

export type Line = z.infer<typeof LineSchema>;

export interface ClaudeAccumulator {
  result: TurnResult;
  sawResult: boolean;
  files: Set<string>;
}

export function claudeUsage(raw: Json = {}): Usage {
  const parsed = UsageSchema.safeParse(raw);
  const usage = parsed.success ? parsed.data : {};
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheCreate: usage.cache_creation_input_tokens ?? 0,
    thinking: usage.output_tokens_details?.thinking_tokens ?? 0,
  };
}

export function newClaudeAccumulator(spec: TurnSpec): ClaudeAccumulator {
  return {
    sawResult: false,
    files: new Set(),
    result: {
      sessionId: spec.resumeSessionId ?? spec.newSessionId ?? "",
      ok: false,
      terminalReason: "",
      text: "",
      usage: claudeUsage(),
      numTurns: 0,
      toolSummaries: [],
      filesTouched: [],
      ...(spec.logPath === undefined ? {} : { logPath: spec.logPath }),
    },
  };
}

type EventConsumer = (line: Line, accumulator: ClaudeAccumulator, handlers: TurnHandlers) => void;

const consumeSystem: EventConsumer = (line, accumulator, handlers) => {
  if (line.session_id) accumulator.result.sessionId = line.session_id;
  if (line.subtype === "status" && line.status) handlers.onStatus?.(line.status);
};

const consumeRateLimit: EventConsumer = (line, accumulator) => {
  const info = line.rate_limit_info;
  if (!info) return;
  accumulator.result.rateLimit = {
    status: info.status,
    rateLimitType: info.rateLimitType,
    resetsAt: info.resetsAt,
    ...(info.overageStatus === undefined ? {} : { overageStatus: info.overageStatus }),
    ...(info.isUsingOverage === undefined ? {} : { isUsingOverage: info.isUsingOverage }),
    ...(info.fiveHourPercent === undefined ? {} : { fiveHourPercent: info.fiveHourPercent }),
    ...(info.weeklyPercent === undefined ? {} : { weeklyPercent: info.weeklyPercent }),
    ...(info.weeklyResetsAt === undefined ? {} : { weeklyResetsAt: info.weeklyResetsAt }),
  };
};

function consumeDelta(event: NonNullable<Line["event"]>, handlers: TurnHandlers): void {
  const delta = event.delta;
  if (delta?.type === "text_delta" && delta.text) handlers.onText?.(delta.text);
  else if (delta?.type === "thinking_delta" && delta.thinking) handlers.onThinking?.(delta.thinking);
}

const consumeStreamEvent: EventConsumer = (line, accumulator, handlers) => {
  const event = line.event;
  if (!event) return;
  if (event.type === "content_block_delta") return consumeDelta(event, handlers);
  if (event?.type !== "content_block_start" || event.content_block?.type !== "tool_use") return;
  accumulator.result.toolSummaries.push(
    summarizeTool(event.content_block.name ?? "?", inputRecord(event.content_block.input)),
  );
};

const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

function recordTool(name: string, input: ToolInput, accumulator: ClaudeAccumulator, handlers: TurnHandlers): void {
  if (WRITE_TOOLS.has(name) && typeof input.file_path === "string") accumulator.files.add(input.file_path);
  const summary = summarizeTool(name, input);
  const prior = accumulator.result.toolSummaries;
  const placeholder = prior.findIndex((tool) => tool.name === name && tool.detail === name);
  if (placeholder !== -1) prior[placeholder] = summary;
  else if (!prior.some((tool) => tool.detail === summary.detail)) prior.push(summary);
  if (summary.detail !== name) handlers.onTool?.(summary);
}

const consumeAssistant: EventConsumer = (line, accumulator, handlers) => {
  for (const block of line.message?.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") accumulator.result.text = block.text;
    if (block.type === "tool_use") {
      recordTool(String(block.name ?? "?"), inputRecord(block.input), accumulator, handlers);
    }
  }
};

const consumeUser: EventConsumer = (line, accumulator) => {
  const result = line.tool_use_result;
  const last = accumulator.result.toolSummaries.at(-1);
  if (result && last && last.ok === undefined) last.ok = !result.interrupted && !result.stderr;
};

const consumeResult: EventConsumer = (line, accumulator) => {
  const result = accumulator.result;
  accumulator.sawResult = true;
  result.ok = line.is_error !== true;
  result.terminalReason = line.terminal_reason ?? (result.ok ? "completed" : "error");
  if (typeof line.result === "string" && line.result) result.text = line.result;
  result.numTurns = line.num_turns ?? 0;
  result.usage = claudeUsage(line.usage);
  for (const model of Object.values(line.modelUsage ?? {})) {
    if (model.contextWindow) result.contextWindow = model.contextWindow;
  }
  result.filesTouched = [...accumulator.files];
};

const CONSUMERS: Record<string, EventConsumer> = {
  system: consumeSystem,
  rate_limit_event: consumeRateLimit,
  stream_event: consumeStreamEvent,
  assistant: consumeAssistant,
  user: consumeUser,
  result: consumeResult,
};

export function consumeClaudeLine(line: Line, accumulator: ClaudeAccumulator, handlers: TurnHandlers): void {
  CONSUMERS[line.type]?.(line, accumulator, handlers);
}

const LOG_RESULT_CHARS = 400;

const clipForLog = (value: Json): Json => {
  if (typeof value !== "string" || value.length <= LOG_RESULT_CHARS) return value;
  return `${value.slice(0, LOG_RESULT_CHARS)}… [${value.length} chars omitted]`;
};

export function trimForLog(line: Line): Json {
  let out: JsonMap = line;
  if (line.tool_use_result && typeof line.tool_use_result === "object") {
    const result: JsonMap = Object.fromEntries(
      Object.entries(line.tool_use_result).flatMap(([key, value]) =>
        value === undefined ? [] : [[key, clipForLog(value)]],
      ),
    );
    out = { ...out, tool_use_result: result };
  }
  const content = line.message?.content;
  if (!Array.isArray(content)) return out;
  const trimmed = content.map((block) => {
    if (block?.type !== "tool_result") return block;
    const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
    return text.length <= LOG_RESULT_CHARS
      ? block
      : { ...block, content: `${text.slice(0, LOG_RESULT_CHARS)}… [${text.length} chars omitted]` };
  });
  return JsonValue.parse({ ...out, message: { ...line.message, content: trimmed } });
}

export function summarizeTool(name: string, input: ToolInput): ToolSummary {
  const detail = toolDetail(name, input);
  return { name, detail };
}

function toolDetail(name: string, input: ToolInput): string {
  if (typeof input.command === "string") return `${name}: ${clip(unwrapShell(input.command), 90, true)}`;
  if (typeof input.file_path === "string") return `${name}: ${input.file_path}`;
  if (typeof input.pattern === "string") return `${name}: ${clip(input.pattern, 60, true)}`;
  if (typeof input.prompt === "string") return `${name}: ${clip(input.prompt, 60, true)}`;
  return name;
}

function inputRecord(value?: ToolInput): ToolInput {
  return value ?? {};
}

function unwrapShell(command: string): string {
  const match = /^\s*(?:\/[\w/.-]*)?(?:sh|bash|zsh)\s+-[a-z]*c\s+(['"])([\s\S]*)\1\s*$/.exec(command.trim());
  return (match?.[2] ?? command).trim();
}

export const parseClaudeLine = (line: string): Line =>
  jsonOr(line, LineSchema, { type: "system", subtype: "noise", status: line });
