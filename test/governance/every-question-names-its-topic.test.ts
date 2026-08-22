import { expect, test } from "bun:test";
import { traverse } from "@babel/core";
import { parse, scan } from "../support/ast.ts";

/**
 * Every question this server files says what it is about.
 *
 * ADR 045 made `--kind` required on `ask-boss`, so an agent cannot file without
 * one — and left `raise()`, which is how the orchestrator files its own, taking
 * `kind?: string | null`. Four of its eight callers passed nothing: a PR closed
 * without merging, a PR that will not open, an approval that did not take, and a
 * group out of budget.
 */
/**
 * All four are the boss's own queue, and all four drew no topic chip — riding
 * the null branch `select.ts` keeps for rows filed before the vocabulary
 * existed. A compatibility fallback that live code writes into stops being one.
 */
/**
 * Three of the four had the answer one line above them, in the `hold()` they sit
 * beside: `reason: "merge"`, `reason: "budget"`. The word was already written
 * down and the question next to it did not carry it.
 */
/**
 * The type is `AskKind | null` now, so a *wrong* word is a compile error. What a
 * type cannot say is that the property must be there at all: `kind` stays
 * optional because `EscalationRequest` is also built in `api/orch/escalation.ts`
 * from a body the CLI has already refused a missing one on. So this reads the
 * call sites instead.
 */
const offenders = (file: string, source: string): string[] => {
  const ast = parse(file, source);
  if (!ast) return [];
  const found: string[] = [];
  traverse(ast, {
    CallExpression(p) {
      const { callee, arguments: args } = p.node;
      if (callee.type !== "Identifier" || callee.name !== "raise") return;
      const ask = args[1];
      // Only an object literal written at the call site can be read here. A
      // `raise(db, built)` would pass this and is not a shape anything uses;
      // `escalation.ts` builds its object inline like the rest.
      if (ask?.type !== "ObjectExpression") return;
      const names = ask.properties.some(
        (prop) => prop.type === "ObjectProperty" && prop.key.type === "Identifier" && prop.key.name === "kind",
      );
      if (!names) found.push(`${file}:${p.node.loc?.start.line ?? 0} files a question with no kind`);
    },
  });
  return found;
};

const calls = (file: string, source: string): string[] => {
  const ast = parse(file, source);
  if (!ast) return [];
  const found: string[] = [];
  traverse(ast, {
    CallExpression(p) {
      if (p.node.callee.type === "Identifier" && p.node.callee.name === "raise") found.push(file);
    },
  });
  return found;
};

test("no escalation is filed without saying what it is about", () => {
  expect(scan("src/**/*.ts", offenders)).toEqual([]);
  // Silence reads exactly like success, so the scanner has to be shown reaching
  // the call sites: eight file one today, plus `raise`'s own definition.
  expect(scan("src/**/*.ts", calls).length).toBeGreaterThanOrEqual(8);
});
