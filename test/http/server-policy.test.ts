import { expect, test } from "bun:test";
import { sayIn } from "../../src/contracts/said.ts";
import { said } from "../support/said.ts";
import {
  applyPrOutcome,
  chargedProject,
  heartbeat,
  recordIndexResult,
  refreshIndex,
  indexStamp,
  indexPaused,
  indexTargets,
  indexThrew,
  INDEX_THROW_BACKOFF_MS,
  navigatorEnabled,
  reportServerState,
  routeRequest,
  reportRejection,
} from "../../src/composition/server.ts";
import { count, desc, eq, like, sql } from "drizzle-orm";
import { type DB, openMemory } from "../../src/platform/persistence/database.ts";
import * as tbl from "../../src/platform/persistence/schema.ts";
import { testContext } from "../support/test-context.ts";
import { makeGithub } from "../../src/mech/git/github.ts";
import { escalationKey } from "../../src/mech/flow/escalate.ts";
import type { Feedback } from "../../src/mech/git/prwatch.ts";
import { Notifier } from "../../src/mech/ops/notify.ts";
import * as fx from "../support/factories.ts";

/**
 * Four decisions the server makes on a timer, none of which used to be reachable
 * without starting one. They were written inside closures and callbacks, so the
 * only way to exercise a branch was to run the process and wait.
 */

async function project(db: DB, name = "p"): Promise<number> {
  return (await fx.on(db).project.create({ name })).id;
}

async function group(db: DB, projectId: number, name = "g"): Promise<number> {
  return (await fx.on(db).grp.create({ project_id: projectId, name })).id;
}

/** A real notifier whose delivery goes nowhere, so nothing here pushes to the boss. */
const silent = new Notifier({ deliver: () => {} });

/** A real client whose transport never answers, so no test can reach GitHub. */
const offlineGithub = (db: DB) => makeGithub(db, () => Promise.reject(new Error("no network in tests")));

/** A promise that stays pending for the whole test. */
const never = () => new Promise<void>(() => {});

const feedback = (over: Partial<Feedback>): Feedback => ({
  grpId: 1,
  prNumber: 7,
  comments: [],
  failingChecks: [],
  ...over,
});

test("an index call is billed to the project, whichever scope asked for it", async () => {
  const db = await openMemory();
  const p = await project(db);
  const g = await group(db, p);

  expect(await chargedProject(db, { project: p })).toBe(p);
  // A group-scoped call bills the group's project, or the most frequent model
  // call in the system is invisible in every cost total.
  expect(await chargedProject(db, { grp: g })).toBe(p);
  // Nothing in the utility container asks a model — it has no agent in it, which
  // is the entire reason it may hold real tokens.
  expect(await chargedProject(db, { util: true })).toBeUndefined();
  expect(await chargedProject(db, { grp: 9999 })).toBeUndefined();
});

test("a merge wins over a close arriving in the same poll", async () => {
  const ctx = await testContext();
  const p = await project(ctx.db);
  const g = await group(ctx.db, p);
  await ctx.db.update(tbl.grp).set({ status: "PR_OPEN" }).where(eq(tbl.grp.id, g));

  // GitHub reports both on a PR that merged and closed between two polls.
  // Reading `closed` first would stop a group whose work is already on main.
  await applyPrOutcome(ctx, feedback({ grpId: g, merged: true, closed: true }), "http://x", silent);

  const state = (await ctx.db.select({ status: tbl.grp.status }).from(tbl.grp).where(eq(tbl.grp.id, g)))[0]?.status;
  expect(state).not.toBe("PR_OPEN");
  const asked = (await ctx.db.select({ c: count() }).from(tbl.escalation))[0]?.c;
  expect(asked).toBe(0);
});

