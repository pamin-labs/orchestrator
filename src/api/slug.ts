/**
 * A short, branch-shaped name from a sentence of prose.
 *
 * Its own file because four route modules need it and none of them owns it.
 */

/**
 * A short, branch-shaped name.
 *
 * This ends up in `orch/<name>`, a worktree path and every log line, so a
 * slugified 40-character sentence is a nuisance forever. Prefer the ASCII words
 * (usually the identifiers the idea is about) and fall back to a trimmed slug.
 */
export function slug(text: string): string {
  const ascii = (text.toLowerCase().match(/[a-z][a-z0-9._-]{1,}/g) ?? [])
    .filter((w) => !STOP.has(w))
    .slice(0, 3)
    .join("-")
    .replace(/[._]+/g, "-");
  if (ascii.length >= 3) return ascii.slice(0, 28);
  return (
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 24) || "idea"
  );
}

/**
 * Eleven words, English, and measured against the alternative rather than left
 * as an oversight.
 *
 * `terms()` is this project's one tokeniser and rents `stopword`'s 621-entry
 * English list, so pointing this at it looked like deleting the last
 * hand-written word list in `src/`. It is the wrong list for this job.
 */
/**
 * Retrieval drops words carrying no *search* signal; a branch name wants the
 * opposite. Measured: `slug("remember-me")`, a name the caller chose, came back
 * `remember`. Only the ASCII branch reads this, so the eleven gate nobody.
 */
const STOP = new Set(["the", "a", "an", "and", "for", "with", "add", "to", "of", "in", "on"]);
