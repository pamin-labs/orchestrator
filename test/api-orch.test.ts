import { expect, test } from "bun:test";
import { makeApp } from "../src/api.ts";
import type { Ctx } from "../src/mech/ctx.ts";
import type { Json } from "../src/contracts/json.ts";
import { Bus } from "../src/platform/persistence/event-bus.ts";
import { loadConfig } from "../src/platform/config/load.ts";
import { openMemory } from "../src/platform/persistence/database.ts";
import { Scheduler } from "../src/platform/scheduling/scheduler.ts";
import { saveTree, type Tree } from "../src/mech/knowledge/pageindex.ts";
import { fakeSandbox } from "./fake-sandbox.ts";
import { seedAuth } from "./seed-auth.ts";

/**
 * The three agent-facing routes whose whole job is refusing the wrong caller.
 *
 * `pr`, `setup` and `ctx/query` each decide something before they delegate — who
 * may write a PR message, whether an install is worth remembering, whether the
 * page index has anything to say — and none of those decisions was reachable
 * from a test, so a refusal that stopped refusing would have gone unnoticed.
 */

function harness(handle?: (cmd: string, cwd: string) => { code?: number; out?: string; err?: string }) {
  const db = openMemory();
  seedAuth(db);
  const published: number[] = [];
  const ctx: Ctx = {
    db,
    bus: new Bus(db),
    sched: new Scheduler(db, async () => {}),
    sandbox: fakeSandbox(handle),
    waiters: new Map(),
    config: loadConfig(),
    publishBranch: (grpId) => void published.push(grpId),
  };
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', 'o/p', 0)");
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('q', 'o/q', 0)");
  db.run("INSERT INTO grp (project_id, name, status, created_at) VALUES (1, 'g1', 'RUNNING', 0)");
  db.run("INSERT INTO grp (project_id, name, status, created_at) VALUES (2, 'g2', 'RUNNING', 0)");
  for (const [role, token] of [
    ["scribe", "tok-scribe"],
    ["bootstrap", "tok-boot"],
    ["engineer", "tok-eng"],
  ] as const) {
    db.run("INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, 1, ?, 'm', ?, 0)", [
      role,
      token,
    ]);
  }
  const app = makeApp(ctx);
  const post = (path: string, body: Json, token: string) =>
    app(
      new Request(`http://x${path}`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
          "x-orch-token": token,
        },
      }),
    );
  return { db, ctx, app, post, published };
}

const BODY = "The Scribe had no way to say what the branch is. This is that message.";

// ------------------------------------------------------------------ orch/pr

test("only the Scribe writes a pull request message, and only for its own project", async () => {
  const h = harness();
  const send = (token: string, group: Json) =>
    h.post("/orch/v1/pr", { group_id: group, title: "fix(pr): say what landed", body: BODY }, token);

  // The role check is first: publishing is a host `git push`, so a wrong role
  // must not reach the group lookup at all.
  const wrongRole = await send("tok-eng", 1);
  expect(wrongRole.status).toBe(422);
  expect(await wrongRole.text()).toContain("engineer does not write pull request messages");

  const noGroup = await send("tok-scribe", "nobody-by-that-name");
  expect(noGroup.status).toBe(422);
  expect(await noGroup.text()).toContain("which group?");

  const otherProject = await send("tok-scribe", 2);
  expect(otherProject.status).toBe(403);
  expect(await otherProject.text()).toContain("not your project");

  expect(h.published).toEqual([]);
  expect(h.db.query<{ n: number }, []>("SELECT count(*) AS n FROM grp WHERE pr_title IS NOT NULL").get()!.n).toBe(0);
});

test("a message the convention refuses is not stored and publishes nothing", async () => {
  const h = harness();
  const r = await h.post("/orch/v1/pr", { group_id: 1, title: "made some changes", body: BODY }, "tok-scribe");
  expect(r.status).toBe(422);
  expect(await r.text()).toContain("title needs a type prefix");
  expect(h.published).toEqual([]);
  expect(
    h.db.query<{ pr_title: string | null }, []>("SELECT pr_title FROM grp WHERE id = 1").get()!.pr_title,
  ).toBeNull();
});

test("an accepted message is stored, announced, and publishes the branch", async () => {
  const h = harness();
  const r = await h.post(
    "/orch/v1/pr",
    { group_id: "g1", title: "  fix(pr): say what landed  ", body: `  ${BODY}  ` },
    "tok-scribe",
  );
  expect(r.status).toBe(200);

  const g = h.db
    .query<{ pr_title: string; pr_summary: string }, []>("SELECT pr_title, pr_summary FROM grp WHERE id = 1")
    .get()!;
  // Trimmed on the way in: the title is a git subject line and the body is the
  // commit message under it.
  expect(g.pr_title).toBe("fix(pr): say what landed");
  expect(g.pr_summary).toBe(BODY);
  expect(h.published).toEqual([1]);
  const note = h.db
    .query<{ author: string; body: string }, []>("SELECT author, body FROM event WHERE kind = 'note'")
    .get()!;
  expect(note).toEqual({ author: "scribe", body: "fix(pr): say what landed" });
});

// --------------------------------------------------------------- orch/setup

test("only the bootstrap role sets a project up", async () => {
  const h = harness();
  const r = await h.post("/orch/v1/setup", { cmd: "bun install" }, "tok-eng");
  expect(r.status).toBe(422);
  expect(await r.text()).toContain("engineer does not set this project up");
});

