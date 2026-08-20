import { expect, test } from "bun:test";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { acceptSlice } from "../../src/mech/flow/review.ts";
import * as fx from "../support/factories.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";
import { testContext } from "../support/test-context.ts";

/**
 * Work that outlives the thing that started it must not fail out loud.
 *
 * Accepting a slice starts two pieces of detached work — the push, and whatever the
 * scheduler dispatches — and neither is awaited, because the boss's button cannot
 * wait on GitHub. Both end in a database write, and by then the row they wanted may
 * be gone: a dropped group, a shutdown, a harness that has moved on.
 */
/**
 * An escape from a detached chain is an unhandled rejection, and one surfaces
 * against **whatever is running when it lands** — which is how one of these
 * presented: a test failing one run in three, in a file it had nothing to do with,
 * passing every time it ran alone. The cost is not the failure; it is that a flaky
 * test gets read as noise and is no longer there when its subject breaks.
 */
test("detached work whose record is gone does not surface against an unrelated caller", async () => {
  const seen: string[] = [];
  const onReject = (error: Error) => seen.push(error.message);
  process.on("unhandledRejection", onReject);
  try {
    const db = await openMemory();
    const f = fx.on(db);
    // Resolved the moment the push is attempted, so the record can be taken away
    // while the detached chain is between its command and its report — the window
    // the `.catch` in `acceptSlice` exists for. A timer here would be a guess.
    let pushed!: () => void;
    const pushAttempted = new Promise<void>((resolve) => {
      pushed = resolve;
    });
    const ctx = await testContext({
      db,
      // The push is refused, so the failure path — the one that reports, and so
      // the one that writes — is the path under test.
      sandbox: fakeSandbox((cmd) => {
        if (!cmd.includes("push")) return {};
        pushed();
        return { code: 1, out: "denied" };
      }),
    });
    const p = await f.project.create({ name: "p", remote: "https://github.com/me/x.git" });
    const g = await f.runningGrp.create({ project_id: p.id, name: "g1", branch: "orch/g1" });
    await f.slice.create({ grp_id: g.id, seq: 1, title: "s", accept_spec: "a", status: "qa" });

    const accepting = acceptSlice(ctx, 1, "boss");
    await pushAttempted;
    // The record goes away while the detached work is still in flight. Not
    // `close()` — `the test database.close()` exits the process — and emptying the tables is
    // the case the detached `.catch` names anyway: `event.grp_id` is a foreign
    // key to a group that has been dropped, so the report throws.
    await openMemory();
    await accepting;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 300);
    });

    expect(seen).toEqual([]);
  } finally {
    process.off("unhandledRejection", onReject);
  }
});
