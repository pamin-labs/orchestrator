/**
 * A name for git and a title for the boss, from the same prose, in one ask.
 *
 * `slug()` picks the first three non-stopword ASCII words, which is a fine branch
 * name and a poor heading — the boss files a paragraph and the requirement page
 * calls it `remember-me-checkbox`. A model reads the paragraph once, cheapest
 * tier, and answers both.
 */

import { outputLanguage } from "../../contracts/config.ts";
import type { Ctx } from "../../mech/ctx.ts";
import { slug } from "../slug.ts";

/** What the boss reads. Long enough for a sentence, short enough for a heading. */
const TITLE_CHARS = 120;

/**
 * How long the submit dialog is allowed to wait on the model.
 *
 * `modelAsk`'s own timeout is 60s, which is right for a background index rebuild
 * and wrong for a button the boss just pressed. Nothing is lost when it fires:
 * the ticket is created either way, with the slug it would have had before.
 */
const ASK_MS = 8_000;

/** What is safe to put in `orch/<name>`, a worktree path and a `docs/journal` path. */
const ASCII_NAME = /^[a-z0-9][a-z0-9-]{2,}$/;

/** Named so the test asserts the instruction rather than a substring of prose. */
export function titlePrompt(text: string, language: string): string {
  return [
    "You name a work ticket somebody just filed. Answer with exactly two lines and nothing else.",
    "Line 1: a git branch name for it — English, lowercase, 2-4 words joined by hyphens, ascii only, no slashes.",
    `Line 2: its title, in ${language}, one line, at most 12 words, no trailing punctuation and no quotes.`,
    "Name what the ticket is about. Do not restate these rules, and do not add a preamble.",
    "",
    `ticket: ${text.slice(0, 4_000)}`,
  ].join("\n");
}

/**
 * The two lines, or exactly what this route did before there was a model.
 *
 * Every failure lands on the same fallback: no navigator configured, a tripped
 * breaker (`""`), a throw, a slow answer, or a reply that is not two usable
 * lines. A title is not worth failing a submission over.
 */
export async function titleFor(
  ctx: Ctx,
  projectId: number,
  text: string,
): Promise<{ name: string; title: string | null }> {
  const fallback = { name: slug(text).slice(0, 40), title: null };
  const askIn = ctx.askIn;
  if (!askIn) return fallback;
  try {
    const answer = await Promise.race([
      askIn({ project: projectId })(titlePrompt(text, outputLanguage(ctx.config))),
      Bun.sleep(ASK_MS).then(() => ""),
    ]);
    const [first = "", second = ""] = answer
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    // `slug` on the model's line and an ascii check on top of it. This becomes a
    // branch, a worktree path and a journal path, and `slug` alone does not make
    // it safe: its fallback keeps `\p{L}`, so a model that answered its title on
    // line one would have named a branch in Chinese — and `slug("")` is the
    // literal "idea", which would pass the check. Asked for ascii is not made
    // to produce it.
    const named = first ? slug(first).slice(0, 40) : "";
    return {
      name: ASCII_NAME.test(named) ? named : fallback.name,
      title: second.slice(0, TITLE_CHARS) || null,
    };
  } catch {
    return fallback;
  }
}
