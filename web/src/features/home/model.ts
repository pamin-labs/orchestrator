import type { State } from "../../lib/api";
import { countWaiting, pending, projectState } from "../../lib/select";
import { K } from "../../lib/utils";

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
      count(w.cards.length, "张卡待批"),
      count(w.slices.length, "片待查收"),
      count(w.merges.length, "个待合入"),
      count(w.asks.length, "个提问"),
    ].filter(Boolean),
    live: gs.filter((g) => LIVE.has(g.status)).map((g) => g.name),
    meta: [count(gs.length, "个需求"), tokens ? `${K(tokens)} tokens` : ""].filter(Boolean),
  };
}
