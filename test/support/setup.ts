import { afterAll, beforeEach } from "bun:test";
import { rmSync } from "node:fs";
import { createdRoot } from "./temp.ts";
import { closeTestDatabases } from "../../src/platform/persistence/database.ts";
import { stopSchedulers } from "./test-context.ts";
import { resetRepoHolds } from "../../src/mech/git/repository.ts";
import { resetNet } from "../../src/mech/sandbox/net.ts";
import { resetSandboxHold } from "../../src/mech/sandbox/sandbox.ts";
import { resetServerRestarts } from "../../src/mech/ops/watchdog.ts";
import { resetSkillsWarned } from "../../src/mech/skills.ts";

/**
 * The three holds are module state, and `bun test` runs every file in one process.
 *
 * Each is a deliberate global — "no container can be opened", "this project's
 * GitHub is refusing", "this machine is offline" — because the fleet is, and one
 * holding is meant to stop every group at once. That is right in production and a
 * leak between test files, where the suite's answer starts depending on the order
 * files happen to run in.
 */
/**
 * Here rather than in each harness, for the reason all three exist: a rule every
 * caller has to remember is one the twentieth forgets. Nineteen files build a
 * Scheduler; this is one file.
 *
 * `beforeEach`, not `beforeAll`: no test inherits a hold from whatever ran before
 * it, including the test above it in its own file.
 */
beforeEach(() => {
  resetSandboxHold();
  resetRepoHolds();
  resetNet();
  resetServerRestarts();
  resetSkillsWarned();
  stopSchedulers();
});

/**
 * Every temporary directory the run made, removed once.
 *
 * `afterAll` in a preload is registered against the run rather than each file,
 * so this fires once when `bun test` is finished — and it fires whether the
 * suite passed, failed or threw, which is the whole point: the run that leaks is
 * the failing one, because a test that throws never reaches a cleanup written
 * after its assertions. `tempDir` puts everything under one parent so this stays
 * one call rather than a registry that each call site has to remember to join.
 */
afterAll(async () => {
  const root = createdRoot();
  if (root) rmSync(root, { recursive: true, force: true });
  // The file's pool, handed back. Each file evaluates the persistence module
  // afresh and opens its own; 188 of them outlives the server's connection cap.
  await closeTestDatabases();
});
