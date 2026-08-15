import { expect, test } from "bun:test";
import { Bus } from "../src/bus.ts";
import { openMemory } from "../src/db.ts";
import { Scheduler } from "../src/scheduler.ts";
import { acceptSlice } from "../src/mech/flow/review.ts";
import { fakeSandbox } from "./fake-sandbox.ts";
import type { Ctx } from "../src/api.ts";

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
  const onReject = (e: unknown) => seen.push(String((e as Error)?.message ?? e));
  process.on("unhandledRejection", onReject);
  try {
    const db = openMemory();
    const ctx = {
      db,
      bus: new Bus(db),
      sched: new Scheduler(db, async () => {}),
      // The push is refused, so the failure path — the one that reports, and so
      // the one that writes — is the path under test.
      sandbox: fakeSandbox((cmd) => (cmd.includes("push") ? { code: 1, out: "denied" } : {})),
      waiters: new Map(),
      config: { language: "中文" },
    } as unknown as Ctx;
    db.run(
      "INSERT INTO project (name, repo_path, remote, created_at) VALUES ('p', '/tmp/p', 'https://github.com/me/x.git', 0)",
    );
    db.run("INSERT INTO grp (project_id, name, status, branch, created_at) VALUES (1, 'g1', 'RUNNING', 'orch/g1', 0)");
    db.run("INSERT INTO slice (grp_id, seq, title, accept_spec, status, created_at) VALUES (1, 1, 's', 'a', 'qa', 0)");

    acceptSlice(ctx, 1, "boss");
    // The record goes away while the detached work is still in flight.
    db.close();
    await new Promise((r) => setTimeout(r, 300));

    expect(seen).toEqual([]);
  } finally {
    process.off("unhandledRejection", onReject);
  }
});
