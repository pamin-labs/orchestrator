import { expect, test } from "bun:test";
import { errText } from "../../src/platform/process/text.ts";
import { readFileSync } from "node:fs";
import { Glob } from "bun";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { Bus } from "../../src/platform/persistence/event-bus.ts";
import { event } from "../../src/platform/persistence/schema.ts";

/**
 * An event is part of the transaction that decided to write it.
 *
 * `db.transaction` alone is not: the bus writes on its own handle, so the row
 * outlives a rollback under the pool and deadlocks under the single-connection
 * driver — and a subscriber told inside a transaction cannot be untold.
 * `bus.transaction` owns both halves, so this is what the rest of src must use.
 */
test("a rolled-back event reaches neither the table nor a subscriber", async () => {
  const db = await openMemory();
  const bus = new Bus(db);
  const seen: string[] = [];
  bus.subscribe((f) => void (f.type === "event" && seen.push(f.body ?? "")));

  // Caught rather than `await expect(...).rejects`: bun types that as void, so
  // awaiting trips `await-thenable` and not awaiting leaks the rejection.
  const refused = await bus
    .transaction(async () => {
      await bus.emit({ author: "boss", kind: "state_change", body: "rolled back" });
      throw new Error("rollback");
    })
    .then(
      () => "",
      (e: unknown) => errText(e),
    );
  expect(refused).toContain("rollback");
  await bus.transaction(async () => {
    await bus.emit({ author: "boss", kind: "state_change", body: "committed" });
  });

  expect({ seen, rows: (await db.select().from(event)).map((e) => e.body) }).toEqual({
    seen: ["committed"],
    rows: ["committed"],
  });
});

/**
 * Nesting flattens onto the open transaction.
 *
 * A second `db.transaction` inside one is a second connection under the pool and
 * a second connection under the pool, and either way an inner commit could survive an outer
 * rollback. Measured: the nested form hung until it reused the open handle.
 */
test("an inner transaction that commits is still discarded when the outer rolls back", async () => {
  const db = await openMemory();
  const bus = new Bus(db);
  const seen: string[] = [];
  bus.subscribe((f) => void (f.type === "event" && seen.push(f.body ?? "")));

  const refused = await bus
    .transaction(async () => {
      await bus.emit({ author: "boss", kind: "state_change", body: "outer" });
      await bus.transaction(async () => {
        await bus.emit({ author: "boss", kind: "state_change", body: "inner" });
      });
      throw new Error("rollback both");
    })
    .then(
      () => "",
      (e: unknown) => errText(e),
    );
  expect(refused).toContain("rollback both");

  expect({ seen, rows: (await db.select().from(event)).map((e) => e.body) }).toEqual({ seen: [], rows: [] });
});

/**
 * Nobody reintroduces the raw form by accident.
 *
 * Eight routes emitted from inside `ctx.db.transaction`; under the pool each
 * would commit an event for work that rolled back. A plain `db.transaction` is
 * still fine — one with an emit or an enqueue inside it is the defect, because
 * only `transaction()` publishes the handle `writeHandle` reads.
 */
/** Where the callback given to `db.transaction(` at `at` ends. */
function callbackBody(text: string, at: number): string {
  const start = text.indexOf("{", at);
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}" && (depth -= 1) === 0) return text.slice(start, i);
  }
  return text.slice(start);
}

test("a transaction that emits or enqueues goes through the handle writeHandle can see", () => {
  const offenders = [...new Glob("src/**/*.ts").scanSync(".")]
    .filter((path) => !path.startsWith("src/platform/persistence/"))
    .flatMap((path) => {
      const text = readFileSync(path, "utf8");
      // Deliberately not `ctx.db` as well, though a helper handed the outer
      // handle inside a transaction is the same defect: finding a callback's end
      // by counting braces in source text runs past a template literal, and five
      // of the five it flagged were outside any transaction. A guard that cries
      // wolf gets suppressed, and then it guards nothing.
      return [...text.matchAll(/db\.transaction\(/g)]
        .filter((hit) => /\.(?:emit|enqueue)\(/.test(callbackBody(text, hit.index)))
        .map((hit) => `${path}:${text.slice(0, hit.index).split("\n").length}`);
    });
  expect(offenders).toEqual([]);
});
