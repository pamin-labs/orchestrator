import { expect, test } from "bun:test";
import { mkdirSync, existsSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DROP_AFTER_MS, newestRollout, sweepCodexSessions } from "../../src/mech/ops/watchdog.ts";
import { openMemory } from "../../src/platform/persistence/database.ts";
import * as fx from "../support/factories.ts";
import { testContext } from "../support/test-context.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";
import { tempDir } from "../support/temp.ts";

/**
 * The two housekeeping steps of the tick that reach outside the database.
 *
 * Neither may throw. `runWatchdog` is straight-line async and drives about
 * twelve states, so a throw at one step silently un-drives every rule after it —
 * which is exactly how the whole tick once died at the first project row and
 * failed quietly every thirty seconds.
 */

const NOW = 1_700_000_000_000;

/** A `sessions` tree, dated. `age` is how long ago each file was last written. */
function sessions(files: Record<string, number>): string {
  const home = tempDir("orch-codex-");
  for (const [rel, age] of Object.entries(files)) {
    const path = join(home, "sessions", rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{}");
    const at = (NOW - age) / 1000;
    utimesSync(path, at, at);
  }
  return home;
}

test("rollouts past the retention window are dropped, however deep they are nested", () => {
  // codex writes one per session and nothing ever removed them: 78 files and
  // 110 MB in two days, next to a turn-log directory that has had a retention
  // window since the beginning. They are nested by date, so a flat readdir
  // finds none of them.
  const home = sessions({
    "2024/01/old.jsonl": DROP_AFTER_MS + 60_000,
    "2024/06/03/older.jsonl": 30 * 24 * 3600_000,
    "2024/06/04/fresh.jsonl": 60_000,
  });

  expect(sweepCodexSessions(home, NOW)).toBe(2);
  expect({
    "2024/06/04/fresh.jsonl": existsSync(join(home, "sessions/2024/06/04/fresh.jsonl")),
    "2024/01/old.jsonl": existsSync(join(home, "sessions/2024/01/old.jsonl")),
  }).toEqual({ "2024/06/04/fresh.jsonl": true, "2024/01/old.jsonl": false });
  // Only files are removed. The date directories are cheap and the next session
  // writes straight back into them.
  expect(readdirSync(join(home, "sessions"))).toEqual(["2024"]);
});

test("a file exactly at the window is kept, not dropped", () => {
  const home = sessions({ "a.jsonl": DROP_AFTER_MS });

  expect(sweepCodexSessions(home, NOW)).toBe(0);
  expect(existsSync(join(home, "sessions/a.jsonl"))).toBe(true);
});

test("a home with no sessions directory sweeps nothing rather than throwing", () => {
  // The host copy only exists once the weekly refresh nudge has run, so on most
  // machines this directory is simply not there.
  expect(sweepCodexSessions(tempDir("orch-codex-"), NOW)).toBe(0);
  expect(sweepCodexSessions("/nonexistent/codex-home", NOW)).toBe(0);
});

async function fleet(handle: (cmd: string) => { code?: number; out?: string }) {
  const db = await openMemory();
  const f = fx.on(db);
  const p = await f.project.create({ name: "p", repo_path: "me/x", sandbox_id: "sb-p" });
  await f.runningGrp.create({ name: "g", project_id: p.id, sandbox_id: "sb-g" });
  const sandbox = fakeSandbox((cmd) => handle(cmd));
  return { db, ctx: await testContext({ db, sandbox }), sandbox };
}

test("the quota read takes the first sandbox that answers and stops asking", async () => {
  const f = await fleet(() => ({ code: 0, out: '{"rate_limits":{}}\n' }));

  expect(await newestRollout(f.ctx)).toBe('{"rate_limits":{}}\n');
  expect(f.sandbox.commands.length).toBe(1);
});

test("a container that cannot answer is skipped, and the next one is asked", async () => {
  // The quota is the account's, not the container's, so one dead sandbox is not
  // a reason to report no quota at all.
  let first = true;
  const f = await fleet(() => {
    if (first) {
      first = false;
      return { code: 1, out: "" };
    }
    return { code: 0, out: "rollout" };
  });

  expect(await newestRollout(f.ctx)).toBe("rollout");
  expect(f.sandbox.commands.length).toBe(2);
});

test("a sandbox that answers empty is not mistaken for an answer", async () => {
  const f = await fleet(() => ({ code: 0, out: "   \n" }));

  expect(await newestRollout(f.ctx)).toBeNull();
});

test("a fleet with nothing running asks nothing and reports nothing", async () => {
  const db = await openMemory();
  const f = fx.on(db);
  const p = await f.project.create({ name: "p", repo_path: "me/x" });
  await f.runningGrp.create({ name: "g", project_id: p.id });
  const sandbox = fakeSandbox();

  expect(await newestRollout(await testContext({ db, sandbox }))).toBeNull();
  expect(sandbox.commands).toEqual([]);
});

test("a dissolved group's sandbox row is not reached into", async () => {
  // `DISSOLVED` and `PARKED` still carry a `sandbox_id` until the reaper gets to
  // them, and exec'ing into one costs a full container timeout on every tick.
  const db = await openMemory();
  const f = fx.on(db);
  const p = await f.project.create({ name: "p", repo_path: "me/x" });
  await f.grp.create({ name: "g", project_id: p.id, status: "DISSOLVED", sandbox_id: "sb-g" });
  const sandbox = fakeSandbox(() => ({ code: 0, out: "rollout" }));

  expect(await newestRollout(await testContext({ db, sandbox }))).toBeNull();
  expect(sandbox.commands).toEqual([]);
});
