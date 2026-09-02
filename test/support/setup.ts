import { afterAll, beforeEach } from "bun:test";
import { rmSync } from "node:fs";
import { createdRoot } from "./temp.ts";
import { closeTestDatabases } from "../../src/platform/persistence/database.ts";
import { stopSchedulers } from "./scheduler.ts";
import { resetRepoHolds } from "../../src/mech/git/repository.ts";
import { resetNet } from "../../src/mech/sandbox/net.ts";
import { resetSandboxHold } from "../../src/mech/sandbox/sandbox.ts";
import { resetServerRestarts } from "../../src/mech/ops/watchdog.ts";
import { resetSkillsWarned } from "../../src/mech/skills.ts";
import { i18n } from "../../web/src/i18n.ts";
import { messages } from "../../locales/zh.po";

/**
 * Every pane renders under the Chinese catalog, so the 242 assertions that read
 * Chinese out of the panel keep asserting — and become the only check that the
 * catalog puts the right string in the right slot. The English source is what
 * `test/web/english-renders.test.tsx` covers, deliberately somewhere else.
 */
i18n.load("zh", messages);
i18n.activate("zh");

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
beforeEach(async () => {
  // The active locale is a process-global like the five below it. `test/web`
  // asserts Chinese because this file activates `zh`, and a test that moves the
  // locale and does not move it back leaves every later file in the process
  // reading English — `say-falls-back-to-body` ended on `activate("en")`, and
  // 120 failures in six unrelated files followed it through the stress pass.
  // Invisible under `--parallel`, where each file has its own process.
  // The catalog, not only the locale. `activate` alone was enough while every
  // file had its own module registry; sharing one, a file that replaces the `zh`
  // catalog leaves every later file rendering the English source under a Chinese
  // locale, which reads as "the panel stopped being translated" and is really
  // one line in one earlier file.
  i18n.load("zh", messages);
  i18n.activate("zh");
  // The browser's own store is process state too, and the same kind: a theme a
  // hotkey test wrote is the theme the next file's first press cycles from.
  localStorage?.clear();
  resetSandboxHold();
  resetRepoHolds();
  resetNet();
  resetServerRestarts();
  resetSkillsWarned();
  await stopSchedulers();
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
