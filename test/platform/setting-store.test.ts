import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { openMemory, readSetting, writeSetting } from "../../src/platform/persistence/database.ts";
import { setting } from "../../src/platform/persistence/schema.ts";

/**
 * The `setting` table's one reader and one writer.
 *
 * Nineteen call sites across six files wrote this SQL by hand before, and two had
 * independently arrived at the same "null removes it" rule. Collapsing them is only
 * safe if the pair keeps the distinction every reader depends on: a key never
 * written is *absent*, not empty and not zero.
 */
/**
 * Not hypothetical. Converting the watchdog's cadence check to this reader turned
 * `undefined` into `null`, and `Number(null)` is 0 where `Number(undefined)` is NaN
 * — so a rule that had never run read as one that ran at the epoch, and its first
 * hourly sweep waited an hour. These tests keep it caught at the layer where it
 * started.
 */

test("a key that was never written is absent, and absent does not survive Number()", async () => {
  const db = await openMemory();
  expect(await readSetting(db, "never.written")).toBeNull();
  // Stated rather than assumed, because this is the trap that bit: coercing the
  // absent value loses the absence. `Number(null)` is a finite 0, so a caller
  // that reaches for arithmetic before checking gets a real reading of a value
  // that was never stored. Test `=== null` first; every caller here does.
  expect(Number(await readSetting(db, "never.written"))).toBe(0);
});

test("writing round-trips, rewriting replaces, and null removes", async () => {
  const db = await openMemory();
  const rowsFor = async (k: string) => (await db.select().from(setting).where(eq(setting.k, k))).length;
  await writeSetting(db, "k", "first");
  expect(await readSetting(db, "k")).toBe("first");

  // Upsert, not a second row: the table has `k` as its key and a duplicate would
  // make the reader's answer depend on insertion order.
  await writeSetting(db, "k", "second");
  expect(await readSetting(db, "k")).toBe("second");
  expect(await rowsFor("k")).toBe(1);

  // Removed, rather than storing the four characters of "null" — which would
  // read back as a present value and defeat every caller's absence check.
  await writeSetting(db, "k", null);
  expect(await readSetting(db, "k")).toBeNull();
  expect(await rowsFor("k")).toBe(0);
});

test("removing a key that was never there is not an error", async () => {
  // Two of the converted call sites deleted unconditionally; making that throw
  // would have turned a no-op into a failed sandbox teardown.
  const db = await openMemory();
  expect(writeSetting(db, "absent", null)).resolves.toBeUndefined();
  expect(await readSetting(db, "absent")).toBeNull();
});
