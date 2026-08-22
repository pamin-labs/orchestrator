import type { I18n, MessageDescriptor } from "@lingui/core";
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
 * A `MessageDescriptor` that has an id *is* a `Said`, and the compiler is what
 * says so — a Lingui release that moves the shape fails here rather than at a
 * render three layers away.
 */
/**
 * Not the other direction, and that asymmetry is why this type exists rather
 * than `src` and the panel both using `MessageDescriptor`:
 * `exactOptionalPropertyTypes` makes Zod's `.optional()` `string | undefined`
 * where Lingui's is `string`.
 */
/**
 * Tried, and it does not converge: hono infers a response type from what the
 * handler returns, so the type at a wire boundary is whichever one the process
 * uses, and the panel declares its schema as `z.ZodType<InferResponseType<…>>`,
 * which demands the two be *equal*. One type through `src` and a two-line
 * `renderWith` paying the difference is the shorter of the two roads.
 */
/** Type-only, so the claim costs no bytes in the bundle: it was a function and a
 *  `void` of it, which is a runtime expression to say a compile-time thing. */
type Holds<T extends true> = T;
type _FromMacro = Holds<MessageDescriptor & { id: string } extends Said ? true : false>;

/**
 * `message` required for anything read back out of the database, and only there.
 * A stored descriptor is untrusted JSON — `event.meta_json`, `question_said` —
 * so one written before the macro named these is refused at the parse rather
 * than checked for later: the reader returns null and the prose column stored
 * beside it is drawn.
 */
const StoredSchema = SaidSchema.extend({ message: z.string() });

const MetaSchema = z.object({ say: StoredSchema.optional() });

/**
 * One `Said`, through one `i18n`. The server hands its per-locale instance and
 * the panel hands the browser's — the call is the same three arguments either
 * way, and it was written out in both places, including the reason for the
 * third one.
 *
 * `message` spelled in only when there is one: `exactOptionalPropertyTypes`
 * refuses an explicit `undefined` on Lingui's optional field.
 */
export const renderWith = (i18n: Pick<I18n, "_">, said: Said): string =>
  i18n._(said.id, said.values, said.message === undefined ? undefined : { message: said.message });

/**
 * The sentence an event's `meta` names, if it names one. In the contract
 * because both sides read that column — the panel to draw the row, the server's
 * tests to assert which sentence was chosen rather than what language it came
 * out in.
 */
export const sayIn = (meta: unknown): Said | null => MetaSchema.safeParse(meta).data?.say ?? null;

/**
 * The same read one column over: a `*_said` column, which holds the descriptor
 * on its own rather than under a key.
 *
 * Beside `sayIn` rather than in `api/panel/snapshot.ts`, where it was a second
 * function called `saidIn` — one letter apart, `message` optional where this one
 * requires it, and `undefined` where this one returns null. Nothing writes those
 * columns but the emitters, so the strict schema is the right one for both and
 * there is no reason for two.
 */
export const saidFrom = (value: unknown): Said | null => StoredSchema.safeParse(value).data ?? null;
