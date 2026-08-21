import { transaction } from "../../platform/persistence/database.ts";
import { eq } from "drizzle-orm";
import { LeaseArgsSchema, loadResource, resolveLease } from "../../mech/lease.ts";
import { z } from "zod";
import { IdParams } from "../../contracts/fields.ts";
import type { AgentHandler } from "../../http/handler.ts";
import { badText, message } from "../../http/respond.ts";
import { agent, lease as leases, nowMs } from "../../platform/persistence/schema.ts";

/**
 * The one way an agent runs something it did not write.
 *
 * Never a free command: the resource is a template out of the `resource` table
 * and the agent picks a name plus arguments that pass that template's schema.
 * That check is the whole boundary — `orch` is the only interface a sandbox
 * has, so what it refuses is what cannot happen.
 */

/**
 * A resource name and its arguments. Never a command.
 *
 * The HTTP boundary accepts only values any resource can consume. The selected
 * resource's own `argSchema` then applies the exact enum/path/range rules.
 */
export const LeaseBody = z.object({
  resource: z.string().min(1).max(64),
  args: LeaseArgsSchema.default({}),
});
export const LeaseLogQuery = z.object({ grep: z.string().max(4000).optional() });

export const postLease = (async (ctx, _req, a, _p, b) => {
  const def = await loadResource(ctx.db, b.resource);
  if (!def) return badText(`unknown resource ${b.resource}. Ask the boss to add a template.`);

  const r = resolveLease(def, b.args);
  if (!r.ok) return badText(r.error);

  // `transaction()` and not `ctx.db.transaction`: only this one publishes the
  // handle that `writeHandle` reads, and the `enqueue` below is what makes the
  // lease and its follow-up turn the single unit hard constraint 8 requires.
  const row = await transaction(ctx.db, async (tx) => {
    const [lease] = await tx
      .insert(leases)
      .values({
        resource: b.resource,
        grp_id: a.grp_id,
        agent_id: a.id,
        args_json: b.args,
        resolved_cmd: r.argv.join(" "),
        // `nowMs`, not `Date.now()`: the clock stays the database's. Every other
        // queue row is stamped by it, and this one would otherwise be ordered
        // against a different clock the moment the host's drifts.
        enqueued_at: nowMs,
      })
      .returning({ id: leases.id });

    await tx.update(agent).set({ state: "waiting_lease" }).where(eq(agent.id, a.id));
    await ctx.sched.enqueue("lease", { grp_id: a.grp_id, agent_id: a.id, payload: { lease_id: lease!.id } });
    return lease!;
  });
  await ctx.sched.tick();
  return message(`lease #${row.id} queued. End this turn; its durable result will wake you in a new turn.`);
}) satisfies AgentHandler<z.infer<typeof LeaseBody>>;

export const getLeaseLog = (async (ctx, _req, a, params, { grep }) => {
  // Whose lease this is. Unchecked, any sandbox could read any group's build log
  // by counting up from 1 — the `/orch/v1/` prefix gate on the mailbox is about
  // which routes are reachable, not about who is reaching them.
  const [row] = await ctx.db
    .select({ log_path: leases.log_path, grp_id: leases.grp_id })
    .from(leases)
    .where(eq(leases.id, params.id));
  if (!row?.log_path) return message("no log", 404);
  if (row.grp_id !== a.grp_id) return message("not this group's lease", 403);
  const raw = await Bun.file(row.log_path).text();
  // A substring, not a regex. `new RegExp` on an agent-supplied string runs on the
  // host, in the single process everything else is waiting on, and one nested
  // quantifier stalls the whole orchestrator. Nobody greps a build log for
  // anything a substring cannot find.
  if (!grep) return message(raw.split("\n").slice(-200).join("\n"));
  return message(
    raw
      .split("\n")
      .filter((l) => l.includes(grep))
      .slice(0, 200)
      .join("\n"),
  );
}) satisfies AgentHandler<z.infer<typeof LeaseLogQuery>, z.infer<typeof IdParams>>;
