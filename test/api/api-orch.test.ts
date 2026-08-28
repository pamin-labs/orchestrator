import { expect, test } from "bun:test";
import { sayIn } from "../../src/contracts/said.ts";
import { said } from "../support/said.ts";
import { z } from "zod";
import { makeApp } from "../../src/composition/api.ts";
import { eq, isNotNull } from "drizzle-orm";
import type { Json } from "../../src/contracts/json.ts";
import { saveTree, type Tree } from "../../src/mech/knowledge/pageindex.ts";
import { event, grp, project, resource } from "../../src/platform/persistence/schema.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";
import * as fx from "../support/factories.ts";
import { seedAuth } from "../support/seed-auth.ts";
import { testContext } from "../support/test-context.ts";
import type { Github } from "../../src/mech/git/github.ts";

/**
 * The three agent-facing routes whose whole job is refusing the wrong caller.
 *
 * `pr`, `setup` and `ctx/query` each decide something before they delegate — who
 * may write a PR message, whether an install is worth remembering, whether the
 * page index has anything to say — and none of those decisions was reachable
 * from a test, so a refusal that stopped refusing would have gone unnoticed.
 */

async function harness(
  handle?: (cmd: string, cwd: string) => { code?: number; out?: string; err?: string },
  gh?: Github,
) {
  const published: number[] = [];
  const sandbox = fakeSandbox(handle);
  const ctx = await testContext({
    sandbox,
    publishBranch: (grpId) => void published.push(grpId),
    ...(gh ? { gh } : {}),
  });
  const db = ctx.db;
  await seedAuth(db);
  const f = fx.on(db);
  const p = await f.project.create({ name: "p", repo_path: "o/p", remote: "git@github.com:o/p.git" });
  const q = await f.project.create({ name: "q", repo_path: "o/q" });
  const g = await f.runningGrp.create({ project_id: p.id, name: "g1" });
  await f.runningGrp.create({ project_id: q.id, name: "g2" });
  for (const [role, token] of [
    ["scribe", "tok-scribe"],
    ["bootstrap", "tok-boot"],
    ["engineer", "tok-eng"],
  ] as const) {
    await f.agent.create({ project_id: p.id, grp_id: g.id, role, token });
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
  return { db, ctx, app, post, published, f, sandbox };
}

type Harness = Awaited<ReturnType<typeof harness>>;

/** `config_json` is `jsonb`: it comes back parsed, so these compare values. */
const config = async (h: Harness) =>
  (await h.db.select({ c: project.config_json }).from(project).where(eq(project.id, 1)))[0]?.c;

const oneEvent = async (h: Harness, kind: string) =>
  (
    await h.db
      .select({ author: event.author, body: event.body, meta: event.meta_json })
      .from(event)
      .where(eq(event.kind, kind))
  )[0];

const BODY = "The Scribe had no way to say what the branch is. This is that message.";

// ------------------------------------------------------------------ orch/pr

test("only the Scribe writes a pull request message, and only for its own project", async () => {
  const h = await harness();
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
  expect(await h.db.select({ id: grp.id }).from(grp).where(isNotNull(grp.pr_title))).toHaveLength(0);
});

test("a message the convention refuses is not stored and publishes nothing", async () => {
  const h = await harness();
  const r = await h.post("/orch/v1/pr", { group_id: 1, title: "made some changes", body: BODY }, "tok-scribe");
  expect(r.status).toBe(422);
  expect(await r.text()).toContain("title needs a type prefix");
  expect(h.published).toEqual([]);
  const [only] = await h.db.select({ pr_title: grp.pr_title }).from(grp).where(eq(grp.id, 1));
  expect(only?.pr_title).toBeNull();
});

test("an accepted message is stored, announced, and publishes the branch", async () => {
  const h = await harness();
  const r = await h.post(
    "/orch/v1/pr",
    { group_id: "g1", title: "  fix(pr): say what landed  ", body: `  ${BODY}  ` },
    "tok-scribe",
  );
  expect(r.status).toBe(200);

  const [g] = await h.db.select({ pr_title: grp.pr_title, pr_summary: grp.pr_summary }).from(grp).where(eq(grp.id, 1));
  // Trimmed on the way in: the title is a git subject line and the body is the
  // commit message under it.
  expect(g?.pr_title).toBe("fix(pr): say what landed");
  expect(g?.pr_summary).toBe(BODY);
  expect(h.published).toEqual([1]);
  // The Scribe's own commit message, stored verbatim: this body is not a
  // sentence this repository writes, so there is no descriptor beside it.
  expect(await oneEvent(h, "note")).toMatchObject({ author: "scribe", body: "fix(pr): say what landed" });
});

// --------------------------------------------------------------- orch/setup

test("only the bootstrap role sets a project up", async () => {
  const h = await harness();
  const r = await h.post("/orch/v1/setup", { cmd: "bun install" }, "tok-eng");
  expect(r.status).toBe(422);
  expect(await r.text()).toContain("engineer does not set this project up");
});

test("setup needs a command or an explicit none", async () => {
  const h = await harness();
  const r = await h.post("/orch/v1/setup", { cmd: "   " }, "tok-boot");
  expect(r.status).toBe(422);
  expect(await r.text()).toContain("--none");
  // Nothing ran, so nothing was remembered either.
  expect(await config(h)).toEqual({});
});

test("--none records that the repository needs nothing and says so", async () => {
  const h = await harness();
  const r = await h.post("/orch/v1/setup", { none: true }, "tok-boot");
  expect(r.status).toBe(200);
  expect(await config(h)).toEqual({ install: null });
  const said = await oneEvent(h, "state_change");
  expect(said?.author).toBe("bootstrap");
  expect(said?.body).toContain("needs nothing installed");
});

test("a failed install is reported with its tail and is not remembered", async () => {
  const h = await harness(() => ({ code: 1, out: "error: no lockfile", err: "exit 1" }));
  const r = await h.post("/orch/v1/setup", { cmd: "bun install --frozen-lockfile" }, "tok-boot");
  expect(r.status).toBe(422);
  const text = await r.text();
  expect(text).toContain("install failed");
  expect(text).toContain("no lockfile");
  // The point of remembering is that the next group does not pay again — a
  // command that did not work is not worth handing on.
  expect(await config(h)).toEqual({});
});

test("an install that worked is remembered on the project", async () => {
  const h = await harness(() => ({ code: 0, out: "done" }));
  const r = await h.post("/orch/v1/setup", { cmd: "bun install" }, "tok-boot");
  expect(r.status).toBe(200);
  expect(await config(h)).toEqual({ install: "bun install" });
});

/**
 * A gate an agent worked out, for a stack no rule could classify.
 *
 * Detection enumerates what a repository declares in any language and only
 * *classification* runs out of rows. These cover the second half of that split:
 * the agent names the gate, and the route checks the answer two ways — declared
 * by the repository, or proven by running here — rather than trusting it.
 */
const repoOf =
  (files: Record<string, string>) =>
  (cmd: string): { code?: number; out?: string } | null => {
    if (cmd.startsWith("ls -A '/work/.github/workflows'")) return { out: "" };
    if (cmd.startsWith("ls -A")) return { out: Object.keys(files).join("\n") };
    const cat = /^cat '\/work\/([^']+)'$/.exec(cmd);
    if (!cat) return null;
    const body = files[cat[1]!];
    return body === undefined ? { code: 1 } : { out: body };
  };

