import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (...v: ClassValue[]) => twMerge(clsx(v));

export const money = (n?: number | null) => `$${(n ?? 0).toFixed(2)}`;
/**
 * The same, but blank at zero.
 *
 * Dollars are notional here: claude's CLI reports what a turn would have cost at
 * API rates, codex reports nothing, and the boss pays neither — two subscriptions.
 * So a codex row printing "$0.00" claims the work was free, which is worse than
 * saying nothing. Tokens are the number that means something; this is the aside.
 */
export const moneyOrBlank = (n?: number | null) => (n ? money(n) : "");
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
