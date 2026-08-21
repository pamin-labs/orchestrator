import { z } from "zod";
import { SaidSchema, type Said } from "../../../src/contracts/said.ts";
import { i18n } from "../i18n";

/**
 * What the server said, in the language this browser reads.
 *
 * The whole of it: the server sends `{ id, message, values }` — the object its
 * own `msg` macro produced — and Lingui renders the catalogue row for that id.
 * All ten locales have one, English included, so the `message` beside the id is
 * belt to that braces rather than a path anything takes.
 */
/**
 * `fallback` is the row stored before `meta.say` existed: no `say` key at all,
 * so `sayIn` returns null. `state_change` — the largest kind by emitters — is
 * trimmed at seven days rather than migrated, so the fallback is the migration.
 */
export const saidText = (said: Said | null | undefined, fallback: string): string =>
  // `message` spelled in only when there is one: `exactOptionalPropertyTypes`
  // refuses an explicit `undefined` on Lingui's optional field.
  said ? i18n._(said.id, said.values, said.message === undefined ? undefined : { message: said.message }) : fallback;

/**
 * `message` required here and only here. This is the one input that is untrusted
 * JSON — a row read back out of `event.meta_json` — so a descriptor stored
 * before the macro named these is refused at the parse rather than checked for
 * later: `sayIn` returns null and the body stored beside it is drawn.
 */
const MetaSchema = z.object({ say: SaidSchema.extend({ message: z.string() }).optional() });

/** The sentence an event's `meta` names, if it names one. */
export const sayIn = (meta: unknown): Said | null => MetaSchema.safeParse(meta).data?.say ?? null;
