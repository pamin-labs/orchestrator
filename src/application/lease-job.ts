import { msg } from "@lingui/core/macro";
import { transaction } from "../platform/persistence/database.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { valueOr } from "../contracts/json.ts";
import { requestContext } from "../platform/observability/request-context.ts";
import { sandboxGit } from "../mech/git/checkout.ts";
import { LeaseArgsSchema, loadResource, type ResourceDef, resolveLease, runResource } from "../mech/lease.ts";
import { resourceExec, type Scope, WORK } from "../mech/sandbox/sandbox.ts";
import { keepQaSteps } from "../mech/flow/qa-suite.ts";
import { errText } from "../platform/process/text.ts";
import { and, eq, inArray } from "drizzle-orm";
import { agent as agents, lease as leases } from "../platform/persistence/schema.ts";
import { ACTIVE_LEASE_STATES } from "../contracts/states.ts";
import type { Job } from "../platform/scheduling/scheduler.ts";
import type { ExecDeps } from "./executor.ts";

/**
 * The lease job, which shares nothing with a turn but the executor's dispatch.
 *
 * Different kind, lifecycle and failure model: a turn is an agent thinking and can
 * be cancelled mid-flight, while a lease is one command whose result has to reach a
 * durable row whatever happens to the process. It sat at the bottom of
 * `executor.ts` because that is where the dispatch is, which is not a reason to
 * share a file.
 */
/**
 * Here rather than `mech/lease.ts`: that module is the resource definition and the
 * command runner, and it lives in a zone Fallow forbids from importing
 * `application`, where `ExecDeps` is. The job wrapper belongs on this side of that
 * line; the command it runs does not.
 */

// -------------------------------------------------------------------- leases

/**
 * Lease completion is durable: `finishLease` records the terminal result and
 * queues the requesting agent's follow-up turn. Cancellation stays retryable by
 * leaving the lease non-terminal while the scheduler reclaims its job.
 */
export async function runLease(deps: ExecDeps, job: Job<"lease">): Promise<void> {
  const leaseId = job.payload.lease_id;
  if (!leaseId) throw new Error("lease job requires a positive integer lease_id");
  try {
    await lease(deps, job, leaseId);
  } catch (e) {
    if (requestContext.getStore()?.signal?.aborted) throw e;
    await finishLease(deps, leaseId, 126, `the gate could not run: ${errText(e)}`, undefined);
  }
}

async function lease(deps: ExecDeps, job: Job<"lease">, leaseIdIn: number): Promise<void> {
  const { ctx, cfg } = deps;
  const leaseId = leaseIdIn;
  // Still unfinished, or there is nothing to run. `finishLease` guards its own
  // UPDATE the same way, but that only stops the second *result* being written —
  // the command itself would already have run again, and a gate is not free and
  // not always idempotent. A replayed job after a restart is the ordinary way
  // here, not a contrived one.
  const [lease] = await ctx.db
    .select({ id: leases.id, resource: leases.resource, args_json: leases.args_json, grp_id: leases.grp_id })
    .from(leases)
    .where(and(eq(leases.id, leaseId), inArray(leases.state, [...ACTIVE_LEASE_STATES])));
  if (!lease) return;

  const def = await loadResource(ctx.db, lease.resource);
  if (!def) return await finishLease(deps, leaseId, 127, "unknown resource", undefined);

  // Re-validate at execution time. The queued args were checked on the way in,
  // but the resource template may have changed since.
  const args = valueOr(lease.args_json, LeaseArgsSchema.nullable(), null);
  if (!args) {
    return await finishLease(
      deps,
      leaseId,
      126,
      "lease arguments must be a flat JSON object of string, number, or boolean values",
      undefined,
    );
  }
  const resolved = resolveLease(def, args);
  if (!resolved.ok) return await finishLease(deps, leaseId, 126, resolved.error, undefined);

  const cwd = leaseCwd(def);
  const logDir = join(cfg.dataDir, "leases");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${leaseId}.log`);

  // Stamp the commit this ran against: two failures at the same sha mean the
  // environment is the variable, not the code.
  const scope: Scope = lease.grp_id ? { grp: lease.grp_id } : { project: 0 };
  const head = await sandboxGit(ctx, scope)(["rev-parse", "HEAD"], cwd);
  await ctx.db
    .update(leases)
    .set({ state: "running", head_sha: head.code === 0 ? head.out.trim() : null, started_at: Date.now() })
    .where(eq(leases.id, leaseId));
  await ctx.bus.emit({
    grpId: lease.grp_id,
    author: "runner",
    kind: "tool_summary",
    say: msg`lease ${{ resource: lease.resource }} #${{ id: leaseId }} started`,
  });

  // Same runner as the gates use. This used to spawn its own process, which meant
  // two implementations of "run a resource" and a timeout on only one of them.
  const out = await runResource(def, args, {
    cwd,
    logPath,
    timeoutMs: cfg.leaseTimeoutMs,
    // The group's own sandbox. A lease used to be the one thing that ran on the
    // boss's machine with the boss's permissions; there is no hole now.
    exec: resourceExec(ctx, scope),
  });
  if (!("digest" in out)) return await finishLease(deps, leaseId, 126, out.error, logPath);
  if (out.exitCode === 0) await keepQaSteps(ctx, scope, cwd, lease.resource, args);
  await finishLease(deps, leaseId, out.exitCode, out.digest.text, logPath);
}

/**
 * The state guard is what makes this the single resolver: a second finish for the
 * same lease matches no row, so no waiter is resolved twice.
 *
 * The event and the wake used to sit outside the transaction, because the bus
 * wrote on another connection and this would have held the lease row across that
 * round trip. `Bus.emit` joins the open transaction now, and without it a failed
 * wake leaves the result fanned and the agent idle with nothing to start it.
 */
async function finishLease(
  deps: ExecDeps,
  leaseId: number,
  code: number,
  digest: string,
  logPath: string | undefined,
): Promise<void> {
  const { ctx } = deps;
  await transaction(ctx.db, async (tx) => {
    const [lease] = await tx
      .update(leases)
      .set({
        state: code === 0 ? "done" : "failed",
        exit_code: code,
        result_digest: digest,
        log_path: logPath ?? null,
        ended_at: Date.now(),
      })
      .where(and(eq(leases.id, leaseId), inArray(leases.state, [...ACTIVE_LEASE_STATES])))
      .returning({ grp_id: leases.grp_id, agent_id: leases.agent_id });
    if (!lease) return;
    await ctx.bus.emit({
      grpId: lease.grp_id,
      author: "runner",
      kind: "lease_result",
      say: msg`lease #${{ id: leaseId }} exit ${{ code }}`,
      meta: { lease_id: leaseId, exit_code: code },
    });
    if (lease.agent_id) {
      await tx
        .update(agents)
        .set({ state: "idle" })
        .where(and(eq(agents.id, lease.agent_id), eq(agents.state, "waiting_lease")));
      await ctx.sched.enqueue("agent_turn", {
        grp_id: lease.grp_id,
        agent_id: lease.agent_id,
        priority: 5,
        payload: {
          mail: {
            from: "runner",
            from_group: lease.grp_id,
            intent: "inform",
            body: `lease #${leaseId} finished:\n${digest}`,
          },
        },
      });
    }
  });
  await ctx.sched.tick();
}

function leaseCwd(def: ResourceDef): string {
  return def.cwd ?? WORK;
}
