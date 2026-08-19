import { expect, test } from "bun:test";
import { Glob } from "bun";

/**
 * A refinement declares its message as `error`, which is what zod v4 reads.
 *
 * `message` is the v3 spelling. zod v4 still accepts it, so the one place that had it
 * kept working and kept looking correct — and the day it stops being accepted, the
 * refusal a caller sees becomes zod's own "Invalid input" instead of the sentence
 * somebody wrote to explain what the caller got wrong.
 */
/**
 * Read off the source rather than off a type, because the type is what let this
 * through: both keys are assignable, so neither the compiler nor oxlint has anything
 * to say. The check is the shape — `message:` in the options object of a `refine` or
 * `superRefine` — and nothing else in these files spells a key that way.
 */
const REFINE = /\.(?:super)?[Rr]efine\([\s\S]{0,400}?\bmessage:/g;

test("no refinement uses zod v3's message key", async () => {
  const offenders: string[] = [];
  for (const dir of ["src", "web/src", "test"]) {
    for await (const rel of new Glob("**/*.{ts,tsx}").scan(dir)) {
      const path = `${dir}/${rel}`;
      const text = await Bun.file(path).text();
      for (const match of text.matchAll(REFINE)) {
        const line = text.slice(0, match.index).split("\n").length;
        offenders.push(`${path}:${line}`);
      }
    }
  }
  // The paths, not a count: the fix is `message:` → `error:` at exactly these.
  expect(offenders).toEqual([]);
});
