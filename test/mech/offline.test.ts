import { expect, test } from "bun:test";
import type { Ctx } from "../../src/mech/ctx.ts";
import { type DB, openMemory } from "../../src/platform/persistence/database.ts";
import { holdForOffline } from "../../src/mech/ops/watchdog.ts";
import { saveAuth } from "../../src/mech/sandbox/auth.ts";
import { isOnline, PROBE_EVERY_MS, probe, resetNet } from "../../src/mech/sandbox/net.ts";
import { ensureSandbox, resetSandboxHold, sandboxHeld } from "../../src/mech/sandbox/sandbox.ts";
import { type Job, resumeReclaimed, Scheduler } from "../../src/platform/scheduling/scheduler.ts";
import * as fx from "../support/factories.ts";
import { testContext } from "../support/test-context.ts";
import { z } from "zod";

/**
 * The host loses its network.
 *
 * Doing nothing is the trap: every turn in flight retries until `turnTimeoutMs`,
 * the watchdog interrupts each group into PAUSED, and PAUSED is a state nothing
 * leaves on its own — the park timer files them away and the boss comes back to a
 * fleet to restart by hand. So the work is put back on the queue, the group's
 * status is left alone, and a global admission gate holds the queue until the
 * probe says the network is back. No new state, nothing to remember.
 */

function seed(): { db: DB; ctx: Ctx; sched: Scheduler; ran: Job[]; online: { v: boolean } } {
  const db = openMemory();
  const p = fx.project.insert(db, { name: "p" });
  const g = fx.runningGrp.insert(db, { project_id: p.id, name: "g1" });
  fx.agent.insert(db, { project_id: p.id, grp_id: g.id, runtime: "claude", token: "tok" });
  saveAuth(db, { runtime: "claude", mode: "oauth_token", secret: "sk-ant-oat01-x" });
  const online = { v: true };
  const ran: Job[] = [];
  const sched = new Scheduler(db, async (j) => void ran.push(j), { online: () => online.v });
  const ctx = testContext({ db, sched });
  return { db, ctx, sched, ran, online };
}

const stateOf = (db: DB, id: number) =>
  db.query<{ state: string }, [number]>("SELECT state FROM job WHERE id = ?").get(id)!.state;

test("offline holds agent turns in the queue instead of dispatching them", async () => {
  const h = seed();
  const id = h.sched.enqueue("agent_turn", { grp_id: 1, agent_id: 1, payload: { role: "engineer" } });

  h.online.v = false;
  h.sched.tick();
  await h.sched.drain().catch(() => {});
  // Held, not failed: a held job has no process behind it, so waiting costs
  // nothing and there is no error for the boss to act on.
  expect(stateOf(h.db, id)).toBe("pending");
  expect(h.ran).toHaveLength(0);
});

test("coming back online drains the queue with no one intervening", async () => {
  const h = seed();
  const id = h.sched.enqueue("agent_turn", { grp_id: 1, agent_id: 1, payload: { role: "engineer" } });
  h.online.v = false;
  h.sched.tick();
  expect(stateOf(h.db, id)).toBe("pending");

  h.online.v = true;
  h.sched.tick();
  await h.sched.drain();
  expect(h.ran.map((j) => j.id)).toEqual([id]);
});

test("a turn in flight is re-queued and its requirement is left running", () => {
  const h = seed();
  const id = h.sched.enqueue("agent_turn", { grp_id: 1, agent_id: 1, payload: { role: "engineer" } });
  h.db.run("UPDATE job SET state = 'running', started_at = 0 WHERE id = ?", [id]);
  h.db.run("UPDATE agent SET state = 'running' WHERE id = 1");

  const requeued = holdForOffline(h.ctx, 1000);
  expect(requeued).toBe(1);
  expect(stateOf(h.db, id)).toBe("cancelled");
  // The group is NOT paused. Pausing is what makes coming back online a manual
  // job: nothing takes a group out of PAUSED, and the park timer would file it
  // away while the network was down.
  expect(h.db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()!.status).toBe("RUNNING");
  // The agent is idle again, or everything downstream skips it forever.
  expect(h.db.query<{ state: string }, []>("SELECT state FROM agent WHERE id = 1").get()!.state).toBe("idle");
  const back = h.db
    .query<{ id: number; state: string }, []>(
      "SELECT id, state FROM job WHERE kind = 'agent_turn' AND state = 'pending'",
    )
    .all();
  expect(back).toHaveLength(1);
});

