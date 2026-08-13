import type { State } from "./api";
import { K } from "./utils";

/**
 * Why one thing on the boss's list outranks another.
 *
 * "Everything here needs me" is true — that is the entry condition for the list — so
 * ordering has to come from what ignoring each one *costs*, and it has to be legible.
 * A score the boss cannot interrogate is worse than sorting by age: it moves rows
 * around for reasons nobody can check, and the first time it is wrong the whole order
 * stops being trusted.
 *
 * So every point is a named reason, and the row shows the reason rather than the
 * number. The weights are ordinary judgement, and they are all recoverable state:
 * nothing here is a model's opinion.
 */
export interface Reason {
  why: string;
  points: number;
}

export const REASONS = {
  /** An agent is literally hanging on the answer: `orch ask-boss` blocks its caller. */
  blocked: (who: string): Reason => ({ why: `${who} 挂着等你答`, points: 100 }),
  /**
   * A blocker the system raised, not an agent. Nothing is hanging on the answer — the
   * group is suspended — so claiming "an agent is waiting" would be a lie the row tells
   * to look urgent.
   */
  suspended: (): Reason => ({ why: "全组已挂起", points: 80 }),
  /** Nothing is running on this requirement, so the whole thing is stopped. */
  halted: (): Reason => ({ why: "组停着不动", points: 60 }),
  /** A queue head blocks everything behind it. */
  blocking: (n: number): Reason => ({ why: `后面还排着 ${n} 个`, points: 12 * n }),
  /** DRAFT blocks dispatch entirely: nothing in this requirement has started. */
  unstarted: (): Reason => ({ why: "批了才开工", points: 45 }),
  /** Money already spent and now sitting idle. */
  // Tokens, not dollars. codex reports no cost at all, so with usd here every
  // requirement that ran on it scored zero for sunk cost — the reason silently
  // stopped applying to five of the eight roles. 1M tokens is roughly where a
  // requirement starts being worth not abandoning.
  sunk: (tokens: number): Reason => ({
    why: `已经花了 ${K(tokens)} tokens`,
    points: Math.min(30, (tokens / 1e6) * 10),
  }),
  /** The clock. PLAN.md's whole argument for slicing work up. */
  waited: (ms: number): Reason => {
    const h = ms / 3_600_000;
    return { why: h >= 1 ? `等了 ${Math.round(h)}h` : `等了 ${Math.max(1, Math.round(h * 60))}m`, points: Math.min(40, h * 8) };
  },
} as const;

export interface Ranked {
  points: number;
  /** Highest-scoring reason first: what the row says about itself. */
  reasons: Reason[];
}

export function rank(reasons: (Reason | null | false | undefined)[]): Ranked {
  const list = reasons.filter((r): r is Reason => !!r).sort((a, b) => b.points - a.points);
  return { points: list.reduce((n, r) => n + r.points, 0), reasons: list };
}

/**
 * Group the boss's list by requirement — but only where grouping earns its keep.
 *
 * Grouping by requirement matters at scale: three items on one requirement means one
 * trip instead of three context switches. With one item each it is the opposite, a
 * header per row, so singletons stay flat.
 *
 * Not by agent. The boss acts on requirements, slices, cards and questions; an agent is
 * *who is waiting*, which belongs on the row as context and is not a thing to navigate
 * to. Grouping by it would sort the list by a dimension none of the buttons operate on.
 */
export function byRequirement<T extends { grpId: number | null; points: number }>(items: T[]) {
  const groups = new Map<number, T[]>();
  const loose: T[] = [];
  for (const i of items) {
    if (i.grpId == null) {
      loose.push(i);
      continue;
    }
    const list = groups.get(i.grpId) ?? [];
    list.push(i);
    groups.set(i.grpId, list);
  }
  const clustered: { grpId: number; items: T[]; points: number }[] = [];
  for (const [grpId, list] of groups) {
    if (list.length < 2) {
      loose.push(...list);
      continue;
    }
    list.sort((a, b) => b.points - a.points);
    // A cluster is as urgent as its most urgent member: burying a blocker under an
    // average would be the one mistake this ordering exists to avoid.
    clustered.push({ grpId, items: list, points: Math.max(...list.map((i) => i.points)) });
  }
  return {
    clustered: clustered.sort((a, b) => b.points - a.points),
    loose: loose.sort((a, b) => b.points - a.points),
  };
}

export const groupName = (st: State, id: number | null) => st.groups.find((g) => g.id === id)?.name ?? "";
