/**
 * Shorten for a human, keeping the front.
 *
 * `collapse` is the difference between the two versions this replaces: one
 * flattened whitespace first because it was clipping a tool's multi-line output
 * into a single status line, the other kept the shape because it was clipping
 * prose that is read as prose. Both are right; which one you want is not
 * something a shared default can guess.
 */
export function clip(s: string, n = 200, collapse = false): string {
  const t = collapse ? s.replace(/\s+/g, " ").trim() : s;
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * What went wrong, as a string, without the stack.
 *
 * Twenty sites wrote `String((e as Error)?.message ?? e).slice(0, N)` with N
 * ranging over 120, 160, 200, 300, 400 and 600 — six answers to a question
 * nobody was asking on purpose. A caught value is not always an `Error`, which
 * is why every one of them has that `?? e`.
 */
export function errText<T>(e: T, n = 300): string {
  return clip(e instanceof Error ? withCauses(e) : String(e), n);
}

/**
 * The message, then what caused it.
 *
 * A wrapper's own message is often the boilerplate half: `DrizzleQueryError`
 * says "Failed query: update …" and puts the constraint violation on `cause`, so
 * an error shown to the boss named the statement and never the reason. Joined
 * rather than replaced — the wrapper says which operation, the cause says what
 * happened. Bounded, because a cause chain is a linked list a library controls.
 */
function withCauses(e: Error): string {
  const chain = [e.message];
  for (let c = e.cause; c instanceof Error && chain.length < 4; c = c.cause) chain.push(c.message);
  return chain.join(": ");
}

/**
 * The tail of something long, for a log the boss might read.
 *
 * The other half of the `.slice(-N)` habit: an error at the end of a build log
 * is the part that says what failed, so this keeps the end where `clip` keeps
 * the beginning.
 */
export function tail(s: string, n = 300): string {
  return s.length > n ? `…${s.slice(-n)}` : s;
}

/**
 * Milliseconds as whole minutes or hours, for a sentence the boss reads.
 *
 * `Math.round(x / 60000)` appeared seven times in the watchdog alone, once as a
 * local `hours` helper and six times inline — and every one of them is feeding a
 * `say()` argument, so the unit is part of the message rather than a detail of
 * the arithmetic.
 */
export const minutes = (ms: number): number => Math.round(ms / 60_000);
export const hours = (ms: number): number => Math.round(ms / 3_600_000);