test("a close without a merge stops the group and asks the boss", async () => {
  const ctx = await testContext();
  const p = await project(ctx.db);
  const g = await group(ctx.db, p);
  await ctx.db.update(tbl.grp).set({ status: "PR_OPEN" }).where(eq(tbl.grp.id, g));

  await applyPrOutcome(ctx, feedback({ grpId: g, prNumber: 12, closed: true }), "http://x", silent);

  const [esc] = await ctx.db
    .select({ dedupe_key: tbl.escalation.dedupe_key, chain_state: tbl.escalation.chain_state })
    .from(tbl.escalation);
  expect(esc?.chain_state).toBe("boss");
  // By the key and not by the sentence: two matchers find this row again, and the
  // key is what they compare. Reopening is still something a person does — the
  // close was deliberate, and undoing a deliberate act because a poller disagreed
  // is the worst kind of helpful.
  expect(esc?.dedupe_key).toBe(escalationKey.prClosed(12));
});

test("an index pass only marks the tree fresh when it did work and none of it failed", async () => {
  const ctx = await testContext();
  const p = await project(ctx.db);

  await recordIndexResult(ctx, p, "sha-1", { calls: 3, failed: 0, files: 9 });
  // The counts, not the sentence carrying them: the wording is the catalogue's
  // and the boss reads it in whichever of ten languages the panel is set to.
  const [pass] = await ctx.db.select({ meta: tbl.event.meta_json }).from(tbl.event).orderBy(desc(tbl.event.seq));
  expect(sayIn(pass?.meta)).toMatchObject({
    ...said(
      "PageIndex: summarised {n, plural, one {# node} other {# nodes}}, {files, plural, one {# file} other {# files}} indexed",
    ),
    values: { n: 3, files: 9 },
  });

  // Every call failed: that is the model being down, not the repository being
  // broken, and it is reported once rather than every pass.
  await recordIndexResult(ctx, p, "sha-2", { calls: 2, failed: 2, files: 4 });
  await recordIndexResult(ctx, p, "sha-3", { calls: 2, failed: 2, files: 4 });
  const [blockers] = await ctx.db.select({ c: count() }).from(tbl.event).where(eq(tbl.event.severity, "blocker"));
  expect(blockers?.c).toBe(1);
});

/**
 * The corpus is two halves and the freshness stamp has to cover both.
 *
 * Notes change without a commit, so a stamp keyed on file heads alone lets a pass
 * that came in under budget record itself fresh and then skip every tick until
 * somebody pushes — journals, retros and decisions never reaching the tree. It
 * could not show while every pass spent its whole budget, because the stamp was
 * then never recorded at all; fixing that starvation is what exposed this.
 */
test("a note written since the last pass moves the index stamp", () => {
  const heads = new Map([["src/a.ts", "unchanged"]]);
  const none = { ids: [] as string[], read: () => null, dropped: 0 };
  const one = { ids: ["notes/project/decision/1"], read: () => "we chose Postgres", dropped: 0 };
  const edited = { ids: ["notes/project/decision/1"], read: () => "we chose Postgres, and here is why", dropped: 0 };

  expect(indexStamp(heads, one)).toBe(indexStamp(heads, one));
  // A note that did not exist last pass, and one whose body was rewritten: both
  // are work the tree has not seen, and neither touches a file head.
  expect(indexStamp(heads, none)).not.toBe(indexStamp(heads, one));
  expect(indexStamp(heads, one)).not.toBe(indexStamp(heads, edited));
  // An empty repository still has nothing to stamp: the early return that stops a
  // failed checkout from reading as "nothing changed" is unchanged.
  expect(indexStamp(new Map(), one)).toBe("");

  // And a file the index does not carry moves nothing. The stamp covered every
  // tracked file, so touching a lockfile or a generated bundle woke a pass that
  // loaded the tree, filtered the file out and did nothing.
  const withLock = (blob: string) =>
    indexStamp(
      new Map([
        ["src/a.ts", "unchanged"],
        ["vendor/big.js", blob],
      ]),
      one,
      ["vendor/**"],
    );
  expect(withLock("aaa1")).toBe(withLock("bbb2"));
});

