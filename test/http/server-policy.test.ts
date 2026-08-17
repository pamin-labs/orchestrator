import { expect, test } from "bun:test";
import {
  applyPrOutcome,
  chargedProject,
  heartbeat,
  recordIndexResult,
  reportRejection,
} from "../../src/composition/server.ts";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { testContext } from "../support/test-context.ts";
import { makeGithub } from "../../src/mech/git/github.ts";
import type { Feedback } from "../../src/mech/git/prwatch.ts";
import { Notifier } from "../../src/mech/ops/notify.ts";

/**
 * Four decisions the server makes on a timer, none of which used to be reachable
 * without starting one. They were written inside closures and callbacks, so the
 * only way to exercise a branch was to run the process and wait.
 */

function project(db: ReturnType<typeof openMemory>, name = "p"): number {
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES (?, '/tmp/p', 0)", [name]);
  return db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!.id;
}

function group(db: ReturnType<typeof openMemory>, projectId: number, name = "g"): number {
  db.run("INSERT INTO grp (project_id, name, created_at) VALUES (?, ?, 0)", [projectId, name]);
  return db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!.id;
}

/** A real notifier whose delivery goes nowhere, so nothing here pushes to the boss. */
const silent = new Notifier({ deliver: () => {} });

/** A real client whose transport never answers, so no test can reach GitHub. */
const offlineGithub = (db: ReturnType<typeof openMemory>) =>
  makeGithub(db, () => Promise.reject(new Error("no network in tests")));

/** A promise that stays pending for the whole test. */
const never = () => new Promise<void>(() => {});

const feedback = (over: Partial<Feedback>): Feedback => ({
  grpId: 1,
  prNumber: 7,
  comments: [],
  failingChecks: [],
  ...over,
});

test("an index call is billed to the project, whichever scope asked for it", () => {
  const db = openMemory();
  const p = project(db);
  const g = group(db, p);

  expect(chargedProject(db, { project: p })).toBe(p);
  // A group-scoped call bills the group's project, or the most frequent model
  // call in the system is invisible in every cost total.
  expect(chargedProject(db, { grp: g })).toBe(p);
  // Nothing in the utility container asks a model — it has no agent in it, which
  // is the entire reason it may hold real tokens.
  expect(chargedProject(db, { util: true })).toBeUndefined();
  expect(chargedProject(db, { grp: 9999 })).toBeUndefined();
});

test("a merge wins over a close arriving in the same poll", () => {
  const ctx = testContext();
  const p = project(ctx.db);
  const g = group(ctx.db, p);
  ctx.db.run("UPDATE grp SET status = 'PR_OPEN' WHERE id = ?", [g]);

  // GitHub reports both on a PR that merged and closed between two polls.
  // Reading `closed` first would stop a group whose work is already on main.
  applyPrOutcome(ctx, feedback({ grpId: g, merged: true, closed: true }), "http://x", silent);

  const state = ctx.db.query<{ status: string }, [number]>("SELECT status FROM grp WHERE id = ?").get(g)?.status;
  expect(state).not.toBe("PR_OPEN");
  const asked = ctx.db.query<{ c: number }, []>("SELECT count(*) AS c FROM escalation").get()!.c;
  expect(asked).toBe(0);
});

test("a close without a merge stops the group and asks the boss", () => {
  const ctx = testContext();
  const p = project(ctx.db);
  const g = group(ctx.db, p);
  ctx.db.run("UPDATE grp SET status = 'PR_OPEN' WHERE id = ?", [g]);

  applyPrOutcome(ctx, feedback({ grpId: g, prNumber: 12, closed: true }), "http://x", silent);

  const esc = ctx.db.query<{ question: string; chain_state: string }, []>("SELECT * FROM escalation").get();
  expect(esc?.chain_state).toBe("boss");
  // Nothing reopens it automatically: the close was deliberate, and undoing a
  // deliberate act because a poller disagreed is the worst kind of helpful.
  expect(esc?.question).toContain("重开");
});

