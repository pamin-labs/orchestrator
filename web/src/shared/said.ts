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
