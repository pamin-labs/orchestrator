import { useState } from "react";

/**
 * A local edit to a value somebody else owns.
 *
 * Five components had written this as `useState(prop)` beside
 * `useEffect(() => setLocal(prop), [prop])` — a combobox, two knob editors, the
 * settings sections and a project field. That renders once with the stale copy,
 * commits, and renders again, which is what `react(set-state-in-effect)` names:
 * the effect's whole job is to undo the render before it.
 */
/**
 * Derived instead. An edit belongs to the value it was started from, and when
 * that value moves underneath there is nothing to carry over — so the answer is
 * the new one. Same behaviour, one render, and no effect.
 *
 * `on` is a resolved key rather than the values it stands for, for the reason a
 * React `key` is: `` `${n}:${unit}` `` compares, `[n, unit]` is a new identity
 * every render and would discard the edit as fast as it was typed.
 */
export function useDraft<V>(on: string, value: V): [V, (next: V) => void] {
  const [edit, setEdit] = useState({ on, value });
  return [edit.on === on ? edit.value : value, (next: V) => setEdit({ on, value: next })];
}
