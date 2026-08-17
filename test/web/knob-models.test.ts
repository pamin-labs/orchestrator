import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { cleanup, render, restoreFetch, stubFetch } from "../support/render.tsx";
import { Knobs } from "../../web/src/views/knobs";
import { allModels, cheapest, modelsByRuntime } from "../../web/src/lib/models";
import { COUNT_UNITS, countOf, splitCount } from "../../web/src/lib/units";
import { DEFAULTS_FOR_CHECK as DEFAULTS } from "../../src/platform/config/load.ts";
import { ConfigSchema } from "../../src/contracts/config.ts";

/**
 * The model pickers offer what this config already names.
 *
 * There is no endpoint that lists an account's models — neither CLI has a list
 * command and we hold their OAuth tokens rather than API keys — so a hardcoded
 * table would be a fourth place to go stale. It is derived, and this is the
 * derivation held to the shipped config: if `config/default.yaml` gains a
 * runtime or renames a model family, the picker has to follow without an edit.
 */
const src = {
  difficultyModel: DEFAULTS.difficultyModel,
  contextWindow: DEFAULTS.contextWindow,
  indexModel: DEFAULTS.indexModel,
};

/**
 * testing-library's own `afterEach(cleanup)` is registered when its module is
 * evaluated, and `bun test` scopes the lifecycle globals per file — so that hook
 * belongs to whichever file imported it first, and every later file kept the
 * previous one's nodes in `document.body`. Each file registers its own.
 */
afterEach(() => {
  cleanup();
  restoreFetch();
});

test("the knob editor has a renderable loading state", () => {
  // The read is left in flight, which is the state the editor comes up in.
  stubFetch();
  expect(render(createElement(Knobs, { section: "models" })).getByText(/读取中/)).toBeTruthy();
});

test("every runtime is offered its own models and nobody else's", () => {
  const by = modelsByRuntime(src);
  expect(Object.keys(by).sort()).toEqual(["claude", "codex"]);
  // `contextWindow` names more models than `difficultyModel` does; they are
  // attributed by the family prefix the difficulty table taught.
  expect(by.claude!.every((m) => m.startsWith("claude"))).toBe(true);
  expect(by.codex!.every((m) => m.startsWith("gpt"))).toBe(true);
  // Every model a difficulty tier names is offered for that runtime, or the
  // picker cannot show the value the row already holds.
  for (const [runtime, tiers] of Object.entries(DEFAULTS.difficultyModel)) {
    for (const model of Object.values(tiers)) expect(by[runtime]).toContain(model);
  }
  // `default` is the fallback window, not a model anyone can pick.
  expect(allModels(src)).not.toContain("default");
});

test("switching the index runtime lands on that runtime's cheapest model", () => {
  // Carrying the model across is a model the new runtime cannot run, on the most
  // frequent model call in the system. `trivial` is by definition the tier not
  // worth a large model, so the config already holds this answer.
  for (const runtime of ["claude", "codex"]) {
    const cheap = cheapest(src, runtime);
    expect(cheap).toBe(DEFAULTS.difficultyModel[runtime]!.trivial);
    expect(modelsByRuntime(src)[runtime]).toContain(cheap);
  }
  expect(cheapest(src, "nosuch")).toBeUndefined();
});

test("a count splits into an integer and a unit, and multiplies back exactly", () => {
  // The number box only accepts integers, so the split has to produce one for
  // every value the config can hold — `fmtCount` would print 8500000 as 8.5M,
  // which is neither steppable nor typeable in an integer field.
  const values = [
    ...Object.values(DEFAULTS.sliceBudgetTokens),
    ...Object.values(DEFAULTS.contextWindow),
    DEFAULTS.ctxBudgetChars,
    0,
    1,
    45,
    999,
    1000,
    8_500_000,
    1_000_001,
  ];
  for (const v of values) {
    const { n, unit } = splitCount(Number(v));
    expect(Number.isInteger(n)).toBe(true);
    expect(COUNT_UNITS).toContain(unit);
    expect(countOf(n, unit)).toBe(Number(v));
  }
  expect(splitCount(8_500_000)).toEqual({ n: 8500, unit: "k" });
  expect(splitCount(272_000)).toEqual({ n: 272, unit: "k" });
  expect(splitCount(45)).toEqual({ n: 45, unit: "" });
});

test("a row the panel creates is a row the server accepts", () => {
  // The add box wrote the new entry with value 0, and every map knob on this page
  // is `z.number().int().positive()`. So naming a model produced
  // "contextWindow: Too small: expected number to be >0" and no row: there is
  // nowhere to type a value before the row exists, so the row could never be
  // created at all. A born value has to be one the schema takes.
  const CFG = ConfigSchema.shape;
  for (const [path, born] of [
    ["contextWindow", 200_000],
    ["leaseSlots", 1],
    ["sliceBudgetTokens", 1],
  ] as const) {
    const schema = CFG[path as keyof typeof CFG];
    expect(schema.safeParse({ "new-thing": born }).success).toBe(true);
    // And the value that used to be written is exactly what the server refuses.
    expect(schema.safeParse({ "new-thing": 0 }).success).toBe(false);
  }
});
