import { expect, test } from "bun:test";
import { cardGoal } from "../../web/src/shared/prose.ts";

/**
 * The goal line of a plan card, in either grammar the card has ever had.
 *
 * Both readers matched it with `startsWith("目标")`, which a Markdown card never
 * satisfies — its first line is `## 目标`. So since ADR 016 made cards Markdown,
 * every card in the queue has read `Plan card not submitted` and every progress
 * row `Plan card pending approval`, with the card sitting right there.
 *
 * It survived because all four web fixtures that push a `draftCard` still use the
 * pre-Markdown `目标: ship it` form, and not one of them asserts the goal.
 */
test("a Markdown card yields its goal, which the old prefix match could not", () => {
  expect(cardGoal("## goal\nShip the login page\n\n## non-goals\nnothing else")).toBe("Ship the login page");
  // The heading an agent writes under `output.language` — the key is ASCII, the
  // content is not.
  expect(cardGoal("## goal\n让登录页支持记住我\n\n## risk\n无")).toBe("让登录页支持记住我");
});

test("the pre-Markdown inline form still yields its goal", () => {
  expect(cardGoal("目标: ship it\n不做: nothing")).toBe("ship it");
  expect(cardGoal("goal: ship it")).toBe("ship it");
});

test("Chinese headings still parse, because stored cards have them", () => {
  expect(cardGoal("## 目标\n让登录页支持记住我")).toBe("让登录页支持记住我");
});

test("a card with no goal section yields nothing rather than a wrong line", () => {
  expect(cardGoal("## risk\nnone")).toBe("");
  expect(cardGoal("")).toBe("");
});
