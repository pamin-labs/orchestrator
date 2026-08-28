import { expect, test } from "bun:test";
import { AGENT_COMPLEXITY, newlyComplex, parseLizard } from "../../src/mech/knowledge/complexity.ts";

/**
 * Real `lizard --csv` output, copied from a run inside the agent image — three
 * languages, one of which (Kotlin) no grammar in this binary can parse, which is
 * the reason lizard is here at all rather than the scorer this replaced.
 *
 * The shape is `nloc,CCN,tokens,params,length,"name@lines@file","file","name",
 * "signature",start,end`, and a signature holds commas.
 */
const CSV = `1,6,30,1,1,"f@1-1@/t/a.js","/t/a.js","f","f ( a )",1,1
1,3,25,1,1,"f@1-1@/t/c.kt","/t/c.kt","f","f a : Int",1,1
1,3,26,1,1,"f@1-1@/t/d.swift","/t/d.swift","f","f _ a : Int",1,1
2,9,40,2,3,"parse@10-12@/t/e.py","/t/e.py","parse","parse ( self , text )",10,12`;

test("a row is a function, and a quoted signature is one cell", () => {
  expect(parseLizard(CSV)).toEqual([
    { name: "f", line: 1, score: 6 },
    { name: "f", line: 1, score: 3 },
    { name: "f", line: 1, score: 3 },
    // The signature's own comma did not shift the columns.
    { name: "parse", line: 10, score: 9 },
  ]);
});

test("what it cannot read is skipped rather than guessed at", () => {
  expect(parseLizard("")).toEqual([]);
  expect(parseLizard("not,csv")).toEqual([]);
  // A header or a summary line lizard may print alongside the rows.
  expect(parseLizard("1,2,3,4,5,6,7,8,9,10\ntotal nloc  avg.NLOC  ...")).toEqual([
    { name: "8", line: 10, score: 2 },
  ]);
});

/**
 * A repository this system did not write is full of functions over any useful
 * threshold. Refusing every slice until somebody fixes them is a system nobody
 * can adopt, so the question is whether this change made it worse.
 */
test("the ratchet reports what got worse, not what is bad", () => {
  const before = [
    { name: "old", line: 1, score: 9 },
    { name: "fine", line: 2, score: 2 },
  ];
  expect(
    newlyComplex(before, [
      // Already over, unchanged: not this slice's doing.
      { name: "old", line: 1, score: 9 },
      // Was fine, now is not.
      { name: "fine", line: 2, score: 7 },
      // Arrived over the line.
      { name: "new", line: 3, score: 8 },
    ]).map((f) => f.name),
  ).toEqual(["fine", "new"]);
  // Worse while already over is still worse.
  expect(newlyComplex(before, [{ name: "old", line: 1, score: 12 }]).map((f) => f.name)).toEqual(["old"]);
  // Improved is not news.
  expect(newlyComplex(before, [{ name: "old", line: 1, score: 7 }])).toEqual([]);
});

/** Uncle Bob's number, not ours: 4 for a person, 6 for an agent, because a model
 *  holds more of a function at once than a person does — and he is considering 8. */
test("the threshold is the published one", () => {
  expect(AGENT_COMPLEXITY).toBe(6);
});
