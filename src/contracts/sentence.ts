/**
 * The first sentence of something a person or an agent wrote, cut to fit.
 *
 * Here rather than in either caller because both had it: the server derives a
 * queue brief when `--brief` is missing, and the panel derives one for every
 * escalation stored before that column existed — which is exactly the rows in
 * the queue today. Two copies, two lengths, one of them fixed.
 */
/**
 * ICU's sentence break, not a punctuation set of ours. The list it replaced was
 * ASCII and Chinese terminators, and it cut on every full stop — `playwright
 * 1.62.1 is missing` came back as `playwright 1` and `e.g. the gate…` as `e`, in
 * a row whose whole job is naming which question to open. Same ICU `terms()`
 * segments words with.
 */
/**
 * Pinned to `en`: sentence break is locale-independent across the ten languages
 * this ships in, and the exception — Greek's `;` for a question mark — is not
 * one of them. A locale would have to be threaded from `output.language` to buy
 * a language with no catalogue.
 */
const SENTENCES = new Intl.Segmenter("en", { granularity: "sentence" });

/** Unicode's own property, so the phrase does not end in the stop it was cut at. */
const ENDING = /[\p{Terminal_Punctuation}\s]+$/u;

/**
 * `Intl.Segmenter` again for the truncation, because `slice` counts UTF-16 code
 * units: cutting mid-emoji leaves a lone surrogate, which renders as a
 * replacement character in the one row a reader is scanning.
 */
const GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });

/**
 * Exported because `escalation.ts` had written its own — `s.slice(0, 39)`, which
 * is the UTF-16 cut this exists to avoid — for the half of `brief()` that trims
 * what an agent wrote, while the derived half went through here. Two widths on
 * one queue column, one of them able to leave a lone surrogate.
 */
export const cut = (s: string, max: number): string => {
  const parts = [...GRAPHEMES.segment(s)];
  return parts.length > max
    ? `${parts
        .slice(0, max - 1)
        .map((g) => g.segment)
        .join("")}…`
    : s;
};

/** The first sentence of `text`, trimmed of its terminator and cut to `max`. */
export const firstSentence = (text: string, max: number): string =>
  cut(([...SENTENCES.segment(text)][0]?.segment ?? "").replace(ENDING, "").trim(), max);
