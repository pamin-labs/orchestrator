/**
 * What a DRAFT card's section headings are called.
 *
 * In contracts because both sides read them: `src/mech` parses a card the
 * Dispatcher filed, and the panel reads the goal line off one it is drawing.
 * Invariant 6 is why it is here rather than beside the validator.
 */
/** Two owners is why it exists at all: `web/src/shared/prose.ts` carried its own
 *  `(goal|目标)` regex, so the panel and the parser each held a copy of the
 *  vocabulary — and had already disagreed once. */
/**
 * The keys are a protocol rather than copy, which is why they are ASCII.
 *
 * They were Chinese, pinned there by `roles/dispatcher.yaml` writing `## 目标`
 * whatever `output.language` said — so a card came back with a Chinese heading
 * over English prose, and only because the model copied the template rather
 * than translating it, which nothing guaranteed.
 */
export const DRAFT_FIELDS = ["goal", "non-goals", "accept", "slices", "risk", "objection"] as const;
export type Field = (typeof DRAFT_FIELDS)[number];

/**
 * The field a heading names, or null.
 *
 * Lowercased because Markdown headings are conventionally capitalised and a
 * model writing `## Goal` is not making a mistake worth a rejected card.
 */
/** A second grammar stood here: an alias table of the headings a card carried
 *  before these keys became ASCII, and a regex for the one-line form ADR 016
 *  replaced. Both were compatibility aliases, which `docs/project/plan.md` puts
 *  out of scope before the first stable release. */
export function fieldOf(name: string): Field | null {
  const lower = name.toLowerCase();
  return DRAFT_FIELDS.find((field) => field === lower) ?? null;
}
