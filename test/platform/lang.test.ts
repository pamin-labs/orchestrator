import { expect, test } from "bun:test";
import { say } from "../../src/platform/text/lang.ts";
import { MESSAGES, MESSAGE_IDS, type MessageId } from "../../src/platform/text/messages.generated.ts";
import { LOCALES } from "../../src/contracts/config.ts";

/**
 * What the orchestrator says, in ten languages, rendered on the server.
 *
 * This file used to guard two hand-kept tables behind `isChinese()` — a language
 * *pair*, so `output.language: 한국어` got English. The tables are the panel's
 * catalogs now, so what is left to check is that the generated one is total and
 * that the ids callers may name are the ids it has.
 */

test("a language that is neither English nor Chinese gets its own words", () => {
  // The bug this replaced: `isChinese(lang) ? ZH : EN` has no third row, so a
  // Korean boss read the feed in English however the knob was set.
  expect(say("한국어", "ev.group.merged")).toBe(MESSAGES.ko["ev.group.merged"]);
  expect(say("Русский", "ev.group.merged")).toBe(MESSAGES.ru["ev.group.merged"]);
  expect(say("English", "ev.group.merged")).not.toBe(say("Français", "ev.group.merged"));
  // Free text a person typed, so `localeOf` decides; an unrecognised one is the
  // source language rather than nothing.
  expect(say("Klingon", "ev.group.merged")).toBe(MESSAGES.en["ev.group.merged"]);
  // A unit test builds a Ctx without config; a missing language is not a reason
  // to throw inside a bus.emit.
  expect(() => say(undefined, "ev.gate.pass", { seq: 1 })).not.toThrow();
});

test("every locale answers every id", () => {
  const gaps = LOCALES.flatMap((l) => MESSAGE_IDS.filter((id) => !MESSAGES[l][id]).map((id) => `${l}: ${id}`));
  expect(gaps).toEqual([]);
});

/** The names a row asks its caller for, ICU plural branches included. */
const holes = (row: string): string[] => [...row.matchAll(/\{\s*(\w+)/g)].map((m) => m[1]!).sort();

/**
 * What this replaced could not fail.
 *
 * It asserted `!out.includes("{")` against a renderer that turns an unfilled
 * `{word}` into the empty string — so `turn ran past  min and was killed`
 * passed. ICU does the same thing, so the check has to stay on the rows: the
 * output is where the evidence has already been destroyed.
 */
/**
 * `ev.` only: `args` below is the union of what the `bus.emit` callers pass, and
 * the table also carries the host checks, whose values come from
 * `mech/ops/preflight.ts` and are covered where those are built.
 */
test("no placeholder survives into the boss's feed unfilled", () => {
  const args: Record<string, string | number> = {
    name: "g1",
    n: 3,
    seq: 2,
    role: "engineer",
    from: "qa",
    file: "a.ts",
    tokens: "8M",
    min: 5,
    at: "18:00",
    resource: "test",
    repo: "o/r",
    files: "a.ts",
    why: "boom",
    pid: 41,
    branch: "b",
    hours: 4,
    rule: "12",
    ruleName: "sandbox_swept",
    cmd: "opensandbox-server --port 1",
    base: "origin/main",
    sha: "abc1234",
    title: "t",
    tier: "M",
    reason: "no",
    path: "src/a.ts",
    target: 4,
    pct: 80,
  };
  const events = MESSAGE_IDS.filter((id) => id.startsWith("ev."));
  const unfilled = events.flatMap((id) =>
    holes(MESSAGES.en[id])
      .filter((h) => !(h in args) && h !== "plural" && h !== "selectordinal")
      .map((h) => `${id}: {${h}}`),
  );
  expect(unfilled).toEqual([]);
  for (const locale of LOCALES) {
    for (const id of events) expect(say(locale, id, args).length).toBeGreaterThan(0);
  }
});

test("a plural reads right at one, which is what a bare {n} could not", () => {
  const one = (id: MessageId, n: number) => say("English", id, { n, role: "engineer", file: "a.ts", files: "a.ts" });
  expect(one("ev.wd.no_progress", 1)).toContain("1 turn without");
  expect(one("ev.wd.no_progress", 2)).toContain("2 turns without");
  expect(say("Русский", "ev.notify.batch", { n: 2 })).toContain("дела");
  expect(say("Русский", "ev.notify.batch", { n: 5 })).toContain("дел");
  expect(say("English", "ev.sediment", { n: 3 })).toContain("3rd");
});
