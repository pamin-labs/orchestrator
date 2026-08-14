import { DEFAULT_PROVIDER, type Effort } from "../config.ts";
import type { TurnHandlers, TurnResult, TurnSpec } from "./claude.ts";
import { runTurn as runClaude } from "./claude.ts";
import { runTurn as runCodex } from "./codex.ts";

/**
 * The registry of agent CLIs.
 *
 * A role picks its provider by name (`runtime:` in roles/*.yaml), and everything
 * downstream — the model table in config, the effort word, the executor — reads
 * this map rather than testing for a particular CLI. Adding a third is a file
 * next to claude.ts and one line here; no union type to widen, no `if` to find.
 *
 * A provider owns exactly two things that differ between CLIs: how to run a turn,
 * and how hard its models can be asked to think. Everything else about a role
 * (prompt, tools, model id, budget) is already configuration.
 */
export interface Provider {
  name: string;
  run: (spec: TurnSpec, handlers?: TurnHandlers) => Promise<TurnResult>;
  /**
   * Effort words this provider accepts, weakest first. Measured, not assumed:
   * `claude --help` lists low…max, and codex's models_cache.json lists the same
   * five plus `ultra` on gpt-5.6-sol.
   */
  efforts: Effort[];
}

/** Weakest to strongest. The clamp below is an index comparison on this. */
export const EFFORT_LADDER: Effort[] = ["low", "medium", "high", "xhigh", "max", "ultra"];

const CLAUDE_EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export const PROVIDERS: Record<string, Provider> = {
  claude: { name: "claude", run: runClaude, efforts: CLAUDE_EFFORTS },
  codex: { name: "codex", run: runCodex, efforts: EFFORT_LADDER },
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
