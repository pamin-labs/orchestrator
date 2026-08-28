/**
 * How many ways there are through each function, as `lizard` counts them.
 *
 * The measure Uncle Bob's pipeline gates on, and the one this repository applies
 * to itself through `fallow` and to the projects it drives not at all.
 */
/**
 * Rented, not written. A tree-sitter scorer was written first and worked, on the
 * six grammars this binary carries; `lizard` does twenty-two — Kotlin, Swift,
 * Scala, PHP, Ruby, Zig — which is the answer to "what about the other
 * languages" that a table here never will be. Measured at +49 MB in the image.
 */
export interface Fn {
  name: string;
  /** 1-based, as an editor and a reviewer both count. */
  line: number;
  score: number;
}

/**
 * `lizard --csv`, which is a transform of its default table:
 * `nloc,CCN,tokens,params,length,"name@lines@file","file","name","signature",start,end`.
 *
 * Parsed by position because that is what the format is. A row this cannot read
 * is skipped rather than guessed at — the file may simply be in a language
 * lizard reports differently, and a wrong score is worse than a missing one.
 */
export function parseLizard(csv: string): Fn[] {
  const out: Fn[] = [];
  for (const line of csv.split("\n")) {
    const cells = splitCsv(line.trim());
    if (cells.length < 10) continue;
    const score = Number(cells[1]);
    const start = Number(cells[9]);
    const name = cells[7];
    if (!name || !Number.isFinite(score) || !Number.isFinite(start)) continue;
    out.push({ name, line: start, score });
  }
  return out;
}

/** A signature holds commas — `"f ( a , b )"` — so quoted cells are one cell. */
function splitCsv(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      cells.push(cur);
      cur = "";
    } else cur += ch;
  }
  cells.push(cur);
  return cells;
}

/**
 * The threshold, and it is Uncle Bob's number rather than ours.
 *
 * He gates his own agents at 6 and is considering 8, against 4 for a human,
 * because a model holds more of a function at once than a person does. Six is the
 * published figure and the conservative end of what he is willing to allow.
 */
export const AGENT_COMPLEXITY = 6;

/**
 * Functions this change put over the threshold that were not over it before.
 *
 * A ratchet, not a gate: a project this system did not write is full of functions
 * over any threshold worth having, and refusing every slice until somebody fixes
 * them is a system nobody can adopt. What it will not allow is **more** of them.
 */
export function newlyComplex(before: Fn[], after: Fn[], threshold = AGENT_COMPLEXITY): Fn[] {
  const over = (fns: Fn[]) => fns.filter((f) => f.score > threshold);
  const was = new Map<string, number>();
  for (const fn of over(before)) was.set(fn.name, Math.max(was.get(fn.name) ?? 0, fn.score));
  // By name, so a function that moved down the file is the same function, and a
  // rename reads as one arriving — the honest answer, since a renamed function is
  // one a reviewer has not seen under that name either.
  return over(after).filter((fn) => (was.get(fn.name) ?? 0) < fn.score);
}
