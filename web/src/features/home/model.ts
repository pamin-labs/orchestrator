import type { State } from "../../shared/api";
import { countWaiting, pending, projectState } from "../../shared/select";
import { K } from "../../shared/format";
import { t } from "@lingui/core/macro";

const LIVE = new Set(["RUNNING", "PLANNING"]);

// A zero is not a fact worth the right edge. 0 个需求 next to 空着 is the same
// absence twice, and 0 tokens is what every project starts at.
const count = (n: number, zh: string) => (n ? `${n} ${zh}` : "");

/** Whoever wants the boss most is read first. */
export const homeRows = (st: State) => [...st.projects].sort((a, b) => countWaiting(st, b.id) - countWaiting(st, a.id));

/** Everything one row says, decided before any of it is drawn. */
export function projectRow(st: State, id: number) {
  const w = pending(st, id);
  const gs = st.groups.filter((g) => g.project_id === id);
  const tokens = gs.reduce((x, g) => x + (g.spent_tokens || 0), 0);
  return {
    n: countWaiting(st, id),
    state: projectState(st, id),
    // What wants the boss here, in the order the queue reads it.
    bits: [
      count(w.cards.length, t`cards pending review`),
      count(w.slices.length, t`slices pending`),
      count(w.merges.length, t`pending merges`),
      count(w.asks.length, t`questions`),
    ].filter(Boolean),
    live: gs.filter((g) => LIVE.has(g.status)).map((g) => g.name),
    meta: [count(gs.length, t`requirements`), tokens ? `${K(tokens)} tokens` : ""].filter(Boolean),
  };
}
