import { beforeEach } from "bun:test";
import { resetRepoHolds } from "../src/mech/github.ts";
import { resetNet } from "../src/mech/net.ts";
import { resetSandboxHold } from "../src/mech/sandbox.ts";
import { resetServerRestarts } from "../src/mech/watchdog.ts";

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