/** The resource templates registered against this project, by name. */
const gateRows = (h: Harness) => h.db.select({ name: resource.name, template: resource.template }).from(resource);

test("a gate the repository declares is registered without being run", async () => {
  const answer = repoOf({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) });
  const h = await harness((cmd) => answer(cmd) ?? { code: 1, out: "should not have run" });

  const r = await h.post("/orch/v1/setup", { gates: [{ name: "test", cmd: "npm run test" }] }, "tok-boot");

  expect(r.status).toBe(200);
  expect(await gateRows(h)).toEqual([{ name: "test", template: "npm run test" }]);
  expect(await config(h)).toEqual({ gates: ["test"] });
  // The repository committed this command, so there is nothing to prove by
  // running it — and a test suite is not something to run twice for a formality.
  expect(h.sandbox.commands.some((c) => c.includes("'npm' 'run' 'test'"))).toBe(false);
});

test("a gate the repository does not declare has to earn its place by running", async () => {
  // An Erlang repository with no CI: `rebar3 eunit` is the answer and nothing in
  // the repository says so. This is the case that used to reach the boss.
  const answer = repoOf({ "rebar.config": "{erl_opts, []}." });
  const h = await harness(
    (cmd) => answer(cmd) ?? (cmd.includes("'rebar3' 'eunit'") ? { out: "All 12 tests passed." } : {}),
  );

  const r = await h.post("/orch/v1/setup", { gates: [{ name: "test", cmd: "rebar3 eunit" }] }, "tok-boot");

  expect(r.status).toBe(200);
  expect(await gateRows(h)).toEqual([{ name: "test", template: "rebar3 eunit" }]);
  expect(await config(h)).toEqual({ gates: ["test"] });
  expect(h.sandbox.commands.some((c) => c.includes("'rebar3' 'eunit'"))).toBe(true);
});

