import { expect, test } from "bun:test";
import { asc } from "drizzle-orm";
import { trimEvents } from "../../src/platform/persistence/event-bus.ts";
import { type DB, openMemory } from "../../src/platform/persistence/database.ts";
import { event } from "../../src/platform/persistence/schema.ts";
import * as fx from "../support/factories.ts";

/**
 * The event table had no retention at all — the only `DELETE FROM event` in the
 * tree was project deletion. So an installation kept every `state_change` it had
 * ever emitted, and a stale SSE cursor replays all of them into a reconnecting tab.
 */

const NOW = 1_800_000_000_000;
const WEEK = 7 * 24 * 60 * 60 * 1_000;

async function seed() {
  const db = await openMemory();
  const f = fx.on(db);
  const old = NOW - WEEK - 1;
  for (const kind of ["say", "boss_say", "note", "escalation", "state_change", "tool_summary"]) {
    await f.event.create({ author: "a", kind, body: `old ${kind}`, at: old });
    await f.event.create({ author: "a", kind, body: `fresh ${kind}`, at: NOW });
  }
  return db;
}

const kindsLeft = async (db: DB) =>
  (await db.select({ body: event.body }).from(event).orderBy(asc(event.kind), asc(event.at), asc(event.seq)))
    .map((row) => row.body)
    .toSorted();

test("what the boss and the agents said is kept; what the machine said about it is not", async () => {
  const db = await seed();
  const dropped = await trimEvents(db, WEEK, NOW);

  // Deleting a conversation row moves an agent's unread cursor past a message
  // nobody read, and loses the boss's own words — those are the record.
  expect(await kindsLeft(db)).toEqual(
    [
      "fresh boss_say",
      "fresh escalation",
      "fresh note",
      "fresh say",
      "fresh state_change",
      "fresh tool_summary",
      "old boss_say",
      "old escalation",
      "old note",
      "old say",
    ].toSorted(),
  );
  expect(dropped).toBe(2);
});

test("retention is idempotent, so a heartbeat every 30 seconds is not a rewrite", async () => {
  const db = await seed();
  expect(await trimEvents(db, WEEK, NOW)).toBe(2);
  expect(await trimEvents(db, WEEK, NOW)).toBe(0);
});
