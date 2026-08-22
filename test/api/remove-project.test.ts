import { expect, test } from "bun:test";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { DB } from "../../src/platform/persistence/database.ts";
import { makeApp } from "../../src/composition/api.ts";
import type { Ctx } from "../../src/mech/ctx.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";
import { seedAuth } from "../support/seed-auth.ts";
import type { Scope } from "../../src/mech/sandbox/sandbox.ts";
import { loadConfig } from "../../src/platform/config/load.ts";
import {
  agent,
  channel,
  cursor,
  escalation,
  event,
  grp,
  job,
  member,
  note,
  project,
  slice,
  task,
} from "../../src/platform/persistence/schema.ts";
import * as fx from "../support/factories.ts";
import { z } from "zod";
import { tempDir } from "../support/temp.ts";
import { testContext } from "../support/test-context.ts";

/**
 * Removing a project is the one place this codebase deletes rather than
 * archives, so what it reaches has to be checked rather than assumed: a
 * leftover row or a leftover container is invisible until it costs something.
 */
async function harness(dataDir?: string) {
  const killed: Scope[] = [];
  /** What the row situation was at the moment each container was killed. */
  const rowsWhenKilled: number[] = [];
  const asked: string[] = [];
  const base = fakeSandbox();
  const ctx = await testContext({
    sandbox: {
      ...base,
      kill: async (c: Ctx, scope: Scope) => {
        killed.push(scope);
        rowsWhenKilled.push((await c.db.select({ id: project.id }).from(project)).length);
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
  });
  const db = ctx.db;
  await seedAuth(db);

  const f = fx.on(db);
  for (const name of ["doomed", "keeper"]) {
    await f.project.create({
      name,
      repo_path: `acme/${name}`,
      remote: `https://github.com/acme/${name}.git`,
    });
  }
  return { db, ctx, app: makeApp(ctx), killed, rowsWhenKilled, asked, commands: base.commands, f };
}

type Harness = Awaited<ReturnType<typeof harness>>;

/** A project with one of everything hanging off it. */
async function populate(h: Harness, projectId: number, tag: string): Promise<number> {
  const f = h.f;
  const grpId = (await f.runningGrp.create({ project_id: projectId, name: `g-${tag}`, sandbox_id: `sb-${tag}` })).id;
  const sliceId = (await f.slice.create({ grp_id: grpId, seq: 1, title: "s", accept_spec: "a" })).id;
  const agentId = (
    await f.agent.create({
      project_id: projectId,
      grp_id: grpId,
      model: "sonnet",
      token: `tok-${grpId}`,
    })
  ).id;
  const channelId = (await f.channel.create({ project_id: projectId, grp_id: grpId })).id;
  await f.member.create({ channel_id: channelId, agent_id: agentId });
  await f.cursor.create({ channel_id: channelId, agent_id: agentId, last_seq: 0 });
  await f.task.create({ grp_id: grpId, slice_id: sliceId, title: "t", status: "pending" });
  await f.note.create({ project_id: projectId, grp_id: grpId, slice_id: sliceId });
  await f.event.create({ grp_id: grpId, channel_id: channelId, author: "boss", body: "e" });
  await f.escalation.create({ grp_id: grpId, agent_id: agentId, chain_state: "boss" });
  await f.job.create({ state: "pending", grp_id: grpId, slice_id: sliceId, agent_id: agentId, priority: 5 });
  await f.job.create({ state: "running", grp_id: grpId, priority: 5 });
  return grpId;
}

const del = (app: (r: Request) => Promise<Response>, path: string) =>
  app(
    new Request(`http://x${path}`, {
      method: "DELETE",
      headers: { "idempotency-key": crypto.randomUUID() },
    }),
  );

/** Every table that hangs off a group, counted in one object so a diff names the table. */
const underGroup = async (db: DB, id: number) => ({
  grp: (await db.select({ x: grp.id }).from(grp).where(eq(grp.id, id))).length,
  slice: (await db.select({ x: slice.id }).from(slice).where(eq(slice.grp_id, id))).length,
  task: (await db.select({ x: task.id }).from(task).where(eq(task.grp_id, id))).length,
  agent: (await db.select({ x: agent.id }).from(agent).where(eq(agent.grp_id, id))).length,
  channel: (await db.select({ x: channel.id }).from(channel).where(eq(channel.grp_id, id))).length,
  note: (await db.select({ x: note.id }).from(note).where(eq(note.grp_id, id))).length,
  event: (await db.select({ x: event.seq }).from(event).where(eq(event.grp_id, id))).length,
  escalation: (await db.select({ x: escalation.id }).from(escalation).where(eq(escalation.grp_id, id))).length,
  job: (await db.select({ x: job.id }).from(job).where(eq(job.grp_id, id))).length,
});

const projects = async (db: DB, id?: number) =>
  (
    await (id === undefined
      ? db.select({ x: project.id }).from(project)
      : db.select({ x: project.id }).from(project).where(eq(project.id, id)))
  ).length;

test("a removed project takes its groups, slices and events with it — and leaves its neighbour alone", async () => {
  const h = await harness();
  const doomed = await populate(h, 1, "doomed");
  const keeper = await populate(h, 2, "keeper");

  const r = await del(h.app, "/api/v1/projects/1");
  expect(r.status).toBe(200);

  // Every table that hangs off a project or a group. Nothing declares ON DELETE
  // CASCADE, so each of these is a statement that had to be written and ordered.
  expect(await projects(h.db, 1)).toBe(0);
  expect(await underGroup(h.db, doomed)).toEqual({
    grp: 0,
    slice: 0,
    task: 0,
    agent: 0,
    channel: 0,
    note: 0,
    event: 0,
    escalation: 0,
    job: 0,
  });
  expect(await h.db.select({ x: member.agent_id }).from(member)).toHaveLength(1);
  expect(await h.db.select({ x: cursor.agent_id }).from(cursor)).toHaveLength(1);

  // The other project is untouched — every statement is scoped by project id,
  // and a removal that took a neighbour's rows would be unrecoverable.
  expect(await projects(h.db, 2)).toBe(1);
  const kept = await underGroup(h.db, keeper);
  expect({ grp: kept.grp, slice: kept.slice, event: kept.event }).toEqual({ grp: 1, slice: 1, event: 1 });

  // Removing something that is already gone is a 404, not a second removal.
  expect((await del(h.app, "/api/v1/projects/1")).status).toBe(404);
});

test("containers are killed before the rows that name them", async () => {
  // Backwards, the sandbox id is deleted first and the container lives until its
  // TTL with nobody able to name it. `rowsWhenKilled` is how that is asserted
  // without reaching into the driver: the project row still existed each time.
  const h = await harness();
  await populate(h, 1, "doomed");
  await populate(h, 1, "second");

  await del(h.app, "/api/v1/projects/1");

  const grps = h.killed.filter((s): s is { grp: number } => "grp" in s).map((s) => s.grp);
  expect(grps).toHaveLength(2);
  expect(h.killed.some((s) => "project" in s)).toBe(true);
  expect(h.rowsWhenKilled.filter((n) => n !== 2)).toEqual([]);
  expect(await projects(h.db)).toBe(1);

  // And the bare mirror the utility container keeps for this project's branches:
  // the one leftover that no row points at, so nothing would ever find it again.
  expect(h.commands.some((c) => c.startsWith("rm -rf '/repos/"))).toBe(true);
});

test("nothing in the removal path writes to GitHub", async () => {
  // The constraint that is not negotiable: removing a project removes our copy.
  // A boss whose branches vanished from GitHub was robbed by a cleanup button,
  // so this asserts no request at all — not merely no DELETE.
  const h = await harness();
  await populate(h, 1, "doomed");
  await h.db.update(grp).set({ branch: "orch/x", pr_number: 7 }).where(eq(grp.project_id, 1));

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

  const h = await harness(dataDir);
  const grpId = await populate(h, 1, "doomed");
  await h.f.note.create({
    project_id: 1,
    grp_id: grpId,
    body: `看这个\n\nAttachments (paths follow):\n- [图1] ${mine} (image)\n- ${outside}`,
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
  const h = await harness();
  const grpId = await populate(h, 1, "doomed");
  await h.db.update(grp).set({ sandbox_id: "sb-x" }).where(eq(grp.id, grpId));
  await h.db.update(job).set({ state: "running" }).where(eq(job.grp_id, grpId));

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