test("a turn the network killed does not spend its one retry", () => {
  const h = seed();
  // `resumed` normally stops a turn that keeps taking the server down from being
  // resurrected forever. A turn the network killed did nothing wrong, so it is
  // exempt — the same argument as an orphan of a server restart, and without it
  // one bad minute of wifi leaves the group stopped after the network is back.
  const already: Job = {
    id: 1,
    kind: "agent_turn",
    grp_id: 1,
    agent_id: 1,
    slice_id: null,
    payload_json: JSON.stringify({ role: "engineer", resumed: true }),
    payload: { role: "engineer", resumed: true },
    priority: 0,
    state: "cancelled",
    error: "offline: the host lost its network",
  };
  expect(resumeReclaimed(h.sched, [already])).toBe(1);

  // And the exemption is exactly that error, not any cancellation.
  expect(resumeReclaimed(h.sched, [{ ...already, error: "interrupted (keep)" }])).toBe(0);
});

test("a reclaim re-queues lease, gate and reconcile work, never the free kinds", () => {
  // The free kinds re-arm on their own clock; re-queueing one would double every
  // timer the restart already kept. Everything else picks up where it was, with
  // `resumed` stamped — and with its own payload, or a lease would lose its target.
  const h = seed();
  const base = { id: 1, grp_id: 1, agent_id: 1, slice_id: null, priority: 0, state: "cancelled" as const };
  const lease: Job = {
    ...base,
    kind: "lease",
    payload_json: JSON.stringify({ lease_id: 7 }),
    payload: { lease_id: 7 },
  };
  const gate: Job = { ...base, kind: "gate", payload_json: "{}", payload: {} };
  const reconcile: Job = { ...base, kind: "reconcile", payload_json: "{}", payload: {} };
  const watchdog: Job = { ...base, kind: "watchdog", payload_json: "{}", payload: {} };

  expect(resumeReclaimed(h.sched, [lease, gate, reconcile])).toBe(3);
  expect(resumeReclaimed(h.sched, [watchdog])).toBe(0);

  const requeued = h.db
    .query<{ kind: string; payload_json: string }, []>(
      "SELECT kind, payload_json FROM job WHERE state = 'pending' ORDER BY id",
    )
    .all();
  expect(requeued.map((r) => r.kind)).toEqual(["lease", "gate", "reconcile"]);
  const ResumedPayload = z.object({ resumed: z.literal(true), lease_id: z.number().optional() });
  for (const r of requeued) ResumedPayload.parse(JSON.parse(r.payload_json));
  expect(ResumedPayload.parse(JSON.parse(requeued[0]!.payload_json)).lease_id).toBe(7);
});

test("nothing configured yet is not the same as offline", async () => {
  // A fresh install has no credential, so there is no wall to detect. Gating every
  // turn on an empty probe would stop a fleet that has not been set up rather than
  // say so — `credentialMissing` is the gate that covers that case, with a message.
  resetNet();
  const db = openMemory();
  const r = await probe(db, 1, async () => {
    throw new Error("should not be called");
  });
  expect(r.online).toBe(true);
  expect(isOnline()).toBe(true);
});

