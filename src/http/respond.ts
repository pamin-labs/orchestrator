/**
 * How this API answers. Plain text, mostly.
 *
 * Half the callers are agents reading the body of a failure to work out what to
 * write next, so a refusal is a sentence rather than a JSON envelope with a code
 * in it. The panel shows the same string in a toast. One shape for both.
 */

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export const text = (s: string, status = 200) =>
  new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/** Understood, and refused — with the reason, which is the whole point. */
export const bad = (msg: string) => text(msg, 422);
