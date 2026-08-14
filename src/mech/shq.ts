/**
 * Single-quote one argument for `sh -c`.
 *
 * Everything that runs in a sandbox arrives as a command string — the exec API
 * takes no argv — so the argv/shell boundary that `Bun.spawn` used to enforce
 * has to be enforced here instead. The only character that can escape single
 * quotes is the single quote.
 */
export function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
