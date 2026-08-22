import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { asc, eq, isNotNull, and } from "drizzle-orm";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { credentialChanged } from "../../src/api/panel/authflow.ts";
import { release } from "../../src/mech/flow/intercept.ts";
import { escalation, grp } from "../../src/platform/persistence/schema.ts";
import * as fx from "../support/factories.ts";
import { testContext } from "../support/test-context.ts";

/**
 * Every statement that writes the `grp` table, whole.
 *
 * The columns below used to be written as raw `UPDATE grp SET ...`; they are
 * Drizzle builders now, so a scan for the SQL text matches nothing and passes for
 * the wrong reason. Matched from `.update(<grp>)` to the semicolon that ends the
 * statement, because a builder is wrapped across five lines as often as not.
 */
const GRP_WRITES = /\.update\((?:grp|grps|grpTable)\)[\s\S]{0,600}?;/g;

/** Every `.ts` under `src/`. */
function sources(dir = new URL("../../src", import.meta.url).pathname): string[] {
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
    for (const m of readFileSync(file, "utf8").matchAll(GRP_WRITES)) {
      if (!/status: "(PAUSED|PAUSING)"/.test(m[0])) continue;
      // `pause_reason` for the same reason one column over: a resume is now
      // scoped to a cause, so a row paused without one is a row no resume can
      // ever be about — invisible in the other direction.
      for (const col of ["paused_at", "pause_reason"]) {
        if (!m[0].includes(col)) offenders.push(`${file.split("/src/")[1]} (no ${col}): ${m[0].slice(0, 70)}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});

test("signing in restarts what the credential stopped, and nothing else", async () => {
  // The bulk resume in `credentialChanged` was `WHERE status = 'PAUSED' AND
  // paused_at IS NOT NULL` — every paused group in the database. So connecting
  // GitHub from the settings page restarted a group the boss had paused by hand,
  // restarted one that had burnt its budget with nothing changed about the
  // budget, and restarted a rate-limited one still carrying `rl_resets_at` that
  // nothing would clear afterwards, because watchdog rule 6 only scans rows it
  // still finds PAUSED.
  const db = await openMemory();
  const f = fx.on(db);
  await f.project.create({ name: "p" });
  const mk = (name: string, reason: string) =>
    f.grp.create({ project_id: 1, name, status: "PAUSED", paused_at: 1, pause_reason: reason });
  await mk("boss-paused", "boss");
  await mk("burnt", "budget");
  await mk("throttled", "ratelimit");
  await mk("codex-token", "auth:codex");
  await mk("github-token", "auth:github");

  const ctx = await testContext({ db });
  await credentialChanged(ctx, "github");

  const running = await db.select({ name: grp.name }).from(grp).where(eq(grp.status, "RUNNING")).orderBy(asc(grp.name));
  expect(running.map((r) => r.name)).toEqual(["github-token"]);
  // And the reason is cleared with the pause, or the next sign-in resumes it twice.
  const stillReasoned = await db
    .select({ id: grp.id })
    .from(grp)
    .where(and(eq(grp.status, "RUNNING"), isNotNull(grp.pause_reason)));
  expect(stillReasoned).toHaveLength(0);
});

test("signing in answers the runtime's question whatever the question says", async () => {
  // The two halves of this matcher live in two files — `executor.ts` files the
  // question, `credentialChanged` closes it — and they used to agree on a Chinese
  // sentence. Neither question below is the sentence the product ships, or is
  // even in the same language, and the row is still found: `dedupe_key` is what
  // the two halves agree on now. `a_b` against `axb` because a runtime name may
  // contain `_`, which the `LIKE` this replaces would have read as a wildcard.
  const db = await openMemory();
  const f = fx.on(db);
  await f.escalation.create({ question: "rewritten entirely", dedupe_key: "auth:a_b", chain_state: "boss" });
  await f.escalation.create({ question: "переписано целиком", dedupe_key: "auth:axb", chain_state: "boss" });
  const ctx = await testContext({ db });

  await credentialChanged(ctx, "a_b");

  expect(
    await db
      .select({ dedupe_key: escalation.dedupe_key, chain_state: escalation.chain_state })
      .from(escalation)
      .orderBy(asc(escalation.id)),
  ).toEqual([
    { dedupe_key: "auth:a_b", chain_state: "answered" },
    { dedupe_key: "auth:axb", chain_state: "boss" },
  ]);
});

test("nothing stops or starts a group without going through hold/release", () => {
  // 硬约束 7 is here because three callers wrote PAUSING and forgot `paused_at`,
  // and every watchdog timer keys on it — the group went invisible to the park
  // timer, the nudge and the unpark at once while looking perfectly healthy.
  // `pause_reason` added a second field with the same property. Thirteen call
  // sites had to remember both; now none of them writes the statement at all.
  const offenders: string[] = [];
  for (const file of sources()) {
    if (file.endsWith("/flow/intercept.ts")) continue;
    for (const m of readFileSync(file, "utf8").matchAll(GRP_WRITES)) {
      // Stopping a group, or starting one that was stopped. Entering RUNNING
      // from PR_OPEN or from an approved DRAFT is a different transition and
      // touches none of these columns, so it is not this rule's business.
      const stops = /status: "(PAUSED|PAUSING)"/.test(m[0]);
      const starts = /status: "RUNNING"/.test(m[0]) && /paused_at|pause_reason/.test(m[0]);
      if (stops || starts) offenders.push(`${file.split("/src/")[1]}: ${m[0].slice(0, 70)}`);
    }
  }
  expect(offenders).toEqual([]);
});

test("a resume clears what the stop was about, and leaves PARKED alone", async () => {
  // Two of the four resume sites cleared `rl_resets_at`, one cleared `blocked_on`,
  // two cleared neither — so a group could come back RUNNING still carrying the
  // reason it stopped, and watchdog rule 6 only scans rows it still finds PAUSED.
  const db = await openMemory();
  const f = fx.on(db);
  await f.project.create({ name: "p" });
  await f.grp.create({
    project_id: 1,
    name: "g",
    status: "PAUSED",
    paused_at: 1,
    pause_reason: "ratelimit",
    rl_resets_at: 999,
  });
  // `blocked_on` is a foreign key, so the group it waits on has to exist.
  await f.runningGrp.create({ project_id: 1, name: "other" });
  await db.update(grp).set({ blocked_on: 2 }).where(eq(grp.id, 1));
  const ctx = await testContext({ db });

  await release(ctx, 1);
  const [g] = await db
    .select({ status: grp.status, rl: grp.rl_resets_at, waits: grp.blocked_on, why: grp.pause_reason })
    .from(grp)
    .where(eq(grp.id, 1));
  expect(g).toEqual({ status: "RUNNING", rl: null, waits: null, why: null });

  // PARKED is not a state `release` leaves: a parked group's base may have moved,
  // so it comes back through `unpark`, which rebases first.
  await db.update(grp).set({ status: "PARKED", pause_reason: "escalation" }).where(eq(grp.id, 1));
  const statusNow = async () => (await db.select({ status: grp.status }).from(grp).where(eq(grp.id, 1)))[0]?.status;
  await release(ctx, 1);
  expect(await statusNow()).toBe("PARKED");
  await release(ctx, 1, { from: ["PARKED"] });
  expect(await statusNow()).toBe("RUNNING");
});
