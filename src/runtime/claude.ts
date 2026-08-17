import { shq } from "../platform/process/shell.ts";
import { runLineStream } from "./line-stream.ts";
import { consumeClaudeLine, newClaudeAccumulator, parseClaudeLine, trimForLog } from "./providers/claude-events.ts";
import type { TurnHandlers, TurnResult, TurnSpec } from "./providers/contract.ts";

export {
  claudeUsage,
  summarizeTool,
  trimForLog,
  UsageSchema,
} from "./providers/claude-events.ts";
export type {
  RateLimitInfo,
  ToolSummary,
  TurnHandlers,
  TurnResult,
  TurnRunner,
  TurnSpec,
  Usage,
} from "./providers/contract.ts";

/** A unique prompt file prevents concurrent turns in one sandbox from overwriting each other. */
export const promptPath = (): string => `/tmp/orch-prompt-${crypto.randomUUID()}.txt`;

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
  const tail = await runLineStream(spec, command, handlers.onAbort, (raw) => {
    const line = parseClaudeLine(raw);
    consumeClaudeLine(line, accumulator, handlers);
    return trimForLog(line);
  });

  if (!accumulator.sawResult) {
    accumulator.result.ok = false;
    accumulator.result.terminalReason ||= "no_result";
    accumulator.result.text ||= tail.err.trim().split("\n").slice(-5).join("\n");
  }
  return accumulator.result;
}

export { buildArgv as buildClaudeArgv, runTurn as runClaudeTurn };
