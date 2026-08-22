import { expect, test } from "bun:test";
import { scan } from "../support/ast.ts";

/**
 * A test builds its scheduler through `test/support/scheduler.ts`, never itself.
 *
 * A scheduler nobody holds any more keeps dispatching, and the tests in a file
 * share one database — so a stale one claims the next test's job row and runs it
 * against the previous harness's executor. Different victim every run, and
 * re-running makes it green. The count that made it a rule is in that file.
 */
const OWN = "test/support/scheduler.ts";
const RAW = "new Scheduler(";

// This file has to spell the shape it forbids, so it exempts itself by identity
// rather than by a name a rename would leave behind.
const HERE = import.meta.path.slice(`${process.cwd()}/`.length);

const offenders = (file: string, source: string): string[] =>
  file !== OWN && file !== HERE && source.includes(RAW) ? [`${file} constructs a scheduler the run never closes`] : [];

test("no test constructs a Scheduler outside the factory that closes it", () => {
  expect(scan("test/**/*.ts", offenders)).toEqual([]);
});

test("it fires on a hand-built scheduler and not on the factory's own", () => {
  expect(offenders("test/mech/probe.test.ts", `const s = ${RAW}db, exec);`)).toHaveLength(1);
  expect(offenders(OWN, `const s = ${RAW}...args);`)).toEqual([]);
  expect(offenders("test/mech/probe.test.ts", "const s = newScheduler(db, exec);")).toEqual([]);
});