test("a refused credential is not a network fault", async () => {
  // Any HTTP answer means the host is reachable. Treating a 401 as offline would
  // stop the whole fleet over a bad token — which is `handleAuthFailure`'s job,
  // and it asks the boss instead of silently holding everything.
  resetNet();
  const db = openMemory();
  saveAuth(db, { runtime: "claude", mode: "oauth_token", secret: "sk-ant-oat01-x" });
  const r = await probe(db, 1, async () => new Response("no", { status: 401 }));
  expect(r.online).toBe(true);
  expect(r.changed).toBe(false);

  // Only a transport-level throw is offline. Past the throttle: while things work
  // the probe goes out every five minutes, not on every 30s tick — 288 requests a
  // day rather than 5760, to learn something a failing turn would say anyway.
  const down = await probe(db, 1 + PROBE_EVERY_MS, async () => {
    throw new Error("getaddrinfo ENOTFOUND api.anthropic.com");
  });
  expect(down.online).toBe(false);
  expect(down.changed).toBe(true);
  expect(isOnline()).toBe(false);
  resetNet();
});

test("while things work the probe is throttled, and while they do not it is not", async () => {
  // The first version probed on every watchdog tick: 30s, two providers, 5760
  // unauthenticated requests a day to learn something a failing turn reports
  // anyway. Offline it stays per-tick, because then the only question is whether
  // it is back yet and nothing else on the tick is running.
  resetNet();
  const db = openMemory();
  saveAuth(db, { runtime: "claude", mode: "oauth_token", secret: "sk-ant-oat01-x" });
  let calls = 0;
  const ok = async () => {
    calls++;
    return new Response("", { status: 200 });
  };

  await probe(db, 1_000_000, ok);
  const afterFirst = calls;
  await probe(db, 1_000_000 + 30_000, ok); // next tick
  expect(calls).toBe(afterFirst);
  await probe(db, 1_000_000 + PROBE_EVERY_MS, ok);
  expect(calls).toBeGreaterThan(afterFirst);

  // Now offline: every tick, so coming back is noticed within one.
  await probe(db, 2_000_000, async () => {
    throw new Error("down");
  });
  expect(isOnline()).toBe(false);
  let downCalls = 0;
  await probe(db, 2_000_000 + 30_000, async () => {
    downCalls++;
    throw new Error("still down");
  });
  expect(downCalls).toBe(1);
  resetNet();
});

test("no container to open holds every turn instead of failing each group once", async () => {
  // docker down, or `opensandbox-server` not running, or the key rejected.
  // preflight reports all three — as a console warning — so the fleet still
  // found out the expensive way: every group dispatched, `ensureSandbox` threw,
  // the turn failed, the watchdog requeued it once and then filed a blocker. Ten
  // groups, ten blockers, one fact.
  resetSandboxHold();
  const h = seed();
  const sched = new Scheduler(h.db, async () => {}, { sandboxReady: () => !sandboxHeld() });
  const id = sched.enqueue("agent_turn", { grp_id: 1, agent_id: 1, payload: { role: "engineer" } });

  // Driven through the real `ensureSandbox` rather than by poking the flag: the
  // failure this guards against is the wiring being absent, not the flag being
  // wrong. Port 1 has nothing on it.
  const ctx = testContext({
    ...h.ctx,
    config: {
      ...h.ctx.config,
      sandbox: { ...h.ctx.config.sandbox, server: "127.0.0.1:1", apiKey: "" },
    },
  });
  await ensureSandbox(ctx, { grp: 1 }).catch(() => {});
  expect(sandboxHeld()).toBe(true);

  sched.tick();
  expect(stateOf(h.db, id)).toBe("pending");

  // Said once, not once per attempt — a held job makes no attempt, and the same
  // line every minute is how a feed stops being read.
  await ensureSandbox(ctx, { grp: 1 }).catch(() => {});
  expect(h.db.query<{ n: number }, []>("SELECT count(*) AS n FROM event WHERE kind = 'escalation'").get()!.n).toBe(1);
  resetSandboxHold();
});
