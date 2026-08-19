import { expect, test } from "bun:test";
import { errText } from "../../src/platform/process/text.ts";

test("a caught value that is not an Error still comes back as a string, and bounded", () => {
  // What ten `catch (e: any)` sites wrote by hand instead: `e?.message ?? e`.
  // With `e` typed `any` that expression is not a string, and two of those sites
  // fed it to something that declared one — `bad(msg: string)` answered 422 with
  // a body of "[object Object]", and the GitHub login stored the object as its
  // error banner. `??` also only falls back on null/undefined, so a thrown
  // object with no `message` reached the caller intact.
  expect(errText({ status: 500 })).toBe("[object Object]");
  expect(errText("plain string throw")).toBe("plain string throw");
  expect(errText(new Error("boom"))).toBe("boom");
  expect(errText(null)).toBe("null");

  // And the half none of them had: these strings go into feed lines and PR
  // bodies, so a git error carrying 40KB of stderr is not a blocker card.
  const long = errText(new Error("x".repeat(5000)));
  expect(long.length).toBe(300);
  expect(long).toEndWith("…");
});

/**
 * The reason, not only the operation that hit it.
 *
 * A library wrapper's own message is often the boilerplate half:
 * `DrizzleQueryError` says "Failed query: update …" and hangs the constraint
 * violation off `cause`. Reading `.message` alone showed the boss which
 * statement failed and never why, which is the half that is actionable.
 */
test("a wrapped error still says what actually went wrong", () => {
  const wrapped = new Error("Failed query: update", { cause: new Error("channel failure") });
  expect(errText(wrapped)).toBe("Failed query: update: channel failure");
  // Bounded: a cause chain is a linked list the library controls, and one that
  // loops would otherwise hang here rather than in the library.
  const loop = new Error("a");
  loop.cause = loop;
  expect(errText(loop)).toBe("a: a: a: a");
  // A cause that is not an Error is not a message; it is skipped, not stringified.
  expect(errText(new Error("plain", { cause: "context" }))).toBe("plain");
});
