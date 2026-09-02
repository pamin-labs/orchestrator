import { shq } from "../platform/process/shell.ts";
import { askVia, runLineStream } from "./line-stream.ts";
import { z } from "zod";
import type { AskResult, AskSpec } from "./providers/contract.ts";
import {
  claudeUsage,
  consumeClaudeLine,
  newClaudeAccumulator,
  parseClaudeLine,
  trimForLog,
  UsageSchema,
} from "./providers/claude-events.ts";
import { promptPath, type TurnHandlers, type TurnResult, type TurnSpec, type Usage } from "./providers/contract.ts";

export { summarizeTool, trimForLog } from "./providers/claude-events.ts";
export type {
  RateLimitInfo,
  ToolSummary,
  TurnHandlers,
  TurnResult,
  TurnRunner,
  TurnSpec,
  Usage,
} from "./providers/contract.ts";

function buildArgv(spec: Omit<TurnSpec, "runner">): string[] {
  const stable = spec.stable;
  const argv = [
    "-p",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--model",
    stable.model,
    "--dangerously-skip-permissions",
    "--setting-sources",
    "user,project,local",
    "--strict-mcp-config",
    "--append-system-prompt",
    stable.systemAppend,
    "--tools",
    stable.tools.join(","),
    "--exclude-dynamic-system-prompt-sections",
  ];
  if (stable.effort) argv.push("--effort", stable.effort);
  for (const directory of stable.addDirs) argv.push("--add-dir", directory);
  if (spec.resumeSessionId) argv.push("--resume", spec.resumeSessionId);
  else if (spec.newSessionId) argv.push("--session-id", spec.newSessionId);
  if (spec.maxTurns) argv.push("--max-turns", String(spec.maxTurns));
  return argv;
}

async function runTurn(spec: TurnSpec, handlers: TurnHandlers = {}): Promise<TurnResult> {
  const promptFile = promptPath();
  await spec.runner.put(promptFile, spec.prompt);
  const command = `claude ${buildArgv(spec).map(shq).join(" ")} < ${promptFile}; rc=$?; rm -f ${promptFile}; exit $rc`;
  const accumulator = newClaudeAccumulator(spec);
  // Weighed where the bytes actually arrive, before anything trims them: what a
  // turn costs is what the provider sent, not what the log kept. A line carrying
  // `tool_use_result` is a tool's output coming back, which is the half `load.ts`
  // says is 90% of a transcript — a claim measured once by hand and never since.
  const transcript = { bytes: 0, toolBytes: 0 };
  const tail = await runLineStream(spec, command, handlers.onAbort, (raw) => {
    const line = parseClaudeLine(raw);
    transcript.bytes += raw.length;
    if (line.tool_use_result) transcript.toolBytes += raw.length;
    consumeClaudeLine(line, accumulator, handlers);
    return trimForLog(line);
  });
  accumulator.result.transcript = transcript;

  if (!accumulator.sawResult) {
    accumulator.result.ok = false;
    accumulator.result.terminalReason ||= "no_result";
    accumulator.result.text ||= tail.err.trim().split("\n").slice(-5).join("\n");
  }
  return accumulator.result;
}

const ClaudeReply = z.looseObject({
  result: z.string().optional(),
  is_error: z.boolean().optional(),
  usage: UsageSchema.optional(),
});

function readClaude(out: string): { text: string; usage?: Usage } {
  try {
    const parsed = ClaudeReply.safeParse(JSON.parse(out));
    if (!parsed.success) return { text: "" };
    const o = parsed.data;
    if (o.is_error) return { text: "" };
    return {
      text: typeof o.result === "string" ? o.result : "",
      usage: claudeUsage(o.usage),
    };
  } catch {
    // Not JSON: the CLI reports some of its own failures as plain text on stdout
    // with exit 0, so the exit code is not the check and neither is the parse.
    return { text: /^\s*Error:/.test(out) ? "" : out };
  }
}

/**
 * One prompt, one answer. The index navigator's half of this provider.
 *
 * `--output-format json` so the call reports what it spent: plain text says
 * nothing, and that is why the most frequent model call in the system was
 * invisible in every cost total. No `--max-turns 1` — measured, it makes
 * `claude -p` exit 0 with the body "Error: Reached max turns (1)", so every
 * summary in the index became that sentence and the exit code said fine.
 */
const runAsk = (spec: AskSpec): Promise<AskResult> =>
  askVia(spec, ["claude", "-p", "--output-format", "json", "--model", spec.model], readClaude);

export { buildArgv as buildClaudeArgv, readClaude, runAsk as runClaudeAsk, runTurn as runClaudeTurn };
