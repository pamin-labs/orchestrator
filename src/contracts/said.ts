import { z } from "zod";

/**
 * A sentence the server names but does not write.
 *
 * ADR 041: rendering panel text on the server pins it to whatever language the
 * server chose — which was `output.language` for some strings, English for
 * others and Chinese for the rest, so one settings pane showed all three.
 */
/** Lingui's `MessageDescriptor` field for field, because that is what an emitter
 *  writes: `say: msg\`merged into main\`` expands at build time into
 *  `{ id, message }`, and this is that object on the wire. */
export const SaidSchema = z.object({
  /** The macro's hash of the English. Nobody writes one by hand. */
  id: z.string().min(1),
  /**
   * The English the id was hashed from. Optional only because that is how Lingui
   * types `MessageDescriptor` — every producer here is a `msg` template and
   * `lingui-macros.ts` pins `descriptorFields: "message"`, so one without it is
   * malformed rather than old. Requiring it would refuse `msg` at all 35 emit
   * sites; the renderer treats the absence as unreachable instead.
   */
  message: z.string().optional(),
  /**
   * Values, never text. A parameter carrying an already-translated fragment is a
   * sentence assembled in two languages: `dropped by the boss：ran out of
   * budget`, with a full-width colon glued on at the call site. Not theoretical
   * — the change that wrote this rule broke it five times.
   */
  // oxlint-disable-next-line eslint/no-restricted-properties -- `Record<string, unknown>` is Lingui's own type for a descriptor's values, and this schema has to accept the object its macro produced; narrowing it here would refuse `msg` at every emit site. Nothing reads a value: they are handed to ICU formatting, which renders whatever it gets, and React escapes the result.
  values: z.record(z.string(), z.unknown()).optional(),
});

export type Said = z.infer<typeof SaidSchema>;

/**
 * `message` required here and only here. This is the one input that is untrusted
 * JSON — a row read back out of `event.meta_json` — so a descriptor stored
 * before the macro named these is refused at the parse rather than checked for
 * later: `sayIn` returns null and the body stored beside it is drawn.
 */
const MetaSchema = z.object({ say: SaidSchema.extend({ message: z.string() }).optional() });

/**
 * The sentence an event's `meta` names, if it names one. In the contract
 * because both sides read that column — the panel to draw the row, the server's
 * tests to assert which sentence was chosen rather than what language it came
 * out in.
 */
export const sayIn = (meta: unknown): Said | null => MetaSchema.safeParse(meta).data?.say ?? null;
