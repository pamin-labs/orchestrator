import { expect, test } from "bun:test";
import { trimEvents } from "../../src/platform/persistence/event-bus.ts";
import { openMemory } from "../../src/platform/persistence/database.ts";
import * as fx from "../support/factories.ts";

/**
 * The event table had no retention at all — the only `DELETE FROM event` in the
 * tree was project deletion. So an installation kept every `state_change` it had
 * ever emitted, and a stale SSE cursor replays all of them into a reconnecting tab.
 */

const NOW = 1_800_000_000_000;
const WEEK = 7 * 24 * 60 * 60 * 1_000;

function seed() {
  const db = openMemory();
  const old = NOW - WEEK - 1;
  for (const kind of ["say", "boss_say", "note", "escalation", "state_change", "tool_summary"]) {
    fx.event.insert(db, { author: "a", kind, body: `old ${kind}`, at: old });
    fx.event.insert(db, { author: "a", kind, body: `fresh ${kind}`, at: NOW });
  }
  return db;
}

const kindsLeft = (db: ReturnType<typeof openMemory>) =>
  db
    .query<{ kind: string; body: string }, []>("SELECT kind, body FROM event ORDER BY kind, at, seq")
    .all()
    .map((row) => row.body)
    .toSorted();

test("what the boss and the agents said is kept; what the machine said about it is not", () => {
  const db = seed();
  const dropped = trimEvents(db, WEEK, NOW);

  // Deleting a conversation row moves an agent's unread cursor past a message
  // nobody read, and loses the boss's own words — those are the record.
  expect(kindsLeft(db)).toEqual(
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
  db.close();
});

test("retention is idempotent, so a heartbeat every 30 seconds is not a rewrite", () => {
  const db = seed();
  expect(trimEvents(db, WEEK, NOW)).toBe(2);
  expect(trimEvents(db, WEEK, NOW)).toBe(0);
  db.close();
});