test("a blackboard that outgrew the index is said once, and again only if it recurs", async () => {
  const ctx = await testContext();
  const p = await project(ctx.db);
  const rows = () => ctx.db.select({ c: count() }).from(tbl.event).where(eq(tbl.event.severity, "advisory"));

  await recordIndexResult(ctx, p, "sha-1", { calls: 3, failed: 0, files: 9, dropped: 40 });
  await recordIndexResult(ctx, p, "sha-2", { calls: 3, failed: 0, files: 9, dropped: 41 });
  // Once, not once a tick: this runs every pass and `bus.emit` has no dedup.
  expect((await rows())[0]?.c).toBe(1);

  // The limit was raised, so it stops biting — and would be worth saying again if
  // the blackboard outgrew the new one.
  await recordIndexResult(ctx, p, "sha-3", { calls: 3, failed: 0, files: 9, dropped: 0 });
  await recordIndexResult(ctx, p, "sha-4", { calls: 3, failed: 0, files: 9, dropped: 7 });
  expect((await rows())[0]?.c).toBe(2);
});

test("a pass with no calls says nothing at all", async () => {
  const ctx = await testContext();
  const p = await project(ctx.db);
  const before = (await ctx.db.select({ c: count() }).from(tbl.event))[0]?.c;

  await recordIndexResult(ctx, p, "sha-1", { calls: 0, failed: 0, files: 0 });

  expect((await ctx.db.select({ c: count() }).from(tbl.event))[0]?.c).toBe(before);
});

test("a repeating rejection reaches the feed once, not every tick", async () => {
  const ctx = await testContext();
  const boom = new Error("the same detached chain");

  const first = reportRejection(ctx.bus, boom, "");
  const second = reportRejection(ctx.bus, boom, first);
  expect(second).toBe(first);

  const different = reportRejection(ctx.bus, new Error("a different one"), second);
  expect(different).not.toBe(second);

  // Waited for: `reportRejection` returns the key synchronously and emits behind
  // it, and the emit is a round trip now — so counting straight after was
  // counting whichever writes had happened to land.
  const blockers = async () =>
    (await ctx.db.select({ c: count() }).from(tbl.event).where(eq(tbl.event.severity, "blocker")))[0]?.c ?? 0;
  const deadline = Date.now() + 5_000;
  let feed = await blockers();
  while (feed < 2 && Date.now() < deadline) {
    await Bun.sleep(1);
    feed = await blockers();
  }
  // Two distinct causes, three rejections. Without the check a single recurring
  // bug is a blocker line every thirty seconds and the feed stops being readable.
  expect(feed).toBe(2);
});

test("the heartbeat queues one watchdog, not one per tick", async () => {
  const ctx = await testContext();
  const enqueued: string[] = [];
  const deps = {
    ctx,
    db: ctx.db,
    sched: { enqueue: async (kind: string) => enqueued.push(kind), tick: async () => {} },
    gh: offlineGithub(ctx.db),
    url: "http://x",
    notifier: silent,
    track: <T>(work: Promise<T>) => work,
    // Held so the tick cannot reach the network; the watchdog decision is above it.
    inFlight: { index: never(), poll: never() },
  };

  await heartbeat(deps);
  expect(enqueued).toEqual(["watchdog"]);

  // A second pending watchdog would only re-examine the same groups, and the
  // queue is not where that should pile up.
  await fx.on(ctx.db).job.create({ kind: "watchdog", state: "pending" });
  await heartbeat(deps);
  expect(enqueued).toEqual(["watchdog"]);
});

test("the heartbeat starts no network work while the last round is still out", async () => {
  const ctx = await testContext();
  // Neither promise resolves during the test: that is the point — a tick landing
  // on top of an unfinished one must not start a second index or poll.
  const held = never();
  const inFlight = { index: held, poll: held };

  await heartbeat({
    ctx,
    db: ctx.db,
    sched: { enqueue: async () => 0, tick: async () => {} },
    gh: offlineGithub(ctx.db),
    url: "http://x",
    notifier: silent,
    track: <T>(work: Promise<T>) => work,
    inFlight,
  });

  expect(inFlight.index).toBe(held);
  expect(inFlight.poll).toBe(held);
});

