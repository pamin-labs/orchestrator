import { z } from "zod";

/**
 * A sentence the server names but does not write.
 *
 * ADR 041: text a person reads on the panel should not be rendered on the
 * server. Rendering it early pins it to whatever language the server chose —
 * which was `output.language` for some strings, English for others and Chinese
 * for the rest, so one settings pane showed all three at once.
 */
/**
 * Lingui's own vocabulary, not ours: `id` is the explicit id of a
 * `msg({ id, message })` declaration in `web/src/shared/messages.ts`, and
 * `values` is what `i18n._(id, values)` takes. There is no rendering here,
 * because Lingui renders — a hand-written interpolator beside it would be a
 * second ICU implementation, and the one place it would first go wrong is a
 * Russian plural.
 */
export const SaidSchema = z.object({
  id: z.string().min(1),
  /**
   * Values, never text. A parameter carrying an already-translated fragment is a
   * sentence assembled in two languages, which is the defect this replaces:
   * `dropped by the boss：ran out of budget`, with a full-width colon glued on
   * at the call site.
   */
  values: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});

export type Said = z.infer<typeof SaidSchema>;
