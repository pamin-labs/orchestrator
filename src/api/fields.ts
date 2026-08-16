import { z } from "zod";

/**
 * The field shapes more than one route needs.
 *
 * Running the schema is `src/http/route.ts`'s job — this file is only the
 * vocabulary. It used to hold a `check()` wrapper around
 * `@hono/standard-validator` too; that went when `route()` started calling
 * Standard Schema itself.
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
