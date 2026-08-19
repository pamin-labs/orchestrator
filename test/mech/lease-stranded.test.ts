import { expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { Bus } from "../../src/platform/persistence/event-bus.ts";
import { agent as agentTable, job, lease as leaseTable } from "../../src/platform/persistence/schema.ts";
import { loadConfig } from "../../src/platform/config/load.ts";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { AgentTurnPayloadSchema, Scheduler, type Executor } from "../../src/platform/scheduling/scheduler.ts";
import { execIn, REAL, resourceExec, EXEC_UNAVAILABLE } from "../../src/mech/sandbox/sandbox.ts";
import { makeExecutor } from "../../src/application/executor.ts";
import type { Ctx } from "../../src/mech/ctx.ts";
import * as fx from "../support/factories.ts";
import { tempDir } from "../support/temp.ts";

/**
 * A gate whose container cannot be opened must fail, not disappear.
 *
 * A terminal lease durably queues a result turn for its waiting agent. So when
 * `execIn` rejected, `runLease` unwound before finishing, and the agent that asked
 * for the gate waited forever while its `orch` polled a reply nobody would write —
 * with the group reading RUNNING the whole time.
 */
/**
 * Every way in is ordinary: a TTL reap, Docker restarting, the sandbox hold expiring
 * mid-gate. Here it is a server address with nothing behind it, which is the same
 * thing from the caller's side and needs no live server to produce.
 */
async function stranded() {
  const db = await openMemory();
  const f = fx.on(db);
  const base = loadConfig();
  const cfg = {
    ...base,
    dataDir: tempDir("orch-lease-"),
    sandbox: { ...base.sandbox, server: "127.0.0.1:9" },
  };
  let exec: Executor;
  const sched = new Scheduler(db, (j) => exec(j));
  const ctx = {
    db,
    bus: new Bus(db),
    sched,
    // The real driver, pointed at a port with nothing on it: `Sandbox.create`
    // fails, `ensureSandbox` marks the fleet held and rethrows.
    sandbox: REAL,
    waiters: new Map<string, (v: string) => void>(),
    config: cfg,
  } satisfies Ctx;
  exec = makeExecutor({ ctx, cfg, roles: new Map() });
  const p = await f.project.create({ name: "p", repo_path: "o/p" });
  await f.runningGrp.create({ project_id: p.id, name: "g1" });
  await f.resource.create({ name: "test" });
  return { db, ctx, sched, f };
}

test("a container that cannot be opened is an exit code, not a rejection", async () => {
  const { ctx } = await stranded();
  // The contract every caller already relies on: `sandboxGit`, `resourceExec`,
  // and through the first, every helper in worktree.ts. All of them read `.code`
  // and none is inside a try/catch, because a command that fails is a code.
  const r = await execIn(ctx, { grp: 1 }, "true", { timeoutMs: 5000 });
  expect(r.code).toBe(EXEC_UNAVAILABLE);
  expect(r.err).toContain("container unavailable");

  // Same for what a gate runs through.
  const gate = await resourceExec(ctx, { grp: 1 })(["true"], { cwd: "/work", timeoutMs: 5000 });
  expect(gate.code).toBe(EXEC_UNAVAILABLE);
}, 30_000);

test("a lease whose container is gone finishes as failed and releases the agent", async () => {
  // The terminal state this exists to prevent: the lease row stuck at `running`
  // forever with an agent that never receives a durable follow-up.
  const { db, sched, f } = await stranded();
  const agent = await f.agent.create({ project_id: 1, grp_id: 1, state: "waiting_lease" });
  const lease = await f.lease.create({ resource: "test", grp_id: 1, agent_id: agent.id, state: "queued" });

  await sched.enqueue("lease", { grp_id: 1, payload: { lease_id: lease.id } });
  await sched.drain();

  const [row] = await db
    .select({ state: leaseTable.state, exit_code: leaseTable.exit_code })
    .from(leaseTable)
    .where(eq(leaseTable.id, lease.id));
  expect(row!.state).toBe("failed");
  // 126 is "found it, could not run it" — the guard that was written for exactly
  // this and could never fire, because reaching it required a return.
  expect(row!.exit_code).toBe(126);
  const [after] = await db.select({ state: agentTable.state }).from(agentTable).where(eq(agentTable.id, agent.id));
  expect(after!.state).toBe("idle");
  const [wake] = await db
    .select({ state: job.state, payload_json: job.payload_json })
    .from(job)
    .where(and(eq(job.kind, "agent_turn"), eq(job.agent_id, agent.id)))
    .orderBy(desc(job.id))
    .limit(1);
  expect(wake!.state).toBe("pending");
  const mail = AgentTurnPayloadSchema.parse(wake!.payload_json).mail;
  expect(mail).toMatchObject({ from: "runner", from_group: 1, intent: "inform" });
  expect(mail?.body).toContain("container unavailable");
}, 30_000);
