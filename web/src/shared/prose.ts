import { fieldOf } from "../../../src/contracts/card";

/**
 * Text an agent wrote, made readable where it is read.
 *
 * Both of these repair prose on the way to the screen rather than on the way into
 * storage: the writers are every path that records agent output, and the readers
 * are these two functions.
 */

/**
 * A newline an agent wrote as two characters.
 *
 * Models emit `\n` inside a string they think they are quoting, and the text
 * lands in the blackboard with the backslash intact. It reaches the boss as
 * `…通过。\n验收 2（被挡卡不可代批）…` in the middle of a sentence they have to
 * read to make a decision. Fixing it where it is written would mean fixing every
 * path that writes agent prose; fixing it where it is read is one function.
 * i18n-exempt: what an agent wrote, quoted.
 */
export const nl = (s: string) => s.replace(/\\n/g, "\n");

/**
 * The goal line of a plan card.
 *
 * The card is a document an agent wrote, not copy this panel owns: its section
 * keys are protocol and its content follows `output.language`. Which word names
 * which section is `fieldOf`'s answer, in `src/contracts/card.ts` — the same one
 * `validateDraftCard` gets, so the panel cannot come to accept a heading the
 * parser rejects. What is left here is the two *shapes* a heading can have.
 */
/**
 * Both readers used to do `startsWith("目标")`, which a Markdown card never
 * satisfies — its first line is `## 目标`. Every card in the queue read
 * `Plan card not submitted` with the card sitting right there. The fix left a
 * `(goal|目标)` regex here, which is the same defect one layer up: a second copy
 * of the vocabulary, on the far side of a boundary, and a `## Goal` the parser
 * folds and this did not.
 * i18n-exempt: the key this used to match, quoted.
 */
/** Shape only: a Markdown heading, at any level, with an optional trailing
 *  colon. NFKC before the lookup, so a fullwidth colon typed on a CJK keyboard
 *  folds without this file keeping a list of the characters it has met. The
 *  one-line `goal: …` form ADR 016 replaced was read here too; it left with the
 *  parser's own copy, since a card in that shape no longer validates at all.
 *  i18n-exempt: the fullwidth colon is the subject. */
const HEADING = /^\s*#{1,6}\s*(.+?)\s*[:：]?\s*$/;

/** The name this line puts in the heading slot, if it is that shape at all. */
const named = (line: string, shape: RegExp): RegExpExecArray | null => shape.exec(line.normalize("NFKC"));

const isGoal = (match: RegExpExecArray | null): boolean => match?.[1] !== undefined && fieldOf(match[1]) === "goal";

export function cardGoal(body: string): string {
  const lines = body.split("\n");
  const heading = lines.findIndex((line) => isGoal(named(line, HEADING)));
  if (heading < 0) return "";
  return (
    lines
      .slice(heading + 1)
      .find((line) => line.trim())
      ?.trim() ?? ""
  );
}
