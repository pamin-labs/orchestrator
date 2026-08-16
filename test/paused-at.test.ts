import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { openMemory } from "../src/db.ts";
import { credentialChanged } from "../src/api/panel/authflow.ts";
import { release } from "../src/mech/flow/intercept.ts";
import { testContext } from "./test-context.ts";

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
  const db = openMemory();
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p','/tmp/p',0)");
  const mk = (name: string, reason: string) =>
    db.run(
      `INSERT INTO grp (project_id, name, status, paused_at, pause_reason, created_at)
       VALUES (1, ?, 'PAUSED', 1, ?, 0)`,
      [name, reason],
    );
  mk("boss-paused", "boss");
  mk("burnt", "budget");
  mk("throttled", "ratelimit");
  mk("codex-token", "auth:codex");
  mk("github-token", "auth:github");

  const ctx = testContext({ db });
  await credentialChanged(ctx, "github");

  const running = db
    .query<{ name: string }, []>("SELECT name FROM grp WHERE status = 'RUNNING' ORDER BY name")
    .all()
    .map((r) => r.name);
  expect(running).toEqual(["github-token"]);
  // And the reason is cleared with the pause, or the next sign-in resumes it twice.
  expect(
    db
      .query<{ n: number }, []>("SELECT count(*) AS n FROM grp WHERE status = 'RUNNING' AND pause_reason IS NOT NULL")
      .get()!.n,
  ).toBe(0);
});

test("signing in answers only the literal runtime's escalation", async () => {
  const db = openMemory();
  for (const question of ["a_b 的凭据不好使了", "axb 的凭据不好使了"]) {
    db.run("INSERT INTO escalation (question, chain_state, created_at) VALUES (?, 'boss', 0)", [question]);
  }
  const ctx = testContext({ db });

  await credentialChanged(ctx, "a_b");

  expect(
    db
      .query<{ question: string; chain_state: string }, []>("SELECT question, chain_state FROM escalation ORDER BY id")
      .all(),
  ).toEqual([
    { question: "a_b 的凭据不好使了", chain_state: "answered" },
    { question: "axb 的凭据不好使了", chain_state: "boss" },
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
    for (const m of readFileSync(file, "utf8").matchAll(/UPDATE grp SET[^"`']*/g)) {
      // Stopping a group, or starting one that was stopped. Entering RUNNING
      // from PR_OPEN or from an approved DRAFT is a different transition and
      // touches none of these columns, so it is not this rule's business.
      const stops = /status = '(PAUSED|PAUSING)'/.test(m[0]);
      const starts = /status = 'RUNNING'/.test(m[0]) && /paused_at|pause_reason/.test(m[0]);
      if (stops || starts) offenders.push(`${file.split("/src/")[1]}: ${m[0].slice(0, 70)}`);
    }
  }
  expect(offenders).toEqual([]);
});

test("a resume clears what the stop was about, and leaves PARKED alone", () => {
  // Two of the four resume sites cleared `rl_resets_at`, one cleared `blocked_on`,
  // two cleared neither — so a group could come back RUNNING still carrying the
  // reason it stopped, and watchdog rule 6 only scans rows it still finds PAUSED.
  const db = openMemory();
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p','/tmp/p',0)");
  db.run(
    `INSERT INTO grp (project_id, name, status, paused_at, pause_reason, rl_resets_at, blocked_on, created_at)
     VALUES (1, 'g', 'PAUSED', 1, 'ratelimit', 999, NULL, 0)`,
  );
  // `blocked_on` is a foreign key, so the group it waits on has to exist.
  db.run("INSERT INTO grp (project_id, name, status, created_at) VALUES (1, 'other', 'RUNNING', 0)");
  db.run("UPDATE grp SET blocked_on = 2 WHERE id = 1");
  const ctx = testContext({ db });

  release(ctx, 1);
  const g = db
    .query<{ status: string; rl: number | null; waits: number | null; why: string | null }, []>(
      "SELECT status, rl_resets_at AS rl, blocked_on AS waits, pause_reason AS why FROM grp WHERE id = 1",
    )
    .get()!;
  expect(g).toEqual({ status: "RUNNING", rl: null, waits: null, why: null });

  // PARKED is not a state `release` leaves: a parked group's base may have moved,
  // so it comes back through `unpark`, which rebases first.
  db.run("UPDATE grp SET status = 'PARKED', pause_reason = 'escalation' WHERE id = 1");
  release(ctx, 1);
  expect(db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()!.status).toBe("PARKED");
  release(ctx, 1, { from: ["PARKED"] });
  expect(db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()!.status).toBe("RUNNING");
});
