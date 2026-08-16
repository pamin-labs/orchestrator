import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Every `.ts` under `src/`. */
function sources(dir = new URL("../src", import.meta.url).pathname): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (e.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("nothing pauses a group without stamping when it happened", () => {
  // `paused_at` is the clock every timer that can move a paused group reads:
  // parking it after two hours, reminding the boss after fifteen minutes,
  // unparking it. A row that reaches PAUSED with NULL there is invisible to all
  // three at once, and it looks perfectly healthy — the group is PAUSED, it has
  // agents, nothing anywhere reports an error. It just never moves again.
  //
  // `settle()` covers the PAUSING -> PAUSED hop with a `coalesce`, so this is a
  // guard against the next writer rather than a live fault. It is a source
  // check because that is the only kind that fires when the line is written
  // instead of the night it matters: three callers had already drifted.
  const offenders: string[] = [];
  for (const file of sources()) {
    const text = readFileSync(file, "utf8");
    // A statement, not a line: these are wrapped across three lines as often as not.
    for (const m of text.matchAll(/UPDATE grp SET[^"`']*?status = '(PAUSED|PAUSING)'[^"`']*/g)) {
      if (!m[0].includes("paused_at")) offenders.push(`${file.split("/src/")[1]}: ${m[0].slice(0, 70)}`);
    }
  }
  expect(offenders).toEqual([]);
});
