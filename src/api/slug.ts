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

const STOP = new Set(["the", "a", "an", "and", "for", "with", "add", "to", "of", "in", "on"]);
