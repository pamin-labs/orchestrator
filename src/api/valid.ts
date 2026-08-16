import { z } from "zod";
import { sValidator } from "@hono/standard-validator";
import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Request validation, at the route rather than inside the handler.
 *
 * Every handler used to open with `await body<T>(req)`, which parsed the JSON
 * and swallowed a failure into `{}` — so a malformed body arrived as an object
 * whose every field was `undefined`, and each handler then re-derived what it
 * needed with its own `?? ""` and `String(...)` and `=== "blocker" ? …`. Two
 * problems in one shape: the checks were written sixty times, and the request
 * that could not be parsed at all was indistinguishable from one that simply
 * left everything out.
 *
 * `sValidator` runs the schema before the handler exists. What it hands over is
 * already the right shape, so the handler is about what it does rather than
 * about what it was given.
 *
 * The message matters more here than in most APIs: half of these callers are
 * agents, and the reply is the only thing they get to correct themselves from.
 * So the hook replaces the library's JSON envelope with the plain text the rest
 * of this API answers in — `orch` prints anything past 400 straight at the
 * agent, and the panel's `post()` toasts it.
 */
export const check = <T extends StandardSchemaV1>(target: "json" | "param" | "query", schema: T) =>
  sValidator(target, schema, (result, c) => {
    if (result.success) return;
    const issues = (result as { error: readonly StandardSchemaV1.Issue[] }).error;
    const lines = issues.map((i) => {
      const path = (i.path ?? [])
        .map((p) => (typeof p === "object" && p !== null && "key" in p ? String(p.key) : String(p)))
        .join(".");
      return path ? `${path}: ${i.message}` : i.message;
    });
    // 422 rather than the library's 400, because that is what the rest of this
    // API says for "understood, and refused" — and every existing caller, agent
    // or panel, already treats it as a message to show rather than a bug.
    return c.text(lines.join("\n") || "invalid request", 422);
  });

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