test("a command that is neither declared nor passes is refused, and the refusal says what is declared", async () => {
  const answer = repoOf({ Makefile: "test:\n\tgo test ./...\n\nlint:\n\tgo vet ./...\n" });
  const h = await harness((cmd) => answer(cmd) ?? { code: 127, out: "rebar3: command not found" });

  const r = await h.post("/orch/v1/setup", { gates: [{ name: "test", cmd: "rebar3 eunit" }] }, "tok-boot");

  expect(r.status).toBe(422);
  const text = await r.text();
  expect(text).toContain("command not found");
  // Teachable: the agent is told what it may point at instead of being told no.
  expect(text).toContain("make test");
  expect(text).toContain("make lint");
  expect(await gateRows(h)).toEqual([]);
  expect(await config(h)).toEqual({});
});

test("a gate that needs a shell is refused before it is run", async () => {
  const answer = repoOf({ Makefile: "test:\n\tgo test ./...\n" });
  const h = await harness((cmd) => answer(cmd) ?? {});

  const r = await h.post("/orch/v1/setup", { gates: [{ name: "test", cmd: "make deps && make test" }] }, "tok-boot");

  expect(r.status).toBe(422);
  // `lease.ts` tokenises on whitespace, so this would have handed `&&` to `make`
  // as an argument — a gate that looks like it ran and did half of nothing.
  expect(await r.text()).toContain("without a shell");
  expect(h.sandbox.commands.some((c) => c.includes("&&"))).toBe(false);
  expect(await gateRows(h)).toEqual([]);
});

