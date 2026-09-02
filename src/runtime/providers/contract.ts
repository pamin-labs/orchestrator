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

/**
 * What the turn's own stream weighed, in bytes of raw provider output.
 *
 * `load.ts` records that tool results are 90% of a transcript and that every
 * round re-reads all of them, which is the largest single claim about what a turn
 * costs — and it was measured once, by hand, and never again. Nothing in the cost
 * report could confirm or contradict it, so the lever it points at ("make tool
 * output smaller at the source") had no before and no after.
 */
export interface Transcript {
  /** Every line the provider emitted, as it arrived. */
  bytes: number;
  /** The part of it that is a tool's output coming back. */
  toolBytes: number;
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
  transcript?: Transcript;
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

/**
 * One prompt, one answer, from the same CLI a turn uses.
 *
 * The index navigator is not a turn — no session, no tools, no cached prefix —
 * but it is the same binary in the same container, and it had its own argv, its
 * own command string and its own output parser living three modules away. That
 * third implementation is where `exit $rc` met a shared bash session and every
 * call came back empty.
 */
/**
 * `runner` and not a `Ctx`: the provider modules know about CLIs, never about
 * containers. `code` and `err` come back so the caller can report the failure in
 * its own words — an empty `text` on exit 0 means something different to the
 * index than it would to a turn.
 */
export interface AskSpec {
  model: string;
  prompt: string;
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  runner: TurnRunner;
}

export interface AskResult {
  text: string;
  usage?: Usage;
  code: number;
  err: string;
}

/** A unique prompt file prevents concurrent turns in one sandbox from overwriting each other. */
export const promptPath = (): string => `/tmp/orch-prompt-${crypto.randomUUID()}.txt`;
