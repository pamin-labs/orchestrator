import { expect, test } from "bun:test";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { acceptSlice } from "../../src/mech/flow/review.ts";
import * as fx from "../support/factories.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";
import { testContext } from "../support/test-context.ts";

/**
 * Work that outlives the thing that started it must not fail out loud.
 *
 * Accepting a slice starts two pieces of detached work — the push to the remote,
 * and whatever the scheduler dispatches — and neither is awaited, because the
 * boss's button cannot wait on GitHub. Both end in a database write, and by the
 * time they land the row they wanted may be gone: a dropped group, a shutdown,
 * a test whose harness has moved on.
 *
 * An escape from a detached chain is an unhandled rejection, and an unhandled
 * rejection surfaces against **whatever is running when it lands** — which is
 * how one of these presented: a test that failed one run in three, in a file it
 * had nothing to do with, and passed every time it was run on its own. The cost
 * of that is not the failure, it is that a flaky test gets read as noise and is
 * no longer there when the behaviour it guards actually breaks.
 */
test("detached work whose record is gone does not surface against an unrelated caller", async () => {
  const seen: string[] = [];
  const onReject = (error: Error) => seen.push(error.message);
  process.on("unhandledRejection", onReject);
  try {
    const db = openMemory();
    const ctx = testContext({
      db,
      // The push is refused, so the failure path — the one that reports, and so
      // the one that writes — is the path under test.
      sandbox: fakeSandbox((cmd) => (cmd.includes("push") ? { code: 1, out: "denied" } : {})),
    });
    const p = fx.project.insert(db, { name: "p", remote: "https://github.com/me/x.git" });
    const g = fx.runningGrp.insert(db, { project_id: p.id, name: "g1", branch: "orch/g1" });
    fx.slice.insert(db, { grp_id: g.id, seq: 1, title: "s", accept_spec: "a", status: "qa" });

    acceptSlice(ctx, 1, "boss");
    // The record goes away while the detached work is still in flight.
    db.close();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 300);
    });

    expect(seen).toEqual([]);
  } finally {
    process.off("unhandledRejection", onReject);
  }
});
