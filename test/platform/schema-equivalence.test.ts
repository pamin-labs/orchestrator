import { expect, test } from "bun:test";

/**
 * The checked-in migrations still describe `schema.ts`.
 *
 * This file used to diff `schema.ts` against 46 hand-written migrations, because
 * the two were separate sources. `drizzle-kit generate` derives them now, so that
 * comparison is tautological — but the drift moved rather than went away: a column
 * edited without a regenerate leaves the SQL a deployment runs describing the old
 * shape, and the failure is a server that boots and then cannot write a column its
 * code believes in.
 */
test("schema.ts has nothing left to generate", async () => {
  // `--explain` is the dry run: it prints what it would write and writes nothing.
  // Generating for real would mean a failing test leaves a migration in the tree,
  // and a test that edits the repository is worse than the drift it found.
  const ran = Bun.spawnSync(["bunx", "drizzle-kit", "generate", "--explain"], {
    cwd: import.meta.dir.replace(/\/test\/platform$/, ""),
  });
  const out = `${ran.stdout.toString()}${ran.stderr.toString()}`;
  // Its own words, because the exit code is 0 either way — it succeeds at
  // planning a migration just as happily as at finding none to plan.
  expect({ code: ran.exitCode, planned: out.includes("Generated migration statements") }).toEqual({
    code: 0,
    planned: false,
  });
  // Spawning `drizzle-kit` and letting it read every migration is seconds, not
  // milliseconds, and the default cuts it off mid-run — which reports as a null
  // exit code, not as a timeout, and reads like drift that is not there.
}, 60_000);
