import { expect, test } from "bun:test";
import { openMemory, readSetting, writeSetting } from "../../src/platform/persistence/database.ts";

/**
 * The `setting` table's one reader and one writer.
 *
 * Nineteen call sites across six files wrote this SQL by hand before, and two of
 * them had independently arrived at the same "null removes it" rule. Collapsing
 * them is only safe if the pair keeps the distinction every one of those readers
 * depends on: a key that was never written is *absent*, not empty and not zero.
 *
 * That is not hypothetical. Converting the watchdog's cadence check to this
 * reader turned `undefined` into `null`, `Number(null)` is 0 where
 * `Number(undefined)` is NaN, and a rule that had never run read as one that ran
 * at the epoch — so its first hourly sweep waited an hour. The suite caught it;
 * these tests keep it caught at the layer where it started.
 */

test("a key that was never written is absent, and absent does not survive Number()", () => {
  const db = openMemory();
  expect(readSetting(db, "never.written")).toBeNull();
  // Stated rather than assumed, because this is the trap that bit: coercing the
  // absent value loses the absence. `Number(null)` is a finite 0, so a caller
  // that reaches for arithmetic before checking gets a real reading of a value
  // that was never stored. Test `=== null` first; every caller here does.
  expect(Number(readSetting(db, "never.written"))).toBe(0);
});

test("writing round-trips, rewriting replaces, and null removes", () => {
  const db = openMemory();
  writeSetting(db, "k", "first");
  expect(readSetting(db, "k")).toBe("first");

  // Upsert, not a second row: the table has `k` as its key and a duplicate would
  // make the reader's answer depend on insertion order.
  writeSetting(db, "k", "second");
  expect(readSetting(db, "k")).toBe("second");
  expect(db.query<{ c: number }, [string]>("SELECT count(*) AS c FROM setting WHERE k = ?").get("k")!.c).toBe(1);

  // Removed, rather than storing the four characters of "null" — which would
  // read back as a present value and defeat every caller's absence check.
  writeSetting(db, "k", null);
  expect(readSetting(db, "k")).toBeNull();
  expect(db.query<{ c: number }, [string]>("SELECT count(*) AS c FROM setting WHERE k = ?").get("k")!.c).toBe(0);
});

test("removing a key that was never there is not an error", () => {
  // Two of the converted call sites deleted unconditionally; making that throw
  // would have turned a no-op into a failed sandbox teardown.
  const db = openMemory();
  expect(() => writeSetting(db, "absent", null)).not.toThrow();
  expect(readSetting(db, "absent")).toBeNull();
});
