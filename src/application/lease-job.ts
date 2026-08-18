import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { jsonOr } from "../contracts/json.ts";
import { requestContext } from "../platform/observability/request-context.ts";
import { sandboxGit } from "../mech/git/checkout.ts";
import { LeaseArgsSchema, loadResource, type ResourceDef, resolveLease, runResource } from "../mech/lease.ts";
import { resourceExec, type Scope, WORK } from "../mech/sandbox/sandbox.ts";
import { errText } from "../platform/process/text.ts";
import type { Job } from "../platform/scheduling/scheduler.ts";
import type { ExecDeps } from "./executor.ts";

/**
 * The lease job, which shares nothing with a turn but the executor's dispatch.
 *
 * Different kind, different lifecycle, different failure model: a turn is an
 * agent thinking and can be cancelled mid-flight, while a lease is one command
 * whose result has to reach a durable row whatever happens to the process. It sat
 * at the bottom of `executor.ts` because that is where the dispatch is, which is
 * not a reason for it to be in the same file.
 *
 * Here rather than `mech/lease.ts`, which the plan named: that module is the
 * resource definition and the command runner, and it lives in `mechanisms` —
 * a zone Fallow forbids from importing `application`, where `ExecDeps` is. The
 * job wrapper belongs on this side of that line; the command it runs does not.
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
    finishLease(deps, leaseId, 126, `the gate could not run: ${errText(e)}`, undefined);
  }
}

async function lease(deps: ExecDeps, job: Job<"lease">, leaseIdIn: number): Promise<void> {
  const { ctx, cfg } = deps;
  const leaseId = leaseIdIn;
  const lease = ctx.db
    .query<{ id: number; resource: string; args_json: string; grp_id: number | null }, [number]>(
      "SELECT id, resource, args_json, grp_id FROM lease WHERE id = ?",
    )
    .get(leaseId);
  if (!lease) return;

  const def = loadResource(ctx.db, lease.resource);
  if (!def) return finishLease(deps, leaseId, 127, "unknown resource", undefined);

  // Re-validate at execution time. The queued args were checked on the way in,
  // but the resource template may have changed since.
  const args = jsonOr(lease.args_json, LeaseArgsSchema.nullable(), null);
  if (!args) {
    return finishLease(
      deps,
      leaseId,
      126,
      "lease arguments must be a flat JSON object of string, number, or boolean values",
      undefined,
    );
  }
  const resolved = resolveLease(def, args);
  if (!resolved.ok) return finishLease(deps, leaseId, 126, resolved.error, undefined);

  const cwd = leaseCwd(def);
  const logDir = join(cfg.dataDir, "leases");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${leaseId}.log`);

  // Stamp the commit this ran against: two failures at the same sha mean the
  // environment is the variable, not the code.
  const scope: Scope = lease.grp_id ? { grp: lease.grp_id } : { project: 0 };
  const head = await sandboxGit(ctx, scope)(["rev-parse", "HEAD"], cwd);
  ctx.db.run("UPDATE lease SET state = 'running', head_sha = ?, started_at = unixepoch() * 1000 WHERE id = ?", [
    head.code === 0 ? head.out.trim() : null,
    leaseId,
  ]);
  ctx.bus.emit({
    grpId: lease.grp_id,
    author: "runner",
    kind: "tool_summary",
    body: `lease ${lease.resource} #${leaseId} started`,
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
  if (!("digest" in out)) return finishLease(deps, leaseId, 126, out.error, logPath);
  finishLease(deps, leaseId, out.exitCode, out.digest.text, logPath);
}

function finishLease(deps: ExecDeps, leaseId: number, code: number, digest: string, logPath: string | undefined): void {
  const { ctx } = deps;
  ctx.db.transaction(() => {
    const lease = ctx.db
      .query<{ grp_id: number | null; agent_id: number | null }, [number]>(
        "SELECT grp_id, agent_id FROM lease WHERE id = ?",
      )
      .get(leaseId);
    if (!lease) return;
    const finished = ctx.db.run(
      `UPDATE lease SET state = ?, exit_code = ?, result_digest = ?, log_path = ?,
       ended_at = unixepoch() * 1000 WHERE id = ? AND state IN ('queued', 'running')`,
      [code === 0 ? "done" : "failed", code, digest, logPath ?? null, leaseId],
    );
    if (finished.changes === 0) return;
    ctx.bus.emit({
      grpId: lease.grp_id,
      author: "runner",
      kind: "lease_result",
      body: `lease #${leaseId} exit ${code}`,
      meta: { lease_id: leaseId, exit_code: code },
    });
    if (lease.agent_id) {
      ctx.db.run("UPDATE agent SET state = 'idle' WHERE id = ? AND state = 'waiting_lease'", [lease.agent_id]);
      ctx.sched.enqueue("agent_turn", {
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
  })();
  ctx.sched.tick();
}

function leaseCwd(def: ResourceDef): string {
  return def.cwd ?? WORK;
}
