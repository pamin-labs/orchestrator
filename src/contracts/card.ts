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
 * Headings a stored card can still carry. Cards live in `note.body` and are
 * re-validated on approval, so a card filed before the keys became ASCII has to
 * keep parsing — otherwise the boss meets `missing sections` on a card that is
 * plainly complete, and cannot approve it. Retire with `draftLegacy` in 0.2.0;
 * `test/governance/version.test.ts` is what says so out loud.
 */
const ALIAS: Record<string, Field> = {
  目标: "goal",
  不做: "non-goals",
  验收: "accept",
  切片: "slices",
  风险: "risk",
  反对: "objection",
};

/**
 * The field a heading names, in either grammar, or null.
 *
 * Lowercased because Markdown headings are conventionally capitalised and a
 * model writing `## Goal` is not making a mistake worth a rejected card. Chinese
 * had no such case to fold, which is why the exact match was safe before.
 */
export function fieldOf(name: string): Field | null {
  // `Object.hasOwn`, not a truthy index: `ALIAS` is a plain object, so
  // `ALIAS["constructor"]` is `Object` — truthy, and enough to make `## constructor`
  // name a section. Same accident `schemaAt` in `contracts/config.ts` closed.
  if (Object.hasOwn(ALIAS, name)) return ALIAS[name]!;
  const lower = name.toLowerCase();
  return DRAFT_FIELDS.find((field) => field === lower) ?? null;
}

/**
 * The shape of the pre-Markdown card ADR 016 replaced: `目标: …` on one line.
 *
 * Here beside the vocabulary because both readers meet it — `draftLegacy` walks
 * a whole stored card, `cardGoal` looks for one line of one — and a heading
 * grammar spelled twice is how the panel came to accept a form the parser did
 * not. Shape only: which word it is, is `fieldOf`'s answer.
 */
export const INLINE_FIELD = /^\s*([^\s:：]+)\s*[:：]\s*(.*)$/;
