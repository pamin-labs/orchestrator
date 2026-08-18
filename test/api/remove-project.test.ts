import { expect, test } from "bun:test";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../../src/platform/persistence/event-bus.ts";
import { openMemory, type DB } from "../../src/platform/persistence/database.ts";
import { Scheduler } from "../../src/platform/scheduling/scheduler.ts";
import { makeApp } from "../../src/composition/api.ts";
import type { Ctx } from "../../src/mech/ctx.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";
import { seedAuth } from "../support/seed-auth.ts";
import type { Scope } from "../../src/mech/sandbox/sandbox.ts";
import { loadConfig } from "../../src/platform/config/load.ts";
import * as fx from "../support/factories.ts";
import { z } from "zod";
import { tempDir } from "../support/temp.ts";

/**
 * Removing a project is the one place this codebase deletes rather than
 * archives, so what it reaches has to be checked rather than assumed: a
 * leftover row or a leftover container is invisible until it costs something.
 */
function harness(dataDir?: string) {
  const db: DB = openMemory();
  seedAuth(db);
  const killed: Scope[] = [];
  /** What the row situation was at the moment each container was killed. */
  const rowsWhenKilled: number[] = [];
  const asked: string[] = [];
  const base = fakeSandbox();
  const ctx: Ctx = {
    db,
    bus: new Bus(db),
    sched: new Scheduler(db, async () => {}),
    waiters: new Map(),
    sandbox: {
      ...base,
      kill: async (c: Ctx, scope: Scope) => {
        killed.push(scope);
        rowsWhenKilled.push(db.query<{ c: number }, []>("SELECT count(*) AS c FROM project").get()!.c);
        return base.kill(c, scope);
      },
    },
    // Any GitHub call at all is a failure here, so the client records the verb
    // and the path rather than answering.
    gh: {
      remaining: () => null,
      request: async (method, path, schema) => {
        asked.push(`${method} ${path}`);
        return { ok: true as const, status: 200, data: schema.parse({}) };
      },
    },
    config: { ...loadConfig(), ...(dataDir ? { dataDir } : {}) },
  };

  for (const name of ["doomed", "keeper"]) {
    fx.project.insert(db, {
      name,
      repo_path: `acme/${name}`,
      remote: `https://github.com/acme/${name}.git`,
    });
  }
  return { db, ctx, app: makeApp(ctx), killed, rowsWhenKilled, asked, commands: base.commands };
}

/** A project with one of everything hanging off it. */
function populate(db: DB, projectId: number, tag: string): number {
  const grp = fx.runningGrp.insert(db, { project_id: projectId, name: `g-${tag}`, sandbox_id: `sb-${tag}` }).id;
  const slice = fx.slice.insert(db, { grp_id: grp, seq: 1, title: "s", accept_spec: "a" }).id;
  const agent = fx.agent.insert(db, {
    project_id: projectId,
    grp_id: grp,
    model: "sonnet",
    token: `tok-${grp}`,
  }).id;
  const channel = fx.channel.insert(db, { project_id: projectId, grp_id: grp }).id;
  fx.member.insert(db, { channel_id: channel, agent_id: agent });
  fx.cursor.insert(db, { channel_id: channel, agent_id: agent, last_seq: 0 });
  fx.task.insert(db, { grp_id: grp, slice_id: slice, title: "t", status: "pending" });
  fx.note.insert(db, { project_id: projectId, grp_id: grp, slice_id: slice });
  fx.event.insert(db, { grp_id: grp, channel_id: channel, author: "boss", body: "e" });
  fx.escalation.insert(db, { grp_id: grp, agent_id: agent, chain_state: "boss" });
  fx.job.insert(db, { state: "pending", grp_id: grp, slice_id: slice, agent_id: agent, priority: 5 });
  fx.job.insert(db, { state: "running", grp_id: grp, priority: 5 });
  return grp;
}

const del = (app: (r: Request) => Promise<Response>, path: string) =>
  app(
    new Request(`http://x${path}`, {
      method: "DELETE",
      headers: { "idempotency-key": crypto.randomUUID() },
    }),
  );

const count = (db: DB, table: string, where: string, arg: number) =>
  db.query<{ c: number }, [number]>(`SELECT count(*) AS c FROM ${table} WHERE ${where}`).get(arg)!.c;

test("a removed project takes its groups, slices and events with it — and leaves its neighbour alone", async () => {
  const h = harness();
  const doomed = populate(h.db, 1, "doomed");
  const keeper = populate(h.db, 2, "keeper");

  const r = await del(h.app, "/api/v1/projects/1");
  expect(r.status).toBe(200);

  // Every table that hangs off a project or a group. Nothing declares ON DELETE
  // CASCADE, so each of these is a statement that had to be written and ordered.
  expect(count(h.db, "project", "id = ?", 1)).toBe(0);
  for (const [table, where] of [
    ["grp", "id = ?"],
    ["slice", "grp_id = ?"],
    ["task", "grp_id = ?"],
    ["agent", "grp_id = ?"],
    ["channel", "grp_id = ?"],
    ["note", "grp_id = ?"],
    ["event", "grp_id = ?"],
    ["escalation", "grp_id = ?"],
    ["job", "grp_id = ?"],
  ] as const) {
    expect(`${table}: ${count(h.db, table, where, doomed)}`).toBe(`${table}: 0`);
  }
  expect(h.db.query<{ c: number }, []>("SELECT count(*) AS c FROM member").get()!.c).toBe(1);
  expect(h.db.query<{ c: number }, []>("SELECT count(*) AS c FROM cursor").get()!.c).toBe(1);

  // The other project is untouched — every statement is scoped by project id,
  // and a removal that took a neighbour's rows would be unrecoverable.
  expect(count(h.db, "project", "id = ?", 2)).toBe(1);
  expect(count(h.db, "grp", "id = ?", keeper)).toBe(1);
  expect(count(h.db, "slice", "grp_id = ?", keeper)).toBe(1);
  expect(count(h.db, "event", "grp_id = ?", keeper)).toBe(1);

  // Removing something that is already gone is a 404, not a second removal.
  expect((await del(h.app, "/api/v1/projects/1")).status).toBe(404);
});

