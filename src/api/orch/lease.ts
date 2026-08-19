import { eq, sql } from "drizzle-orm";
import { LeaseArgsSchema, loadResource, resolveLease } from "../../mech/lease.ts";
import { z } from "zod";
import { IdParams } from "../../contracts/fields.ts";
import type { AgentHandler } from "../../http/handler.ts";
import { bad, message } from "../../http/respond.ts";
import { orm } from "../../platform/persistence/orm.ts";
import { agent, lease as leases } from "../../platform/persistence/schema.ts";

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
  const def = loadResource(ctx.db, b.resource);
  if (!def) return bad(`unknown resource ${b.resource}. Ask the boss to add a template.`);

  const r = resolveLease(def, b.args);
  if (!r.ok) return bad(r.error);

  const row = ctx.db.transaction(() => {
    const lease = orm(ctx.db)
      .insert(leases)
      .values({
        resource: b.resource,
        grp_id: a.grp_id,
        agent_id: a.id,
        args_json: JSON.stringify(b.args),
        resolved_cmd: r.argv.join(" "),
        // Raw: the clock stays SQLite's. `unixepoch()` truncates to the second,
        // and `Date.now()` here would silently start stamping milliseconds.
        enqueued_at: sql`unixepoch() * 1000`,
      })
      .returning({ id: leases.id })
      .get();

    orm(ctx.db).update(agent).set({ state: "waiting_lease" }).where(eq(agent.id, a.id)).run();
    ctx.sched.enqueue("lease", { grp_id: a.grp_id, agent_id: a.id, payload: { lease_id: lease.id } });
    return lease;
  })();
  ctx.sched.tick();
  return message(`lease #${row.id} queued. End this turn; its durable result will wake you in a new turn.`);
}) satisfies AgentHandler<z.infer<typeof LeaseBody>>;

export const getLeaseLog = (async (ctx, _req, a, params, { grep }) => {
  // Whose lease this is. Unchecked, any sandbox could read any group's build log
  // by counting up from 1 — the `/orch/v1/` prefix gate on the mailbox is about
  // which routes are reachable, not about who is reaching them.
  const row = ctx.db
    .query<{ log_path: string | null; grp_id: number | null }, [number]>(
      "SELECT log_path, grp_id FROM lease WHERE id = ?",
    )
    .get(params.id);
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
