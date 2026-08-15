import { expect, test } from "bun:test";
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/bus.ts";
import { openMemory, type DB } from "../src/db.ts";
import { Scheduler } from "../src/scheduler.ts";
import { RepoLock } from "../src/mech/gitlock.ts";
import { makeApp, type Ctx } from "../src/api.ts";
import { fakeSandbox } from "./fake-sandbox.ts";
import { seedAuth } from "./seed-auth.ts";
import type { Scope } from "../src/mech/sandbox.ts";

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
    gitLock: new RepoLock(),
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
      request: async (method: string, path: string) => {
        asked.push(`${method} ${path}`);
        return { ok: true as const, status: 200, data: {} as any };
      },
    },
    config: { language: "中文", ...(dataDir ? { dataDir } : {}) },
  } as unknown as Ctx;

  db.run(
    `INSERT INTO project (name, repo_path, remote, created_at) VALUES
       ('doomed', 'acme/doomed', 'https://github.com/acme/doomed.git', 0),
       ('keeper', 'acme/keeper', 'https://github.com/acme/keeper.git', 0)`,
  );
  return { db, ctx, app: makeApp(ctx), killed, rowsWhenKilled, asked, commands: base.commands };
}

/** A project with one of everything hanging off it. */
function populate(db: DB, projectId: number, tag: string): number {
  const grp = db
    .query<{ id: number }, [number, string]>(
      "INSERT INTO grp (project_id, name, status, created_at) VALUES (?, ?, 'RUNNING', 0) RETURNING id",
    )
    .get(projectId, `g-${tag}`)!.id;
  db.run("UPDATE grp SET sandbox_id = ? WHERE id = ?", [`sb-${tag}`, grp]);
  const slice = db
    .query<{ id: number }, [number]>(
      "INSERT INTO slice (grp_id, seq, title, accept_spec, created_at) VALUES (?, 1, 's', 'a', 0) RETURNING id",
    )
    .get(grp)!.id;
  const agent = db
    .query<{ id: number }, [number, number]>(
      `INSERT INTO agent (project_id, grp_id, role, model, token, created_at)
       VALUES (?1, ?2, 'engineer', 'sonnet', 'tok-' || ?2, 0) RETURNING id`,
    )
    .get(projectId, grp)!.id;
  const channel = db
    .query<{ id: number }, [number, number]>(
      "INSERT INTO channel (project_id, grp_id, kind, created_at) VALUES (?, ?, 'group', 0) RETURNING id",
    )
    .get(projectId, grp)!.id;
  db.run("INSERT INTO member (channel_id, agent_id) VALUES (?, ?)", [channel, agent]);
  db.run("INSERT INTO cursor (channel_id, agent_id, last_seq) VALUES (?, ?, 0)", [channel, agent]);
  db.run("INSERT INTO task (grp_id, slice_id, title, status, created_at) VALUES (?, ?, 't', 'open', 0)", [grp, slice]);
  db.run(
    "INSERT INTO note (project_id, grp_id, slice_id, kind, body, at) VALUES (?, ?, ?, 'fact', 'n', 0)",
    [projectId, grp, slice],
  );
  db.run("INSERT INTO event (grp_id, channel_id, author, kind, body, at) VALUES (?, ?, 'boss', 'say', 'e', 0)", [
    grp,
    channel,
  ]);
  db.run(
    "INSERT INTO escalation (grp_id, agent_id, question, chain_state, created_at) VALUES (?, ?, 'q', 'boss', 0)",
    [grp, agent],
  );
  db.run("INSERT INTO job (kind, state, grp_id, slice_id, agent_id, priority, enqueued_at) VALUES ('agent_turn', 'pending', ?, ?, ?, 5, 0)", [grp, slice, agent]);
  db.run("INSERT INTO job (kind, state, grp_id, priority, enqueued_at) VALUES ('agent_turn', 'running', ?, 5, 0)", [grp]);
  return grp;
}

const del = (app: (r: Request) => Promise<Response>, path: string) =>
  app(new Request(`http://x${path}`, { method: "DELETE" }));

const count = (db: DB, table: string, where: string, arg: number) =>
  db.query<{ c: number }, [number]>(`SELECT count(*) AS c FROM ${table} WHERE ${where}`).get(arg)!.c;

test("a removed project takes its groups, slices and events with it — and leaves its neighbour alone", async () => {
  const h = harness();
  const doomed = populate(h.db, 1, "doomed");
  const keeper = populate(h.db, 2, "keeper");

  const r = await del(h.app, "/api/projects/1");
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
  expect((await del(h.app, "/api/projects/1")).status).toBe(404);
});

test("containers are killed before the rows that name them", async () => {
  // Backwards, the sandbox id is deleted first and the container lives until its
  // TTL with nobody able to name it. `rowsWhenKilled` is how that is asserted
  // without reaching into the driver: the project row still existed each time.
  const h = harness();
  populate(h.db, 1, "doomed");
  populate(h.db, 1, "second");

  await del(h.app, "/api/projects/1");

  const grps = h.killed.filter((s): s is { grp: number } => "grp" in s).map((s) => s.grp);
  expect(grps).toHaveLength(2);
  expect(h.killed.some((s) => "project" in s)).toBe(true);
  expect(h.rowsWhenKilled.every((n) => n === 2)).toBe(true);
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

  await del(h.app, "/api/projects/1");
  expect(h.asked).toEqual([]);
});

test("attachments of the removed project go, and files it never named stay", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "orch-rm-"));
  mkdirSync(join(dataDir, "attachments"), { recursive: true });
  const mine = join(dataDir, "attachments", "1-0-shot.png");
  const other = join(dataDir, "attachments", "9-0-somebody-else.png");
  const outside = join(dataDir, "not-an-attachment.txt");
  for (const f of [mine, other, outside]) writeFileSync(f, "x");

  const h = harness(dataDir);
  const grp = populate(h.db, 1, "doomed");
  h.db.run("INSERT INTO note (project_id, grp_id, kind, body, at) VALUES (1, ?, 'fact', ?, 0)", [
    grp,
    `看这个\n\n附件（路径如下）：\n- [图1] ${mine} (image)\n- ${outside}`,
  ]);

  await del(h.app, "/api/projects/1");

  expect(existsSync(mine)).toBe(false);
  expect(existsSync(other)).toBe(true);
  // Named in the body, but outside the attachments directory: these strings come
  // out of prose an agent wrote, and this path must never be an `rm -rf` on
  // whatever one of them happens to say.
  expect(existsSync(outside)).toBe(true);
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

  const b = (await (await h.app(new Request("http://x/api/sandbox-server"))).json()) as any;
  expect(b.containers).toBe(1);
  expect(b.runningTurns).toBe(2);
  // `restartable` is "we have seen this process's argv", never "we hope so": an
  // orchestrator that booted while the server was down has nothing to restart
  // with, and the button is dead rather than optimistic.
  expect(typeof b.restartable).toBe("boolean");
  expect(b.restartable).toBe(b.argv.length > 0);
});