test("gates are registered after the install, on the checkout every later gate sees", async () => {
  const answer = repoOf({ "rebar.config": "" });
  const order: string[] = [];
  const h = await harness((cmd) => {
    if (cmd.includes("rebar3")) order.push(cmd.includes("'rebar3' 'eunit'") ? "gate" : "install");
    return answer(cmd) ?? {};
  });

  const r = await h.post(
    "/orch/v1/setup",
    { cmd: "rebar3 get-deps", gates: [{ name: "test", cmd: "rebar3 eunit" }] },
    "tok-boot",
  );

  expect(r.status).toBe(200);
  // A gate proven before its dependencies exist is proven against a checkout
  // nothing else will ever see.
  expect(order).toEqual(["install", "gate"]);
  expect(await config(h)).toEqual({ install: "rebar3 get-deps", gates: ["test"] });
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

async function withIndex(h: Harness, ask: (prompt: string) => Promise<string>) {
  // No explicit id: it is the first note either way, and `generatedByDefaultAsIdentity`
  // does not advance its sequence for a supplied one — so `saveTree` below would
  // then insert its own note at id 1 and collide.
  await h.f.note.create({ project_id: 1, grp_id: 1, kind: "decision", body: "we settled on zod" });
  await saveTree(h.db, 1, indexed());
  h.ctx.askIn = () => ask;
}

test("the page index walks to a note and its body comes back with the answer", async () => {
  const h = await harness();
  const asked: string[] = [];
  await withIndex(h, async (prompt) => {
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
  const h = await harness();
  await withIndex(h, async () => "NONE");
  const r = await h.post("/orch/v1/ctx/query", { question: "which validation library?" }, "tok-eng");
  expect(r.status).toBe(200);
  expect(await r.text()).not.toContain("the validation library this fleet uses");
});

test("a navigator that throws is not an error the agent sees", async () => {
  const h = await harness();
  await withIndex(h, async () => {
    throw new Error("the cheap model is unreachable");
  });
  const r = await h.post("/orch/v1/ctx/query", { question: "which validation library?" }, "tok-eng");
  expect(r.status).toBe(200);
  expect(await r.text()).not.toContain("unreachable");
});

test("no index and no model each fall straight through", async () => {
  const noModel = await harness();
  await saveTree(noModel.db, 1, indexed());
  expect((await noModel.post("/orch/v1/ctx/query", { question: "anything" }, "tok-eng")).status).toBe(200);

  const noTree = await harness();
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

// -------------------------------------------------------- orch/pr/resolve

/**
 * A GitHub that answers both halves of a resolve. Both are `POST /graphql`, so
 * which one this is comes off the query text, and `calls` is what proves the
 * mutation was never reached.
 */
function fakeGh(where: Json, calls: string[]): Github {
  return {
    remaining: () => 4999,
    async request(_method, _path, schema, body) {
      const sent = z.object({ query: z.string() }).safeParse(body);
      const query = sent.success ? sent.data.query : "";
      const mutation = query.startsWith("mutation");
      calls.push(mutation ? "resolve" : "locate");
      const answer: Json = mutation ? { data: { resolveReviewThread: { thread: { isResolved: true } } } } : where;
      const parsed = schema.safeParse(answer);
      return parsed.success
        ? { ok: true, status: 200, data: parsed.data }
        : { ok: false, status: 200, bucket: "transient", message: "invalid fixture" };
    },
  };
}

/** Where GitHub says the thread is. The group below is `o/p` #7 owning `src/api/**`. */
const threadAt = (over: Record<string, Json> = {}): Json => ({
  data: {
    node: {
      path: "src/api/orch/pr.ts",
      pullRequest: { number: 7, repository: { nameWithOwner: "o/p" } },
      ...over,
    },
  },
});

async function resolveHarness(where: Json) {
  const calls: string[] = [];
  const h = await harness(undefined, fakeGh(where, calls));
  await h.db
    .update(grp)
    .set({ pr_number: 7, owns_json: ["src/api/**"] })
    .where(eq(grp.id, 1));
  const send = (body: Json) => h.post("/orch/v1/pr/resolve", body, "tok-eng");
  return { ...h, calls, send };
}

const noteCount = async (db: Harness["db"]) =>
  (await db.select({ seq: event.seq }).from(event).where(eq(event.kind, "note"))).length;

test("a thread on somebody else's pull request is refused before the mutation runs", async () => {
  // The id is opaque and the agent is the one quoting it, so nothing about it says
  // which PR it belongs to. Trusting it means one group closing another's review.
  const h = await resolveHarness(
    threadAt({ pullRequest: { number: 7, repository: { nameWithOwner: "o/somewhere-else" } } }),
  );
  const r = await h.send({ group_id: 1, thread_id: "PRRT_x" });
  expect(r.status).toBe(422);
  expect(await r.text()).toContain("that thread is on o/somewhere-else#7");
  // The number alone matches: every repository this token can write to has a #7.
  expect(h.calls).toEqual(["locate"]);

  // And the same repository, a different PR.
  const other = await resolveHarness(threadAt({ pullRequest: { number: 9, repository: { nameWithOwner: "o/p" } } }));
  const r2 = await other.send({ group_id: 1, thread_id: "PRRT_x" });
  expect(r2.status).toBe(422);
  expect(await r2.text()).toContain("o/p#9");
  expect(other.calls).toEqual(["locate"]);
});

test("a thread on a file the group does not own is refused, and sent to the boss instead", async () => {
  // Closing it would hide the request from whoever does own the file: the thread
  // is the only place it is recorded, and a resolved one is not re-raised.
  const h = await resolveHarness(threadAt({ path: "src/mech/git/prwatch.ts" }));
  const r = await h.send({ group_id: 1, thread_id: "PRRT_x" });
  expect(r.status).toBe(422);
  const said = await r.text();
  expect(said).toContain("src/mech/git/prwatch.ts is outside this group's boundary");
  expect(said).toContain("orch ask-boss");
  expect(h.calls).toEqual(["locate"]);
  expect(await noteCount(h.db)).toBe(0);
});

test("a thread inside the boundary is closed, and the group's record says so", async () => {
  const h = await resolveHarness(threadAt());
  const r = await h.send({ group_id: 1, thread_id: "PRRT_x", note: "guarded it, test at pr.test.ts:40" });
  expect(r.status).toBe(200);
  expect(h.calls).toEqual(["locate", "resolve"]);
  const note = await oneEvent(h, "note");
  expect(note?.author).toBe("engineer");
  // The path and the agent's own note, which is what this call carried; the
  // sentence around them belongs to the catalogue the reader's panel holds.
  expect(sayIn(note?.meta)).toMatchObject({
    ...said("resolved review thread on {path}: {note}"),
    values: { path: "src/api/orch/pr.ts", note: "guarded it, test at pr.test.ts:40" },
  });
});

test("resolve refuses another project's group, and a group with no pull request", async () => {
  const h = await resolveHarness(threadAt());
  const other = await h.send({ group_id: 2, thread_id: "PRRT_x" });
  expect(other.status).toBe(403);
  expect(await other.text()).toContain("not your project");

  await h.db.update(grp).set({ pr_number: null }).where(eq(grp.id, 1));
  const none = await h.send({ group_id: 1, thread_id: "PRRT_x" });
  expect(none.status).toBe(422);
  expect(await none.text()).toContain("no pull request open");
  // Neither reached GitHub at all.
  expect(h.calls).toEqual([]);
});

test("an id that names no review thread is a refusal, not a resolve", async () => {
  // `node(id:)` answers null for an id of another type, which is what a
  // hallucinated or stale id looks like.
  const h = await resolveHarness({ data: { node: null } });
  const r = await h.send({ group_id: 1, thread_id: "PRRT_nope" });
  expect(r.status).toBe(422);
  expect(await r.text()).toContain("no review thread with id PRRT_nope");
  expect(h.calls).toEqual(["locate"]);
});