test("setup needs a command or an explicit none", async () => {
  const h = harness();
  const r = await h.post("/orch/v1/setup", { cmd: "   " }, "tok-boot");
  expect(r.status).toBe(422);
  expect(await r.text()).toContain("--none");
  // Nothing ran, so nothing was remembered either.
  expect(h.db.query<{ c: string }, []>("SELECT config_json AS c FROM project WHERE id = 1").get()!.c).toBe("{}");
});

test("--none records that the repository needs nothing and says so", async () => {
  const h = harness();
  const r = await h.post("/orch/v1/setup", { none: true }, "tok-boot");
  expect(r.status).toBe(200);
  expect(h.db.query<{ c: string }, []>("SELECT config_json AS c FROM project WHERE id = 1").get()!.c).toBe(
    '{"install":null}',
  );
  const said = h.db
    .query<{ author: string; body: string }, []>("SELECT author, body FROM event WHERE kind = 'state_change'")
    .get()!;
  expect(said.author).toBe("bootstrap");
  expect(said.body).toContain("不需要装");
});

test("a failed install is reported with its tail and is not remembered", async () => {
  const h = harness(() => ({ code: 1, out: "error: no lockfile", err: "exit 1" }));
  const r = await h.post("/orch/v1/setup", { cmd: "bun install --frozen-lockfile" }, "tok-boot");
  expect(r.status).toBe(422);
  const text = await r.text();
  expect(text).toContain("install failed");
  expect(text).toContain("no lockfile");
  // The point of remembering is that the next group does not pay again — a
  // command that did not work is not worth handing on.
  expect(h.db.query<{ c: string }, []>("SELECT config_json AS c FROM project WHERE id = 1").get()!.c).toBe("{}");
});

test("an install that worked is remembered on the project", async () => {
  const h = harness(() => ({ code: 0, out: "done" }));
  const r = await h.post("/orch/v1/setup", { cmd: "bun install" }, "tok-boot");
  expect(r.status).toBe(200);
  expect(h.db.query<{ c: string }, []>("SELECT config_json AS c FROM project WHERE id = 1").get()!.c).toBe(
    '{"install":"bun install"}',
  );
});

// ----------------------------------------------------------- orch/ctx/query

const indexed = (): Tree => ({
  "/": { id: "/", kind: "dir", summary: "", sig: "", children: ["notes/"] },
  "notes/": { id: "notes/", kind: "dir", summary: "the blackboard", sig: "", children: ["notes/grp-1/decision/1"] },
  "notes/grp-1/decision/1": {
    id: "notes/grp-1/decision/1",
    kind: "file",
    summary: "the validation library this fleet uses",
    sig: "",
    children: [],
  },
});

function withIndex(h: ReturnType<typeof harness>, ask: (prompt: string) => Promise<string>) {
  h.db.run(
    "INSERT INTO note (id, project_id, grp_id, kind, lang, body, at) VALUES (1, 1, 1, 'decision', 'zh', 'we settled on zod', 0)",
  );
  saveTree(h.db, 1, indexed());
  h.ctx.askIn = () => ask;
}

test("the page index walks to a note and its body comes back with the answer", async () => {
  const h = harness();
  const asked: string[] = [];
  withIndex(h, async (prompt) => {
    asked.push(prompt);
    return prompt.includes("notes/grp-1/decision/1") ? "notes/grp-1/decision/1" : "notes/";
  });

  const r = await h.post("/orch/v1/ctx/query", { question: "which validation library?" }, "tok-eng");
  expect(r.status).toBe(200);
  const text = await r.text();
  // The summary is what the walk returns; the body is what makes it an answer
  // rather than a pointer.
  expect(text).toContain("the validation library this fleet uses");
  expect(text).toContain("### decision #1");
  expect(text).toContain("we settled on zod");
  expect(asked).toHaveLength(2);
});

test("a navigator that declines leaves the lexical map to answer", async () => {
  const h = harness();
  withIndex(h, async () => "NONE");
  const r = await h.post("/orch/v1/ctx/query", { question: "which validation library?" }, "tok-eng");
  expect(r.status).toBe(200);
  expect(await r.text()).not.toContain("the validation library this fleet uses");
});

test("a navigator that throws is not an error the agent sees", async () => {
  const h = harness();
  withIndex(h, async () => {
    throw new Error("the cheap model is unreachable");
  });
  const r = await h.post("/orch/v1/ctx/query", { question: "which validation library?" }, "tok-eng");
  expect(r.status).toBe(200);
  expect(await r.text()).not.toContain("unreachable");
});

test("no index and no model each fall straight through", async () => {
  const noModel = harness();
  saveTree(noModel.db, 1, indexed());
  expect((await noModel.post("/orch/v1/ctx/query", { question: "anything" }, "tok-eng")).status).toBe(200);

  const noTree = harness();
  let walked = false;
  noTree.ctx.askIn = () => async () => {
    walked = true;
    return "notes/";
  };
  const r = await noTree.post("/orch/v1/ctx/query", { question: "anything" }, "tok-eng");
  expect(r.status).toBe(200);
  // No tree means no walk: the cheap call is skipped rather than made against
  // nothing.
  expect(walked).toBe(false);
});