test("an index pass only marks the tree fresh when it did work and none of it failed", () => {
  const ctx = testContext();
  const p = project(ctx.db);

  recordIndexResult(ctx, p, "sha-1", { calls: 3, failed: 0, files: 9 });
  const said = ctx.db.query<{ body: string }, []>("SELECT body FROM event ORDER BY seq DESC").get();
  expect(said?.body).toContain("3 node(s), 9 files");

  // Every call failed: that is the model being down, not the repository being
  // broken, and it is reported once rather than every pass.
  recordIndexResult(ctx, p, "sha-2", { calls: 2, failed: 2, files: 4 });
  recordIndexResult(ctx, p, "sha-3", { calls: 2, failed: 2, files: 4 });
  const blockers = ctx.db
    .query<{ c: number }, []>("SELECT count(*) AS c FROM event WHERE severity = 'blocker'")
    .get()!.c;
  expect(blockers).toBe(1);
});

test("a pass with no calls says nothing at all", () => {
  const ctx = testContext();
  const p = project(ctx.db);
  const before = ctx.db.query<{ c: number }, []>("SELECT count(*) AS c FROM event").get()!.c;

  recordIndexResult(ctx, p, "sha-1", { calls: 0, failed: 0, files: 0 });

  expect(ctx.db.query<{ c: number }, []>("SELECT count(*) AS c FROM event").get()!.c).toBe(before);
});

test("a repeating rejection reaches the feed once, not every tick", () => {
  const ctx = testContext();
  const boom = new Error("the same detached chain");

  const first = reportRejection(ctx, boom, "");
  const second = reportRejection(ctx, boom, first);
  expect(second).toBe(first);

  const different = reportRejection(ctx, new Error("a different one"), second);
  expect(different).not.toBe(second);

  const feed = ctx.db.query<{ c: number }, []>("SELECT count(*) AS c FROM event WHERE severity = 'blocker'").get()!.c;
  // Two distinct causes, three rejections. Without the check a single recurring
  // bug is a blocker line every thirty seconds and the feed stops being readable.
  expect(feed).toBe(2);
});

test("the heartbeat queues one watchdog, not one per tick", () => {
  const ctx = testContext();
  const enqueued: string[] = [];
  const deps = {
    ctx,
    db: ctx.db,
    sched: { enqueue: (kind: string) => enqueued.push(kind), tick: () => 0 },
    gh: offlineGithub(ctx.db),
    url: "http://x",
    notifier: silent,
    track: <T>(work: Promise<T>) => work,
    // Held so the tick cannot reach the network; the watchdog decision is above it.
    inFlight: { index: never(), poll: never() },
  };

  heartbeat(deps);
  expect(enqueued).toEqual(["watchdog"]);

  // A second pending watchdog would only re-examine the same groups, and the
  // queue is not where that should pile up.
  ctx.db.run(
    "INSERT INTO job (kind, state, payload_json, priority, enqueued_at) VALUES ('watchdog', 'pending', '{}', 0, 0)",
  );
  heartbeat(deps);
  expect(enqueued).toEqual(["watchdog"]);
});

test("the heartbeat starts no network work while the last round is still out", () => {
  const ctx = testContext();
  // Neither promise resolves during the test: that is the point — a tick landing
  // on top of an unfinished one must not start a second index or poll.
  const held = never();
  const inFlight = { index: held, poll: held };

  heartbeat({
    ctx,
    db: ctx.db,
    sched: { enqueue: () => 0, tick: () => 0 },
    gh: offlineGithub(ctx.db),
    url: "http://x",
    notifier: silent,
    track: <T>(work: Promise<T>) => work,
    inFlight,
  });

  expect(inFlight.index).toBe(held);
  expect(inFlight.poll).toBe(held);
});

test("a rejection is still reported when the record itself is what failed", () => {
  const ctx = testContext();
  // The record is what failed: a closed database is the real shape of that, and
  // the console line is still the report.
  ctx.db.close();

  expect(() => reportRejection(ctx, new Error("original"), "")).not.toThrow();
});
