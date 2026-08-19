import { expect, test } from "bun:test";
import {
  applyPrOutcome,
  chargedProject,
  heartbeat,
  recordIndexResult,
  indexPaused,
  indexTargets,
  indexThrew,
  INDEX_THROW_BACKOFF_MS,
  navigatorEnabled,
  reportServerState,
  routeRequest,
  reportRejection,
} from "../../src/composition/server.ts";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { testContext } from "../support/test-context.ts";
import { makeGithub } from "../../src/mech/git/github.ts";
import type { Feedback } from "../../src/mech/git/prwatch.ts";
import { Notifier } from "../../src/mech/ops/notify.ts";
import * as fx from "../support/factories.ts";

/**
 * Four decisions the server makes on a timer, none of which used to be reachable
 * without starting one. They were written inside closures and callbacks, so the
 * only way to exercise a branch was to run the process and wait.
 */

function project(db: ReturnType<typeof openMemory>, name = "p"): number {
  return fx.project.insert(db, { name }).id;
}

function group(db: ReturnType<typeof openMemory>, projectId: number, name = "g"): number {
  return fx.grp.insert(db, { project_id: projectId, name }).id;
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

  const first = reportRejection(ctx.bus, boom, "");
  const second = reportRejection(ctx.bus, boom, first);
  expect(second).toBe(first);

  const different = reportRejection(ctx.bus, new Error("a different one"), second);
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
  fx.job.insert(ctx.db, { kind: "watchdog", state: "pending" });
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

  expect(() => reportRejection(ctx.bus, new Error("original"), "")).not.toThrow();
});

/**
 * A model that cannot answer stops being asked, until the credentials move.
 *
 * `indexModelDown` was a `Set` that gated the *warning* and nothing else, so a
 * project whose index runtime had no credential ran the pass again every tick:
 * 2,835 calls in a day, every one an error at 21s each — sixteen hours of wall
 * clock, plus a container checkout in front of each pass.
 *
 * A stamp that moves is the only evidence the thing which failed might now work.
 */
test("an index model that answers nothing is not asked again until credentials change", () => {
  const ctx = testContext();
  const p = project(ctx.db);
  // A remote, because a project without one is skipped for a different reason and
  // the assertion below would hold without proving anything.
  ctx.db.run("UPDATE project SET remote = ? WHERE id = ?", ["git@example.com:o/r.git", p]);
  expect(indexPaused(ctx.db, p)).toBe(false);
  // Non-empty first, or the assertion below would hold for the wrong reason.
  expect(indexTargets(ctx.db).map((t) => t.id)).toEqual([p]);

  recordIndexResult(ctx, p, "sha-1", { calls: 12, failed: 12, files: 30 });
  expect(indexPaused(ctx.db, p)).toBe(true);
  // And the pass is not entered — the flag gating only the warning is the bug.
  expect(indexTargets(ctx.db).map((t) => t.id)).toEqual([]);

  // Signing a runtime in moves the stamp, so it is worth one more attempt — and
  // a failure after that is news rather than a repeat, so it is said again.
  ctx.db.run("INSERT INTO runtime_auth (runtime, mode, secret, updated_at) VALUES (?, ?, ?, ?)", [
    "codex",
    "api_key",
    "s",
    Date.now(),
  ]);
  expect(indexPaused(ctx.db, p)).toBe(false);

  recordIndexResult(ctx, p, "sha-2", { calls: 12, failed: 12, files: 30 });
  expect(indexPaused(ctx.db, p)).toBe(true);
  expect(ctx.db.query<{ c: number }, []>("SELECT count(*) AS c FROM event WHERE severity = 'blocker'").get()!.c).toBe(
    2,
  );

  // A pass that worked clears it outright.
  recordIndexResult(ctx, p, "sha-3", { calls: 4, failed: 0, files: 9 });
  expect(indexPaused(ctx.db, p)).toBe(false);
});

/**
 * A pass that *threw* is not a pass whose calls failed.
 *
 * `recordIndexResult` arms the credential pause, and a throw never reaches it — the
 * catch is at the tick, above everything. So this path retried every thirty seconds
 * forever, paying for a checkout and a `treeHeads` each time, and emitted a fresh
 * event on every one because `bus.emit` has no dedup.
 */
/**
 * A throw is not a credential problem, so it does not wait on a credential: it backs
 * off, and says the reason once per distinct reason.
 */
