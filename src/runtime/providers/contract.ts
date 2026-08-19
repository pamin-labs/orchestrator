import type { StablePrompt } from "../../prompt/assemble.ts";

/**
 * A type alias, not an interface, and that is load-bearing: this is written
 * straight into a `jsonb` column typed `Json`, and only an object *type* gets the
 * implicit index signature that assignment needs. As an interface the write does
 * not compile, and the shortcut around it is a cast.
 */
export type RateLimitInfo = {
  status: string;
  rateLimitType: string;
  resetsAt: number;
  overageStatus?: string;
  isUsingOverage?: boolean;
  fiveHourPercent?: number;
  weeklyPercent?: number;
  weeklyResetsAt?: number;
};

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
  terminalReason: string;
  text: string;
  usage: Usage;
  numTurns: number;
  rateLimit?: RateLimitInfo;
  contextWindow?: number;
  toolSummaries: ToolSummary[];
  filesTouched: string[];
  logPath?: string;
}

export interface TurnHandlers {
  onText?: (chunk: string) => void;
  onThinking?: (chunk: string) => void;
  onTool?: (tool: ToolSummary) => void;
  onStatus?: (status: string) => void;
  onAbort?: (abort: () => void) => void;
}

export interface TurnRunner {
  put(path: string, data: string): Promise<void>;
  lines(
    cmd: string,
    opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string>; signal?: AbortSignal },
  ): AsyncGenerator<string, { code: number; err: string }, void>;
}

export interface TurnSpec {
  stable: StablePrompt;
  prompt: string;
  cwd: string;
  resumeSessionId?: string;
  newSessionId?: string;
  maxTurns?: number;
  timeoutMs?: number;
  logPath?: string;
  images?: string[];
  env?: Record<string, string>;
  signal?: AbortSignal;
  runner: TurnRunner;
}
