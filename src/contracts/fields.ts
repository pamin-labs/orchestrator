import { z } from "zod";

/**
 * The field shapes more than one route needs.
 *
 * Hono's Zod middleware runs these at the request boundary; this file only owns
 * the shared vocabulary.
 */
/**
 * A group, by id or by name.
 *
 * Both, because agents reach for the name they can see — one was observed
 * running `orch draft greet -` — and refusing that teaches nothing.
 * `resolveGroup` is what turns either into an id.
 */
export const GroupRef = z.union([z.number().int().positive(), z.string().min(1)]);

/**
 * A row id, which arrives as a string whenever `orch` is the caller.
 *
 * Command-line flags are strings, so somebody had to convert. That somebody was
 * each call site in `orch/cli.ts`: `flags.slice ? Number(flags.slice) : undefined`
 * written out at `:248` and `:350`, and *not* written at `:237` — so
 * `orch mail x --in-reply-to 5` came back "in_reply_to: Invalid input: expected
 * number, received string" and no agent could tell what it was meant to send
 * instead. A rule that lives in every caller is a rule one caller will miss.
 *
 * Explicit union rather than `z.coerce.number()`, for the reason 硬约束 8 names:
 * coerce runs `Number()` on whatever it is handed, and a bare `--slice` parses
 * to `true`, which `Number()` turns into the perfectly plausible id 1.
 */
export const Id = z
  .union([z.number(), z.string().regex(/^\d+$/, "must be a whole number").transform(Number)])
  .pipe(z.number().int().positive());

/** One decimal row id from a dynamic route segment. */
export const IdParams = z.object({ id: Id });

/**
 * A file the boss attached, as the composer records it.
 *
 * `name` and `type` are required because `withAttachments` prints the first and
 * `imagePaths` reads the second to decide what has to leave as an `-i` flag —
 * an attachment missing either is one that renders as `undefined` in a prompt.
 */
export const Attachment = z.object({
  name: z.string().min(1).max(300),
  path: z.string().min(1).max(4000),
  type: z.string().max(120),
  /** 图1 / 附件2 — the marker the boss's own text refers to. */
  label: z.string().max(40).optional(),
});

/**
 * Prose an agent or the boss wrote.
 *
 * Capped, not because a longer one is wrong but because everything here ends up
 * in a transcript that gets re-read every turn of a session — an unbounded field
 * on this side is a bill on the other.
 */
export const Prose = (max = 8000) => z.string().min(1).max(max);
