import { firstSentence } from "../../../src/contracts/sentence.ts";

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
 * One line of what a long agent message is about.
 *
 * The server asks for `--brief` and derives one when it is missing, but every
 * question filed before that column existed has none — and those are exactly the
 * ones sitting in the queue today. The rule is the same on both sides, so it is
 * one function in `contracts` and not two: this copy still cut on every full
 * stop after the server's stopped.
 */
export const brief = (s: string, max = 44): string => firstSentence(s, max);

/**
 * The goal line of a plan card.
 *
 * The card is a document an agent wrote, not copy this panel owns: its section
 * keys are protocol and its content follows `output.language`. So this matches
 * the key, in every grammar a stored card can have — `## goal` since the keys
 * became ASCII, `## 目标` before that, and the pre-Markdown `目标: …` inline form
 * that ADR 016 replaced.
 * i18n-exempt: the card's own section keys, in every grammar one can have.
 */
/**
 * Both readers used to do `startsWith("目标")`, which a Markdown card never
 * satisfies — its first line is `## 目标`. Every card in the queue read
 * `Plan card not submitted` with the card sitting right there.
 * i18n-exempt: the key this used to match, quoted.
 */
// i18n-exempt: protocol, not copy — the same two spellings `ALIAS` in
// `src/mech/util/validate.ts` accepts, for the same stored cards, and they retire
// together with it in 0.2.0. Invisible to this guard until it learned to read
// regexes.
const GOAL_KEY = /^\s*(?:#{1,6}\s*)?(goal|目标)\s*[:：]?\s*$/i;
// i18n-exempt: the same key, in the pre-Markdown inline form ADR 016 replaced.
const GOAL_INLINE = /^\s*(goal|目标)\s*[:：]\s*/i;

export function cardGoal(body: string): string {
  const lines = body.split("\n");
  const heading = lines.findIndex((line) => GOAL_KEY.test(line));
  if (heading >= 0)
    return (
      lines
        .slice(heading + 1)
        .find((line) => line.trim())
        ?.trim() ?? ""
    );
  const inline = lines.find((line) => GOAL_INLINE.test(line));
  return inline?.replace(GOAL_INLINE, "").trim() ?? "";
}