test("containers are killed before the rows that name them", async () => {
  // Backwards, the sandbox id is deleted first and the container lives until its
  // TTL with nobody able to name it. `rowsWhenKilled` is how that is asserted
  // without reaching into the driver: the project row still existed each time.
  const h = harness();
  populate(h.db, 1, "doomed");
  populate(h.db, 1, "second");

  await del(h.app, "/api/v1/projects/1");

  const grps = h.killed.filter((s): s is { grp: number } => "grp" in s).map((s) => s.grp);
  expect(grps).toHaveLength(2);
  expect(h.killed.some((s) => "project" in s)).toBe(true);
  expect(h.rowsWhenKilled.filter((n) => n !== 2)).toEqual([]);
  expect(h.db.query<{ c: number }, []>("SELECT count(*) AS c FROM project").get()!.c).toBe(1);

  // And the bare mirror the utility container keeps for this project's branches:
  // the one leftover that no row points at, so nothing would ever find it again.
  expect(h.commands.some((c) => c.startsWith("rm -rf '/repos/"))).toBe(true);
});

test("nothing in the removal path writes to GitHub", async () => {
  // The constraint that is not negotiable: removing a project removes our copy.
  // A boss whose branches vanished from GitHub was robbed by a cleanup button,
  // so this asserts no request at all — not merely no DELETE.
  const h = harness();
  populate(h.db, 1, "doomed");
  h.db.run("UPDATE grp SET branch = 'orch/x', pr_number = 7 WHERE project_id = 1");

  await del(h.app, "/api/v1/projects/1");
  expect(h.asked).toEqual([]);
});

test("attachments of the removed project go, and files it never named stay", async () => {
  const dataDir = tempDir("orch-rm-");
  mkdirSync(join(dataDir, "attachments"), { recursive: true });
  const mine = join(dataDir, "attachments", "1-0-shot.png");
  const other = join(dataDir, "attachments", "9-0-somebody-else.png");
  const outside = join(dataDir, "not-an-attachment.txt");
  for (const f of [mine, other, outside]) writeFileSync(f, "x");

  const h = harness(dataDir);
  const grp = populate(h.db, 1, "doomed");
  fx.note.insert(h.db, {
    project_id: 1,
    grp_id: grp,
    body: `看这个\n\n附件（路径如下）：\n- [图1] ${mine} (image)\n- ${outside}`,
  });

  await del(h.app, "/api/v1/projects/1");

  // `outside` is named in the body but sits outside the attachments directory:
  // these strings come out of prose an agent wrote, and this path must never be
  // an `rm -rf` on whatever one of them happens to say. One map, so a failure
  // names the file that went rather than reporting a bare `true`.
  expect({ mine: existsSync(mine), other: existsSync(other), outside: existsSync(outside) }).toEqual({
    mine: false,
    other: true,
    outside: true,
  });
});

test("the restart button gets the two numbers it has to show, and never a guess", async () => {
  // Restarting the sandbox server kills every container and every turn in them,
  // so those two counts are the evidence beside the button (硬约束 5). They come
  // from the database, which is the half that is the same on every machine —
  // whether a server happens to be running here is not.
  const h = harness();
  const grp = populate(h.db, 1, "doomed");
  h.db.run("UPDATE grp SET sandbox_id = 'sb-x' WHERE id = ?", [grp]);
  h.db.run("UPDATE job SET state = 'running' WHERE grp_id = ?", [grp]);

  const b = z
    .object({
      containers: z.number(),
      runningTurns: z.number(),
      restartable: z.boolean(),
      state: z.enum(["ours", "theirs", "stuck", "started", "down"]),
    })
    .parse(await (await h.app(new Request("http://x/api/v1/sandbox-server"))).json());
  expect(b.containers).toBe(1);
  expect(b.runningTurns).toBe(2);
  // `restartable` used to mean "we have seen this process's argv". Seeing a
  // command line is not permission to kill the process: opensandbox-server is
  // machine-wide, it may be the user's own, and restarting it takes down
  // whatever else was using it. It now means "we started this one", which is
  // the only thing that makes it ours to bounce.
  //
  // Nothing was started by this harness, so it is false here regardless of what
  // happens to be running on the machine the tests run on.
  expect(b.restartable).toBe(false);
  // And the state is named, because which of the cases it is decides which
  // control the panel may show at all.
  expect(["ours", "theirs", "stuck", "started", "down"]).toContain(b.state);
});
