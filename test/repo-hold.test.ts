import { beforeEach, expect, test } from "bun:test";
import { z } from "zod";
import { openMemory, type DB } from "../src/db.ts";
import { Scheduler, type Job } from "../src/scheduler.ts";
import { saveAuth } from "../src/mech/sandbox/auth.ts";
import { makeGithub, type Fetcher } from "../src/mech/git/github.ts";
import { repoHeld, resetRepoHolds, REPO_HOLD_MS } from "../src/mech/git/repository.ts";
import type { Json } from "../src/contracts/json.ts";

/**
 * The fifth admission gate: GitHub stopped accepting us.
 *
 * The failure this exists for is the one the codebase has already been burned by
 * four times — every group fails at the same moment, each reporting a different
 * error, and retrying is the one thing that cannot help. Everything here is a
 * stubbed `fetch` and an injected gate; nothing touches the network.
 */

function seed(): { db: DB; sched: Scheduler; ran: Job[] } {
  const db = openMemory();
  saveAuth(db, { runtime: "claude", mode: "oauth_token", secret: "sk-ant-oat01-x" });
  saveAuth(db, { runtime: "github", mode: "api_key", secret: "ghp_one" });
  db.run(
    "INSERT INTO project (name, repo_path, remote, created_at) VALUES ('p', '/tmp/p', 'git@github.com:me/x.git', 0)",
  );
  // A second project, on a different repository, whose credential is fine.
  db.run(
    "INSERT INTO project (name, repo_path, remote, created_at) VALUES ('q', '/tmp/q', 'git@github.com:me/y.git', 0)",
  );
  db.run("INSERT INTO grp (project_id, name, status, created_at) VALUES (1, 'g1', 'RUNNING', 0)");
  db.run("INSERT INTO grp (project_id, name, status, created_at) VALUES (2, 'g2', 'RUNNING', 0)");
  for (const g of [1, 2]) {
    db.run(
      "INSERT INTO agent (project_id, grp_id, role, model, runtime, token, created_at) VALUES (?, ?, 'engineer', 'm', 'claude', ?, 0)",
      [g, g, `tok-${g}`],
    );
  }
  const ran: Job[] = [];
  const sched = new Scheduler(db, async (j) => void ran.push(j), {
    maxGroups: 5,
    repoHeld: (projectId) => repoHeld(db, projectId),
  });
  return { db, sched, ran };
}

const answer =
  (status: number, body: Json = {}): Fetcher =>
  async () =>
    new Response(JSON.stringify(body), { status });

const openEscalations = (db: DB) =>
  db
    .query<{ question: string }, []>(
      "SELECT question FROM escalation WHERE answer IS NULL AND chain_state NOT IN ('answered', 'revoked')",
    )
    .all();

beforeEach(resetRepoHolds);

test("a boss-bucket failure holds that project's turns and leaves the other project alone", async () => {
  const h = seed();
  await makeGithub(h.db, answer(401, { message: "Bad credentials" })).request("GET", "/repos/me/x/pulls/7", z.json());

  const held = h.sched.enqueue("agent_turn", { grp_id: 1, agent_id: 1, payload: { role: "engineer" } });
  const fine = h.sched.enqueue("agent_turn", { grp_id: 2, agent_id: 2, payload: { role: "engineer" } });
  h.sched.tick();
  await h.sched.drain().catch(() => {});

  // Held, not failed: no process behind it, so waiting costs nothing.
  const state = (id: number) =>
    h.db.query<{ state: string }, [number]>("SELECT state FROM job WHERE id = ?").get(id)!.state;
  expect(state(held)).toBe("pending");
  expect(h.ran.map((j) => j.id)).toEqual([fine]);
});

test("a 502 does not hold — that is what backoff is for", async () => {
  const h = seed();
  const r = await makeGithub(h.db, answer(502, { message: "bad gateway" })).request(
    "GET",
    "/repos/me/x/pulls/7",
    z.json(),
  );
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.bucket).toBe("transient");

  expect(repoHeld(h.db, 1)).toBe(false);
  // And nobody is told about a blip.
  expect(openEscalations(h.db)).toHaveLength(0);
});

test("a secondary rate limit is a 403 that must not hold either", async () => {
  const h = seed();
  await makeGithub(h.db, answer(403, { message: "You have exceeded a secondary rate limit" })).request(
    "GET",
    "/repos/me/x/pulls/7",
    z.json(),
  );
  expect(repoHeld(h.db, 1)).toBe(false);
});

test("the next success clears the hold, with nobody clicking anything", async () => {
  const h = seed();
  await makeGithub(h.db, answer(404, { message: "Not Found" })).request("GET", "/repos/me/x/pulls/7", z.json());
  expect(repoHeld(h.db, 1)).toBe(true);
  expect(openEscalations(h.db)).toHaveLength(1);

  await makeGithub(h.db, answer(200, { number: 7 })).request("GET", "/repos/me/x/pulls/7", z.json());
  expect(repoHeld(h.db, 1)).toBe(false);
  // And the question goes with it: a boss who reconnects GitHub and watches the
  // fleet resume should not also have to dismiss a 待办 item about it.
  expect(openEscalations(h.db)).toHaveLength(0);
});