test("an index pass that throws backs off and says the reason once", () => {
  const ctx = testContext();
  const p = project(ctx.db);
  ctx.db.run("UPDATE project SET remote = ? WHERE id = ?", ["git@example.com:o/r.git", p]);
  const t0 = 1_000_000;
  expect(indexTargets(ctx.db, t0).map((t) => t.id)).toEqual([p]);

  indexThrew(ctx, new Error("socket closed"), t0);
  expect(indexTargets(ctx.db, t0 + 1_000)).toEqual([]);
  // Still inside the window at the last moment before it lapses.
  expect(indexTargets(ctx.db, t0 + INDEX_THROW_BACKOFF_MS - 1)).toEqual([]);
  expect(indexTargets(ctx.db, t0 + INDEX_THROW_BACKOFF_MS).map((t) => t.id)).toEqual([p]);

  const said = () =>
    ctx.db.query<{ c: number }, []>("SELECT count(*) AS c FROM event WHERE body LIKE '%索引刷新出错%'").get()!.c;
  expect(said()).toBe(1);
  // The same socket failure is one piece of news however often it happens.
  indexThrew(ctx, new Error("socket closed"), t0);
  indexThrew(ctx, new Error("socket closed"), t0);
  expect(said()).toBe(1);
  // A different one is worth saying.
  indexThrew(ctx, new Error("no such container"), t0);
  expect(said()).toBe(2);
});

test("an empty index model turns the tree walk off rather than calling an empty one", () => {
  // The one path told to run before anything else, and its cost was never
  // compared against not having it. Measured on a 500-note corpus: the lexical
  // half answers three questions in 12.6ms and the walk adds two model calls per
  // question for 192 more characters — about 1%, because the budget was already
  // full. So the switch has to exist before the claim can be argued with.
  expect(navigatorEnabled({ model: "gpt-5.6-luna" })).toBe(true);
  // Whitespace is not a model id. It arrives from a yaml and from the settings
  // page, and " " reaching `codex exec -m` is a turn that fails rather than a
  // navigator that is off.
  expect([navigatorEnabled({ model: "" }), navigatorEnabled({ model: "   " })]).toEqual([false, false]);
});

test("a sandbox server nobody can drive raises a question instead of being restarted", () => {
  // Four of the five states are reported and never acted on. `stuck` is the one
  // that matters: a running, undrivable server may be somebody else's, and "we
  // cannot drive it" is not evidence that nobody can — so it reaches the boss
  // rather than being killed by an installation that did not start it.
  const ctx = testContext();
  reportServerState(ctx, { kind: "stuck", pid: "42", why: "handshake refused" });

  const raised = ctx.db
    .query<{ kind: string; severity: string; body: string }, []>("SELECT kind, severity, body FROM event")
    .all();
  expect(raised).toHaveLength(1);
  expect(raised[0]).toMatchObject({ kind: "escalation", severity: "blocker" });
  expect(raised[0]?.body).toContain("handshake refused");
});

test("a server this process already drives is not news", () => {
  // `ours` had no branch at all and fell out of the chain silently. That was the
  // right outcome reached by accident — reconnecting to our own process is not an
  // event — and it stays the outcome now that the branch is written down.
  const ctx = testContext();
  for (const state of [
    { kind: "ours", pid: "1" },
    { kind: "theirs", pid: "2" },
    { kind: "down", why: "no binary" },
  ] as const) {
    reportServerState(ctx, state);
  }
  expect(ctx.db.query<{ c: number }, []>("SELECT count(*) AS c FROM event").get()?.c).toBe(0);
});

test("/metrics is loopback-only, and the rule is not a path prefix", () => {
  // ADR 012 keeps `/metrics` on loopback, and `PrometheusExporter` is deliberately
  // unused because it opens a port on every interface and would walk around this.
  // The refusal is 404, not 403: a scanner learns nothing from "exists, denied".
  const local = () => "127.0.0.1";
  const remote = () => "10.0.0.7";
  expect(routeRequest("/metrics", local)).toBe("app");
  expect(routeRequest("/metrics", remote)).toBe("refuse");
  // A unix socket has no address at all, and that is not a reason to refuse it.
  expect(routeRequest("/metrics", () => undefined)).toBe("app");
});

test("the panel's own paths are served, and everything else falls through to a file", () => {
  expect(routeRequest("/", () => undefined)).toBe("index");
  expect(routeRequest("/api/v1/state", () => undefined)).toBe("app");
  expect(routeRequest("/orch/v1/status", () => undefined)).toBe("app");
  expect(routeRequest("/dist/main.js", () => undefined)).toBe("file");
});
