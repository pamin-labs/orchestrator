import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (...v: ClassValue[]) => twMerge(clsx(v));

/**
 * Token counts, in the unit that fits.
 *
 * Stopped at k, so a real project's total printed as "1834k" — which is both wrong
 * as a unit and unreadable as a number. A long-running project passes a billion
 * cached tokens, so B is not hypothetical.
 */
export const K = (v?: number | null) => {
  const n = v ?? 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
};
export const clock = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
export const waited = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? "刚刚" : m < 60 ? `等待 ${m}m` : `等待 ${Math.round(m / 60)}h`;
};

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
  const first = (s.split(/[\n。.!?！？]/)[0] ?? s).trim() || s.trim();
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
};

/**
 * A project's repository, as a link.
 *
 * `repo_path` is `owner/name` for every project — migration 037 converted the
 * absolute host paths that used to live there. The shape is still checked
 * rather than assumed, because that migration deliberately leaves a row it
 * cannot convert holding its old path (a project whose remote was missing or
 * was not GitHub), and `https://github.com//Users/…` is worse than plain text.
 */
export const repoHref = (repoPath?: string | null): string | null =>
  repoPath && /^[\w.-]+\/[\w.-]+$/.test(repoPath) ? `https://github.com/${repoPath}` : null;
