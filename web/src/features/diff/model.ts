import { diffWordsWithSpace } from "diff";

/**
 * What the side-by-side viewer decides before it renders anything: which wash a
 * cell earns, and which words inside it moved. Both are arithmetic rather than
 * markup, and both are what a reader trusts when they accept a slice, so they
 * are asserted here instead of being read back out of a `<td>`.
 */

export type SideName = "left" | "right";

export interface Cell {
  n: number;
  text: string;
  changed?: boolean;
}

/** No cell is a hole; an orphan or an edited cell is tinted on its own side. */
export type Tone = "empty" | "left" | "right" | "same";

export function sideTone(side: SideName, cell?: Cell, other?: Cell): Tone {
  if (!cell) return "empty";
  return !other || cell.changed ? side : "same";
}

/** `key` is stable within one cell: the offset a span starts at plus its text. */
export interface Span {
  key: string;
  text: string;
  marked: boolean;
}

/**
 * The words of one side of a paired line, with the ones that moved marked.
 *
 * The word diff has a direction — old to new — and each side keeps the parts the
 * other side lost or gained. Reading it in cell order instead made the right
 * pane diff new against old, drop the added words and keep the removed ones:
 * every edited line rendered the *old* text on both sides, marked as if it were
 * the new one, so the change being accepted was never on screen.
 */
export function markSpans(text: string, other: string, side: SideName): Span[] {
  const parts = diffWordsWithSpace(...(side === "left" ? ([text, other] as const) : ([other, text] as const)));
  const mine = side === "left" ? "removed" : "added";
  const theirs = side === "left" ? "added" : "removed";
  const spans: Span[] = [];
  let offset = 0;
  for (const part of parts) {
    if (part[theirs]) continue;
    spans.push({ key: `${offset}:${part.value}`, text: part.value, marked: !!part[mine] });
    offset += part.value.length;
  }
  return spans;
}
