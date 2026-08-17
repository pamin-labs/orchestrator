import { afterAll, beforeEach } from "bun:test";
import { rmSync } from "node:fs";
import { createdRoot } from "./temp.ts";
import { resetRepoHolds } from "../../src/mech/git/repository.ts";
import { resetNet } from "../../src/mech/sandbox/net.ts";
import { resetSandboxHold } from "../../src/mech/sandbox/sandbox.ts";
import { resetServerRestarts } from "../../src/mech/ops/watchdog.ts";

/**
 * The three holds are module state, and `bun test` runs every file in one
 * process.
 *
 * Each of them is a deliberate global: "no container can be opened", "this
 * project's GitHub is refusing", "this machine is offline". They are global
 * because the fleet is — one of them holding is meant to stop every group at
 * once. That is right in production and it is a leak between test files, where
 * one file setting a hold changes what the next file's code does, and the
 * suite's answer starts depending on the order the files happen to run in.
 *
 * Here rather than in each harness, for the reason all three exist: a rule that
 * every caller has to remember is a rule that gets forgotten by the twentieth
 * one. Nineteen files build a Scheduler; this is one file. Preloaded via
 * `bunfig.toml`, whose lifecycle hooks apply to every test file.
 *
 * `beforeEach`, not `beforeAll`: the point is that no test inherits a hold from
 * whatever ran before it, including the test above it in its own file. The
 * three tests that assert on a hold set it themselves, inside the test.
 */
beforeEach(() => {
  resetSandboxHold();
  resetRepoHolds();
  resetNet();
  resetServerRestarts();
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
afterAll(() => {
  const root = createdRoot();
  if (root) rmSync(root, { recursive: true, force: true });
});
