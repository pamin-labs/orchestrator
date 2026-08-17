import type { Json } from "../../../../src/contracts/json";
import type { Shape } from "../../lib/units";

/**
 * What a settings row works out before it draws a control.
 *
 * The page is forty rows of "which editor does this value get, is this one still
 * the shipped default, and which of the six boxes on this row is the one being
 * complained about". All of it was inline in a component that fetches its own
 * rows, so none of it could be asked a question without a browser — and the two
 * rules that actually cost money if they go wrong (a value typed back to its
 * default is not an override; a refusal belongs on the cell, not on the row)
 * were the least reachable of the lot.
 */

/** A row whose value is a table rather than a line: the block sits under nothing. */
export const TABLES = new Set([
  "difficultyModel",
  "sliceBudgetTokens",
  "contextWindow",
  "leaseSlots",
  "sandbox.cacheDirs",
  "sandbox.denyDomains",
]);

/** Rows with no single control for a `<label>` to point at. They name themselves. */
const SELF_NAMED = new Set([...TABLES, "autoAcceptTiers", "indexModel.runtime"]);

/**
 * Whether the row's own title is what names its control. A `<label for>` and a
 * title cannot both hold the same id, and a switch or a six-box table has
 * nothing for a label to point at.
 */
export const selfNamed = (path: string, type: string): boolean => SELF_NAMED.has(path) || type === "boolean";

/** The id a self-naming row is labelled by, or nothing when a `<label>` does it. */
export const labelledBy = (path: string, type: string, id: string): string | undefined =>
  selfNamed(path, type) ? id : undefined;

/** What is wrong, and which box on the row it is wrong in. `""` is the row itself. */
export interface Complaint {
  why: string;
  at: string;
}

/** Nothing has been refused, so no box is marked and no reason is shown. */
export const NO_COMPLAINT: Complaint = { why: "", at: "" };

/**
 * Which cell the complaint is about, or null when there is none. `""` is the
 * row's own single box; collapsing the two marked every box on the pane invalid
 * the moment it rendered.
 */
export const badCell = (bad: Complaint): string | null => (bad.why ? bad.at : null);

/** `data-invalid`, which is an attribute that must be absent rather than false. */
export const invalidFlag = (bad: Complaint): "true" | undefined => (bad.why ? "true" : undefined);

/** Enough of a settings row to decide what it says about itself. */
export interface Override {
  overridden: boolean;
}

/** One row, so one 已改 — a paired row is changed if either half is. */
export const rowChanged = (knob: Override, mate: Override | null): boolean =>
  [knob, mate].some((item) => item?.overridden);

/** The second half of a paired row's stored value, or null when the row is single. */
export const mateValue = (mate: { value: Json } | null): Json => (mate ? mate.value : null);

/** An object value, or an empty map for a row whose value is not one. */
export const rec = (v: Json): Record<string, Json> => (v && !Array.isArray(v) && typeof v === "object" ? v : {});

/** A stored value as the text a box holds. An object goes in as its JSON. */
export const textOf = (v: Json): string =>
  v === null ? "" : typeof v === "string" ? v : typeof v === "object" ? (JSON.stringify(v) ?? "") : String(v);

/**
 * How many stored units one millisecond is, 0 for a knob that is no duration.
 *
 * `turnTimeoutMs` is milliseconds and `sandbox.ttlSeconds` is seconds, and both
 * are typed in 分钟 / 小时 — so the picker works in one scale and this is the
 * only place the other one is named.
 */
export const durationScale = (shape: Shape | undefined): number =>
  shape === "seconds" ? 1000 : shape === "ms" ? 1 : 0;

/** Which of the two map editors a row gets, and what its key box is for. */
export type PairKind = "int" | "text";

/**
 * Switching the index runtime, and the model that has to move with it.
 *
 * A null model means the one already set is fine; null altogether means nothing
 * changed and nothing should be written.
 */
export function runtimeSwitch(
  next: string,
  now: string,
  cheap: string | undefined,
  model: string,
): { runtime: string; model: string | null } | null {
  if (!next || next === now) return null;
  return { runtime: next, model: cheap && cheap !== model ? cheap : null };
}

/** What the desktop-notification row can say. `ask` is the only one with a button. */
export type NotifyState = "unsupported" | "granted" | "denied" | "ask";

/**
 * Where the browser's own permission stands. Four states rather than
 * granted/not: a browser without the API and one that was told no are both "you
 * will not get one", and only one of them is fixable from this page.
 */
export function notifyState(supported: boolean, permission: string): NotifyState {
  if (!supported) return "unsupported";
  if (permission === "granted") return "granted";
  return permission === "denied" ? "denied" : "ask";
}
