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
 */
export const nl = (s: string) => s.replace(/\\n/g, "\n");

/**
 * One line of what a long agent message is about.
 *
 * The server asks for `--brief` and derives one when it is missing, but every
 * question filed before that column existed has none — and those are exactly the
 * ones sitting in the queue today. Same rule on this side: the first sentence
 * usually names the problem.
 */
export const brief = (s: string, max = 44): string => {
  // i18n-exempt: sentence terminators, Chinese and English, not copy.
  const first = (s.split(/[\n。.!?！？]/)[0] ?? s).trim() || s.trim();
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
};
