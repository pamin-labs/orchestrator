import { z } from "zod";
import { SaidSchema, type Said } from "../../../src/contracts/said.ts";
import { i18n } from "../i18n";

/**
 * What the server said, in the language this browser reads.
 *
 * The whole of it: the server sends `{ id, message, values }` — the object its
 * own `msg` macro produced — and Lingui renders the catalogue row for that id,
 * or the `message` beside it when this reader's catalogue has no row. English is
 * the second case for every sentence, and so is a panel older than the server
 * that named one, which is what makes adding a message non-breaking.
 */
/**
 * `fallback` is the row stored before `meta.say` existed. `state_change` — the
 * largest kind by emitters — is trimmed at seven days rather than migrated, so
 * the fallback is the migration.
 */
/**
 * A descriptor with neither a catalogue row nor a `message` renders as its own
 * id — `ev.group.merged`, on screen — so that case takes the fallback instead.
 * It is not hypothetical: every event stored before this shipped names an id
 * that no catalogue carries any more, and the body beside it is the sentence the
 * server rendered when it was written.
 */
export function saidText(said: Said | null | undefined, fallback: string): string {
  if (!said) return fallback;
  if (said.message === undefined && i18n.messages[said.id] === undefined) return fallback;
  // `message` only when there is one: `exactOptionalPropertyTypes` refuses an
  // explicit `message: undefined` on an option whose `message` is optional.
  return i18n._(said.id, said.values, said.message === undefined ? undefined : { message: said.message });
}

const MetaSchema = z.object({ say: SaidSchema.optional() });

/** The sentence an event's `meta` names, if it names one. */
export const sayIn = (meta: unknown): Said | null => MetaSchema.safeParse(meta).data?.say ?? null;
