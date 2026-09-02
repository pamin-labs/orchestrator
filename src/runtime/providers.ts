import { DEFAULT_PROVIDER, type Effort } from "../platform/config/load.ts";
import type { TurnHandlers, TurnResult, TurnSpec } from "./claude.ts";
import type { AskResult, AskSpec } from "./providers/contract.ts";
import { runClaudeAsk as askClaude, runClaudeTurn as runClaude } from "./claude.ts";
import { runCodexAsk as askCodex, runCodexTurn as runCodex } from "./codex.ts";

/**
 * The registry of agent CLIs.
 *
 * A role picks its provider by name, and everything downstream — the model table,
 * the effort word, the executor — reads this map rather than testing for a
 * particular CLI. Adding a third is a file next to `claude.ts` and one line here.
 *
 * A provider owns what differs between CLIs: how to run a turn, how to ask one
 * question, and how hard its models can be asked to think.
 */
/**
 * `ask` is here because it was not. The index navigator built its own argv with a
 * `runtime === "codex"` ternary, its own command string and its own output
 * parser, three modules away from the two files that own exactly those things —
 * and that third implementation is where a `; exit $rc` met a shared bash session
 * and every call came back empty. A third CLI is still a file next to
 * `claude.ts` and one line here.
 */
/**
 * It is also where a shared session would land. If agents in a group come to
 * share one prefix to raise the cache hit rate, `run` and `ask` are the two calls
 * that would learn about it — and the index would inherit that rather than being
 * the one caller nobody remembered, which is exactly how it got here.
 */
export interface Provider {
  name: string;
  run: (spec: TurnSpec, handlers?: TurnHandlers) => Promise<TurnResult>;
  /** One prompt, one answer: no session, no tools, no cached prefix. */
  ask: (spec: AskSpec) => Promise<AskResult>;
  /**
   * Effort words this provider accepts, weakest first. Measured, not assumed:
   * `claude --help` lists low…max, and codex's models_cache.json lists the same
   * five plus `ultra` on gpt-5.6-sol.
   */
  efforts: Effort[];
}

/** Weakest to strongest. The clamp below is an index comparison on this. */
const EFFORT_LADDER: Effort[] = ["low", "medium", "high", "xhigh", "max", "ultra"];

const CLAUDE_EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

const PROVIDERS: Record<string, Provider> = {
  claude: { name: "claude", run: runClaude, ask: askClaude, efforts: CLAUDE_EFFORTS },
  codex: { name: "codex", run: runCodex, ask: askCodex, efforts: EFFORT_LADDER },
};

export function providerFor(name?: string | null): Provider {
  return PROVIDERS[name ?? DEFAULT_PROVIDER] ?? PROVIDERS[DEFAULT_PROVIDER]!;
}

/**
 * The strongest effort this provider actually accepts, at or below what was asked.
 *
 * Clamped here rather than in an adapter because effort is part of the cached
 * prefix hash: the session has to rotate on what is really sent, not on what the
 * yaml wished for. A role asking for `ultra` on claude gets `max` and keeps a
 * stable hash, instead of the CLI rejecting the flag every turn.
 */
export function clampEffort(runtime?: string | null, effort?: Effort): Effort | undefined {
  if (!effort) return undefined;
  const allowed = providerFor(runtime).efforts;
  if (allowed.includes(effort)) return effort;
  const wanted = EFFORT_LADDER.indexOf(effort);
  const under = allowed.filter((e) => EFFORT_LADDER.indexOf(e) <= wanted);
  return under.at(-1) ?? allowed[0];
}