test("the hold ends on its own, so nothing can be held forever", async () => {
  // A held project makes no turns, so a held project makes no GitHub calls —
  // without a clock this deadlocks on itself, which is the failure the gate
  // exists to prevent rather than one to introduce.
  const h = seed();
  await makeGithub(h.db, answer(401, { message: "Bad credentials" })).request("GET", "/repos/me/x/pulls/7", z.json());
  expect(repoHeld(h.db, 1)).toBe(true);
  expect(repoHeld(h.db, 1, Date.now() + REPO_HOLD_MS + 1)).toBe(false);
});

test("one escalation for the project, however many groups run into it", async () => {
  const h = seed();
  // Five groups' worth of calls, which is exactly the shape of the incident:
  // everything fails at the same moment and each one reports it separately.
  const gh = makeGithub(h.db, answer(401, { message: "Bad credentials" }));
  for (let i = 0; i < 5; i++) await gh.request("GET", `/repos/me/x/pulls/${i}`, z.json());

  const open = openEscalations(h.db);
  expect(open).toHaveLength(1);
  // The message the boss reads keeps the honest one and does not gain a guess.
  expect(open[0]!.question).toContain("me/x");
  expect(open[0]!.question.toLowerCase()).not.toContain("deleted");
  expect(open[0]!.question.toLowerCase()).not.toContain("expired");

  // A second project failing is its own news, not a duplicate of this one.
  await makeGithub(h.db, answer(401, { message: "Bad credentials" })).request("GET", "/repos/me/y/pulls/1", z.json());
  expect(openEscalations(h.db)).toHaveLength(2);
});

test("a project that recovers and breaks again can warn a second time", async () => {
  // The dedup is an open escalation, and `clearEscalation` revokes rather than
  // answers — so a query that only looked at `answer IS NULL` would silence
  // every warning after the first for the rest of the process's life.
  const h = seed();
  const bad = makeGithub(h.db, answer(401, { message: "Bad credentials" }));
  await bad.request("GET", "/repos/me/x/pulls/7", z.json());
  await makeGithub(h.db, answer(200, { number: 7 })).request("GET", "/repos/me/x/pulls/7", z.json());
  expect(openEscalations(h.db)).toHaveLength(0);

  await bad.request("GET", "/repos/me/x/pulls/7", z.json());
  expect(openEscalations(h.db)).toHaveLength(1);
  expect(repoHeld(h.db, 1)).toBe(true);
});

test("recovery clears only the literal repository prefix", async () => {
  const h = seed();
  const bad = makeGithub(h.db, answer(401, { message: "Bad credentials" }));
  await bad.request("GET", "/repos/me/a_b/pulls/7", z.json());
  await bad.request("GET", "/repos/me/axb/pulls/7", z.json());
  expect(openEscalations(h.db)).toHaveLength(2);

  await makeGithub(h.db, answer(200, { number: 7 })).request("GET", "/repos/me/a_b/pulls/7", z.json());
  expect(openEscalations(h.db).map((row) => row.question)).toEqual([expect.stringContaining("GitHub me/axb:")]);
});

test("the escalation reaches the boss without waiting for an agent to pass it up", async () => {
  // No agent can answer "the login stopped working", and this one belongs to a
  // project rather than a group — so there is no PM to route it through.
  const h = seed();
  await makeGithub(h.db, answer(401, { message: "Bad credentials" })).request("GET", "/repos/me/x/pulls/7", z.json());
  const e = h.db
    .query<{ chain_state: string; severity: string; grp_id: number | null }, []>(
      "SELECT chain_state, severity, grp_id FROM escalation",
    )
    .get()!;
  expect(e.chain_state).toBe("boss");
  expect(e.severity).toBe("blocker");
  expect(e.grp_id).toBeNull();
});

test("a lease is not held: a gate runs in the group's own container", async () => {
  const h = seed();
  await makeGithub(h.db, answer(401, { message: "Bad credentials" })).request("GET", "/repos/me/x/pulls/7", z.json());
  const id = h.sched.enqueue("lease", { grp_id: 1, payload: {} });
  h.sched.tick();
  await h.sched.drain().catch(() => {});
  expect(h.ran.map((j) => j.id)).toEqual([id]);
});

test("a project with no GitHub remote is never held", async () => {
  // Nothing to look up, and defaulting to held would stop a project over a
  // credential it does not use.
  const h = seed();
  h.db.run("UPDATE project SET remote = NULL WHERE id = 1");
  expect(repoHeld(h.db, 1)).toBe(false);
});
