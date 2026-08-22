import { renderWith, type Said } from "../../../src/contracts/said.ts";
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
  said ? renderWith(i18n, said) : fallback;

/**
 * A refusal held for later, which is the shape `readJson` returns on failure.
 *
 * The panel keeps refusals on fields and in dialogs, and a sentence kept is a
 * sentence that outlives the locale it was fetched under. So what is kept is the
 * descriptor, and `refusalText` is where it becomes words — inside a render,
 * under whichever catalogue is active then.
 */
export type Refusal = { said: Said | null; text: string };

/** The refusal, in the language being read now. Empty for no refusal, because
 *  every caller renders it into a prop that is a string. */
export const refusalText = (refusal: Refusal | null): string => (refusal ? saidText(refusal.said, refusal.text) : "");
