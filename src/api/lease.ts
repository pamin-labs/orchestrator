import { resolveLease, type ResourceDef } from "../mech/lease.ts";
import { z } from "zod";
import { bad, text, type AgentHandler } from "./shared.ts";
import type { Ctx } from "../ctx.ts";

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
 * `args` stays `unknown` per key on purpose: what each one has to be is the
 * resource's own `argSchema`, which the boss wrote in the `resource` table, and
 * `resolveLease` is what enforces it. A shape here could only say "some object",
 * and saying it twice is how the two answers drift.
 */
export const LeaseBody = z.object({
  resource: z.string().min(1).max(64),
  args: z.record(z.string(), z.unknown()).default({}),
});

export const postLease: AgentHandler<z.infer<typeof LeaseBody>> = async (ctx, _req, a, _p, b) => {
  const def = loadResource(ctx, b.resource);
  if (!def) return bad(`unknown resource ${b.resource}. Ask the boss to add a template.`);

  const r = resolveLease(def, b.args);
  if (!r.ok) return bad(r.error);

  const row = ctx.db
    .query<{ id: number }, [string, number | null, number, string, string]>(
      `INSERT INTO lease (resource, grp_id, agent_id, args_json, resolved_cmd, enqueued_at)
       VALUES (?, ?, ?, ?, ?, unixepoch() * 1000) RETURNING id`,
    )
    .get(b.resource, a.grp_id, a.id, JSON.stringify(b.args), r.argv.join(" "))!;

  ctx.db.run("UPDATE agent SET state = 'waiting_lease' WHERE id = ?", [a.id]);
  ctx.sched.enqueue("lease", { grp_id: a.grp_id, agent_id: a.id, payload: { lease_id: row.id } });
  ctx.sched.tick();

  // A deadline, because "the agent waits forever" is the worst state in the
  // system and `finishLease` is not the only way to reach it. Every path through
  // `runLease` resolves this now — but a job that is *cancelled* never reaches
  // `runLease` at all (watchdog rule 9 cancels a dropped group's queue), so the
  // waiter would still be there with nothing left to answer it. This is the
  // backstop for the paths nobody has thought of yet, and it is the difference
  // between one failed gate and an agent that never takes another turn.
  //
  // Longer than the lease's own timeout: a gate that is legitimately slow must
  // finish and answer rather than be cut off by the thing waiting for it.
  const deadline = (ctx.config?.leaseTimeoutMs ?? 10_800_000) + 60_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const digest = await new Promise<string>((resolve) => {
    ctx.waiters.set(`lease:${row.id}`, resolve);
    // `unref`, or this three-hour timer is a reason the process cannot exit —
    // which a test run finds first, and a shutdown finds later.
    timer = setTimeout(
      () => resolve(`lease ${row.id} never reported back within ${Math.round(deadline / 1000)}s — treat it as not run`),
      deadline,
    );
    timer.unref?.();
  });
  clearTimeout(timer);
  ctx.waiters.delete(`lease:${row.id}`);
  ctx.db.run("UPDATE agent SET state = 'idle' WHERE id = ?", [a.id]);
  return text(digest);
};

export const getLeaseLog: AgentHandler = async (ctx, req, a, params) => {
  // Whose lease this is. Unchecked, any sandbox could read any group's build log
  // by counting up from 1 — the `/orch/` prefix gate on the mailbox is about
  // which routes are reachable, not about who is reaching them.
  const row = ctx.db
    .query<{ log_path: string | null; grp_id: number | null }, [number]>(
      "SELECT log_path, grp_id FROM lease WHERE id = ?",
    )
    .get(Number(params.id));
  if (!row?.log_path) return text("no log", 404);
  if (row.grp_id !== a.grp_id) return text("not this group's lease", 403);
  const raw = await Bun.file(row.log_path).text();
  // A substring, not a regex. `new RegExp` on an agent-supplied string runs on the
  // host, in the single process everything else is waiting on, and one nested
  // quantifier stalls the whole orchestrator. Nobody greps a build log for
  // anything a substring cannot find.
  const grep = new URL(req.url).searchParams.get("grep");
  if (!grep) return text(raw.split("\n").slice(-200).join("\n"));
  return text(
    raw
      .split("\n")
      .filter((l) => l.includes(grep))
      .slice(0, 200)
      .join("\n"),
  );
};

function loadResource(ctx: Ctx, name: string): ResourceDef | null {
  const r = ctx.db
    .query<
      {
        name: string; template: string; concurrency: number; arg_schema_json: string;
        error_regex: string | null; cwd: string | null; tags_json: string;
      },
      [string]
    >("SELECT * FROM resource WHERE name = ?")
    .get(name);
  if (!r) return null;
  let tags: string[] = [];
  try {
    tags = JSON.parse(r.tags_json ?? "[]");
  } catch {}
  return {
    name: r.name,
    template: r.template,
    concurrency: r.concurrency,
    argSchema: JSON.parse(r.arg_schema_json),
    errorRegex: r.error_regex ?? undefined,
    cwd: r.cwd ?? undefined,
    tags,
  };
}