test("a rejection is still reported when the record itself is what failed", async () => {
  const ctx = await testContext();
  // The record is what failed. A closed handle was the shape of that on SQLite;
  // one database serves the whole file, so the table is taken away instead —
  // same write, same failure, and put back before anything else looks.
  await ctx.db.execute(sql`ALTER TABLE event RENAME TO event_gone`);
  try {
    expect(() => reportRejection(ctx.bus, new Error("original"), "")).not.toThrow();
  } finally {
    await ctx.db.execute(sql`ALTER TABLE event_gone RENAME TO event`);
  }
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
test("an index model that answers nothing is not asked again until credentials change", async () => {
  const ctx = await testContext();
  const p = await project(ctx.db);
  // A remote, because a project without one is skipped for a different reason and
  // the assertion below would hold without proving anything.
  await ctx.db.update(tbl.project).set({ remote: "git@example.com:o/r.git" }).where(eq(tbl.project.id, p));
  expect(await indexPaused(ctx.db, p)).toBe(false);
  // Non-empty first, or the assertion below would hold for the wrong reason.
  expect((await indexTargets(ctx.db)).map((t) => t.id)).toEqual([p]);

  await recordIndexResult(ctx, p, "sha-1", { calls: 12, failed: 12, files: 30 });
  expect(await indexPaused(ctx.db, p)).toBe(true);
  // And the pass is not entered — the flag gating only the warning is the bug.
  expect((await indexTargets(ctx.db)).map((t) => t.id)).toEqual([]);

  // Signing a runtime in moves the stamp, so it is worth one more attempt — and
  // a failure after that is news rather than a repeat, so it is said again.
  await fx.on(ctx.db).runtimeAuth.create({ runtime: "codex", mode: "api_key", secret: "s", updated_at: Date.now() });
  expect(await indexPaused(ctx.db, p)).toBe(false);

  await recordIndexResult(ctx, p, "sha-2", { calls: 12, failed: 12, files: 30 });
  expect(await indexPaused(ctx.db, p)).toBe(true);
  // The bodies, not the count. `warnModelDown` dedups on `max(runtime_auth.updated_at)`,
  // so exactly two are expected: one before any credential exists and one after
  // signing this one in. CI once saw three and a bare count could only say "3",
  // which names neither the extra event nor who wrote it.
  const blockers = await ctx.db
    .select({ body: tbl.event.body })
    .from(tbl.event)
    .where(eq(tbl.event.severity, "blocker"));
  // The sentence belongs to the catalogue now, so what is asserted is that both
  // events say the same thing and that it carries the number this test fed in —
  // a copy of the English here would be a second author for it.
  const bodies = blockers.map((b) => b.body);
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toBe(bodies[0]);
  expect(bodies[0]).toContain("12");

  // A pass that worked clears it outright.
  await recordIndexResult(ctx, p, "sha-3", { calls: 4, failed: 0, files: 9 });
  expect(await indexPaused(ctx.db, p)).toBe(false);
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
test("an index pass that throws backs off and says the reason once", async () => {
  const ctx = await testContext();
  const p = await project(ctx.db);
  await ctx.db.update(tbl.project).set({ remote: "git@example.com:o/r.git" }).where(eq(tbl.project.id, p));
  const t0 = 1_000_000;
  expect((await indexTargets(ctx.db, t0)).map((t) => t.id)).toEqual([p]);

  await indexThrew(ctx, new Error("socket closed"), t0);
  expect(await indexTargets(ctx.db, t0 + 1_000)).toEqual([]);
  // Still inside the window at the last moment before it lapses.
  expect(await indexTargets(ctx.db, t0 + INDEX_THROW_BACKOFF_MS - 1)).toEqual([]);
  expect((await indexTargets(ctx.db, t0 + INDEX_THROW_BACKOFF_MS)).map((t) => t.id)).toEqual([p]);

  // Counted by the reason this test threw rather than by the sentence around it:
  // the sentence is the catalogue's, and the reason is the thing the dedupe keys
  // on — so this asks the question the rule is about.
  const saidAbout = async (reason: string) =>
    (
      await ctx.db
        .select({ c: count() })
        .from(tbl.event)
        .where(like(tbl.event.body, `%${reason}%`))
    )[0]?.c;
  expect(await saidAbout("socket closed")).toBe(1);
  // The same socket failure is one piece of news however often it happens.
  await indexThrew(ctx, new Error("socket closed"), t0);
  await indexThrew(ctx, new Error("socket closed"), t0);
  expect(await saidAbout("socket closed")).toBe(1);
  // A different one is worth saying.
  await indexThrew(ctx, new Error("no such container"), t0);
  expect(await saidAbout("no such container")).toBe(1);
});

test("an empty index model turns the tree walk off rather than calling an empty one", async () => {
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

test("a sandbox server nobody can drive raises a question instead of being restarted", async () => {
  // Four of the five states are reported and never acted on. `stuck` is the one
  // that matters: a running, undrivable server may be somebody else's, and "we
  // cannot drive it" is not evidence that nobody can — so it reaches the boss
  // rather than being killed by an installation that did not start it.
  const ctx = await testContext();
  await reportServerState(ctx, { kind: "stuck", pid: "42", why: said("handshake refused") });

  const raised = await ctx.db
    .select({ kind: tbl.event.kind, severity: tbl.event.severity, body: tbl.event.body })
    .from(tbl.event);
  expect(raised).toHaveLength(1);
  expect(raised[0]).toMatchObject({ kind: "escalation", severity: "blocker" });
  expect(raised[0]?.body).toContain("handshake refused");
});

test("a server this process already drives is not news", async () => {
  // `ours` had no branch at all and fell out of the chain silently. That was the
  // right outcome reached by accident — reconnecting to our own process is not an
  // event — and it stays the outcome now that the branch is written down.
  const ctx = await testContext();
  for (const state of [
    { kind: "ours", pid: "1" },
    { kind: "theirs", pid: "2" },
    { kind: "down", why: said("no binary") },
  ] as const) {
    await reportServerState(ctx, state);
  }
  expect((await ctx.db.select({ c: count() }).from(tbl.event))[0]?.c).toBe(0);
});

test("/metrics is loopback-only, and the rule is not a path prefix", async () => {
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

test("the panel's own paths are served, and everything else falls through to a file", async () => {
  expect(routeRequest("/", () => undefined)).toBe("index");
  expect(routeRequest("/api/v1/state", () => undefined)).toBe("app");
  expect(routeRequest("/orch/v1/status", () => undefined)).toBe("app");
  expect(routeRequest("/dist/main.js", () => undefined)).toBe("file");
});

/**
 * The navigator's account is checked once, not discovered twelve times.
 *
 * `modelAsk` runs a CLI inside a container, and a CLI with no credential fails
 * exactly the way a broken one does — non-zero exit, empty answer, counted as
 * `failed`. So an installation that had signed in to Claude while
 * `indexModel.runtime` said `codex` paid twelve container round trips per pass
 * and got the sentence "12 calls returned nothing", which named neither the
 * account nor the fact that nobody had configured it. Observed hourly for a day.
 */
/**
 * Two properties: the pass does not run, and it says so once per state of the
 * credentials rather than once per heartbeat — the tick is every few seconds and
 * `bus.emit` has no dedup of its own.
 */
test("an index pass with no account for its runtime asks nothing and says so once", async () => {
  const ctx = await testContext();
  await project(ctx.db);
  let asked = 0;
  ctx.askIn = () => async () => {
    asked++;
    return "";
  };

  await refreshIndex(ctx);
  await refreshIndex(ctx);

  expect(asked).toBe(0);
  const [blockers] = await ctx.db.select({ c: count() }).from(tbl.event).where(eq(tbl.event.severity, "blocker"));
  expect(blockers?.c).toBe(1);
  const [said_] = await ctx.db.select({ meta: tbl.event.meta_json }).from(tbl.event).orderBy(desc(tbl.event.seq));
  // The account is named. "Check whether the account still works" was the old
  // sentence and it named nothing, on an installation where the answer was that
  // the account had never been configured.
  expect(JSON.stringify(sayIn(said_?.meta))).toContain("codex");
});
