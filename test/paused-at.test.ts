import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { openMemory } from "../src/db.ts";
import { credentialChanged } from "../src/api/panel/authflow.ts";
import type { Ctx } from "../src/ctx.ts";

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

  const ctx = {
    db,
    bus: { emit: () => {} },
    sched: { tick: () => {} },
    config: {},
  } as unknown as Ctx;
  await credentialChanged(ctx, "github");

  const running = db
    .query<{ name: string }, []>("SELECT name FROM grp WHERE status = 'RUNNING' ORDER BY name")
    .all()
    .map((r) => r.name);
  expect(running).toEqual(["github-token"]);
  // And the reason is cleared with the pause, or the next sign-in resumes it twice.
  expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM grp WHERE status = 'RUNNING' AND pause_reason IS NOT NULL").get()!.n).toBe(0);
});
