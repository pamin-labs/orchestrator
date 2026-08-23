import { expect, test } from "bun:test";
import { cardGoal } from "../../web/src/shared/prose.ts";

/**
 * The goal line of a plan card.
 *
 * Both readers matched it with `startsWith("目标")`, which a Markdown card never
 * satisfies — its first line is `## 目标`. Since ADR 016 made cards Markdown,
 * every card has read `Plan card not submitted` with the card right there.
 */
/**
 * It survived because all four web fixtures that push a `draftCard` still use
 * the pre-Markdown `目标: ship it` form, and none asserts the goal.
 */
test("a Markdown card yields its goal, which the old prefix match could not", () => {
  expect(cardGoal("## goal\nShip the login page\n\n## non-goals\nnothing else")).toBe("Ship the login page");
  // The heading an agent writes under `output.language` — the key is ASCII, the
  // content is not.
  expect(cardGoal("## goal\n让登录页支持记住我\n\n## risk\n无")).toBe("让登录页支持记住我");
});

/**
 * The two shapes this used to read, and the reason it stopped.
 *
 * A card in either form no longer validates — `validateDraftCard` refuses it by
 * name — so a panel that still drew a goal off one would be showing the boss a
 * card they cannot approve. The compatibility alias and this reader left together
 * (`docs/project/plan.md` puts aliases out of scope before the first release);
 * two readers agreeing is the property `no reader maps a Chinese heading to a
 * card section` keeps.
 */
test("the two retired shapes yield nothing", () => {
  expect(cardGoal("目标: ship it\n不做: nothing")).toBe("");
  expect(cardGoal("goal: ship it")).toBe("");
  expect(cardGoal("## 目标\n让登录页支持记住我")).toBe("");
});

test("a card with no goal section yields nothing rather than a wrong line", () => {
  expect(cardGoal("## risk\nnone")).toBe("");
  expect(cardGoal("")).toBe("");
});
