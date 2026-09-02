import { expect, test } from "bun:test";
import { clampEffort, providerFor } from "../../src/runtime/providers.ts";
import { runClaudeAsk, runClaudeTurn } from "../../src/runtime/claude.ts";
import { runCodexAsk, runCodexTurn } from "../../src/runtime/codex.ts";

/**
 * Every CLI difference lives behind this map, and `ask` was the one that did not.
 *
 * The index navigator built its own argv with a `runtime === "codex"` ternary,
 * its own command string and its own output parser, three modules away from the
 * two files that own exactly those things for a turn. That third implementation
 * is where `; exit $rc` met a shared bash session and every index call came back
 * empty — a defect the turn path could not have, because it was written once.
 */
/**
 * Asserted as identity rather than by calling them: what matters is that the
 * registry hands out each provider's own pair, so a third CLI is a file next to
 * `claude.ts` and one line here rather than a second branch somewhere else. What
 * the two actually send is pinned end to end in `index-model-call.test.ts`.
 */
test("a provider owns both ways of reaching its CLI, and the registry hands out its own", () => {
  expect(providerFor("claude")).toMatchObject({ name: "claude", run: runClaudeTurn, ask: runClaudeAsk });
  expect(providerFor("codex")).toMatchObject({ name: "codex", run: runCodexTurn, ask: runCodexAsk });
  // Not the same function under two names, which a copy-paste registration is.
  expect(providerFor("claude").ask).not.toBe(providerFor("codex").ask);
});

test("an unknown runtime falls back rather than throwing, and keeps its effort clamped", () => {
  // A role naming a CLI that is not installed is a configuration mistake, and the
  // fallback is what keeps it from being an unhandled rejection mid-turn.
  expect(providerFor("nope").name).toBe(providerFor(null).name);
  expect(providerFor(undefined).ask).toBe(providerFor(null).ask);
  // `ultra` is codex's and not claude's, so the clamp is what stops a role's yaml
  // rejecting every turn on a flag the CLI does not take.
  expect(clampEffort("claude", "ultra")).toBe("max");
  expect(clampEffort("codex", "ultra")).toBe("ultra");
  expect(clampEffort("claude", undefined)).toBeUndefined();
});
