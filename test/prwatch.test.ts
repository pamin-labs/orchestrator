import { expect, test } from "bun:test";
import { Bus } from "../src/bus.ts";
import { loadConfig } from "../src/config.ts";
import { openMemory } from "../src/db.ts";
import { RepoLock } from "../src/mech/gitlock.ts";
import { dispatchFeedback, openPr, pollPrs, preflightPr, type GhRunner } from "../src/mech/prwatch.ts";
import { evictOldestLessons, LESSON_CAP, makeApp, type Ctx } from "../src/api.ts";
import { Scheduler } from "../src/scheduler.ts";

function harness() {
  const db = openMemory();
  const cfg = loadConfig();
  const ctx: Ctx = {
    db,
    bus: new Bus(db),
    sched: new Scheduler(db, async () => {}),
    gitLock: new RepoLock(),
    waiters: new Map(),
    config: { language: "中文", difficultyModel: cfg.difficultyModel, workRoot: "/tmp/x" },
  };
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  db.run(
    "INSERT INTO grp (project_id, name, status, worktree, branch, created_at) VALUES (1, 'g1', 'PR_OPEN', '/tmp/wt/g1', 'orch/g1', 0)",
  );
  return { db, ctx };
}

const gh = (script: Record<string, { code: number; out: string }>): GhRunner =>
  async (argv) => {
    const key = argv.slice(0, 2).join(" ");
    return script[key] ?? { code: 0, out: "{}" };
  };

const okGit = async () => ({ code: 0, out: "" });

test("opening a PR records its number once", async () => {
  const h = harness();
  const runner = gh({ "pr create": { code: 0, out: "created" }, "pr view": { code: 0, out: '{"number":42}' } });
  const base = { ctx: h.ctx, git: okGit, repo: "/tmp/p", grpId: 1, title: "t", body: "b" };
  const r = await openPr({ ...base, gh: runner });
  expect(r).toEqual({ number: 42 });
  expect(h.db.query<{ pr_number: number }, []>("SELECT pr_number FROM grp").get()!.pr_number).toBe(42);

  // Calling again is a no-op rather than a second PR.
  const again = await openPr({ ...base, gh: gh({}) });
  expect(again).toEqual({ number: 42 });
});

test("a failed PR creation reports why instead of vanishing", async () => {
  const h = harness();
  const r = await openPr({
    ctx: h.ctx,
    gh: gh({ "pr create": { code: 1, out: "no upstream configured" } }),
    git: okGit,
    repo: "/tmp/p",
    grpId: 1,
    title: "t",
    body: "b",
  });
  expect("error" in r && r.error).toContain("no upstream");
});

test("the branch is pushed under the lock before gh is asked to open a PR", async () => {
  // Nothing else pushes a group's branch, and `gh pr create` refuses to do it
  // outside a TTY. If this order ever flips, every PR fails on a real remote.
  const h = harness();
  const calls: string[] = [];
  const r = await openPr({
    ctx: h.ctx,
    gh: async (argv) => {
      calls.push(`gh ${argv.slice(0, 2).join(" ")}`);
      return { code: 0, out: '{"number":9}' };
    },
    git: async (repo, argv) => {
      calls.push(`git(${repo}) ${argv.join(" ")}`);
      return { code: 0, out: "" };
    },
    repo: "/tmp/p",
    grpId: 1,
    title: "t",
    body: "b",
  });
  expect(r).toEqual({ number: 9 });
  const push = calls.indexOf("git(/tmp/p) push -u origin orch/g1");
  const create = calls.indexOf("gh pr create");
  expect(push).toBeGreaterThan(-1);
  // Order, not position: the squash runs before the push and adds git calls.
  expect(push).toBeLessThan(create);
  expect(calls.indexOf("git(/tmp/p) log --format=%s main..HEAD")).toBeLessThan(push);
});

test("a push that fails names the branch, and no PR is attempted", async () => {
  const h = harness();
  let ghCalled = false;
  const r = await openPr({
    ctx: h.ctx,
    gh: async () => {
      ghCalled = true;
      return { code: 0, out: "{}" };
    },
    git: async () => ({ code: 1, out: "remote: Permission to x/y denied\nfatal: unable to access" }),
    repo: "/tmp/p",
    grpId: 1,
    title: "t",
    body: "b",
  });
  expect("error" in r && r.error).toContain("could not push orch/g1");
  expect("error" in r && r.error).toContain("Permission");
  expect(ghCalled).toBe(false);
});

test("only new comments and failing checks come back", async () => {
  const h = harness();
  h.db.run("UPDATE grp SET pr_number = 7, pr_seen_at = 1000 WHERE id = 1");
  const payload = JSON.stringify({
    comments: [
      { author: { login: "alice" }, body: "old news", createdAt: new Date(500).toISOString() },
      { author: { login: "bob" }, body: "needs a test", createdAt: new Date(2000).toISOString() },
    ],
    reviews: [],
    statusCheckRollup: [
      { name: "ci", conclusion: "FAILURE" },
      { name: "lint", conclusion: "SUCCESS" },
    ],
  });
  const fs = await pollPrs(h.ctx, gh({ "pr view": { code: 0, out: payload } }));
  expect(fs.length).toBe(1);
  expect(fs[0]!.comments.map((c) => c.author)).toEqual(["bob"]);
  expect(fs[0]!.failingChecks).toEqual(["ci"]);

  // The cursor advanced and the failing set is unchanged, so a PR that stays red
  // with nothing new said does not wake the PM every 30 seconds.
  const again = await pollPrs(h.ctx, gh({ "pr view": { code: 0, out: payload } }));
  expect(again.length).toBe(0);

  // A newly broken check IS news.
  const worse = JSON.stringify({
    comments: [],
    reviews: [],
    statusCheckRollup: [
      { name: "ci", conclusion: "FAILURE" },
      { name: "lint", conclusion: "FAILURE" },
    ],
  });
  const third = await pollPrs(h.ctx, gh({ "pr view": { code: 0, out: worse } }));
  expect(third[0]!.failingChecks.sort()).toEqual(["ci", "lint"]);
});

test("a quiet PR produces nothing at all", async () => {
  const h = harness();
  h.db.run("UPDATE grp SET pr_number = 7 WHERE id = 1");
  const fs = await pollPrs(
    h.ctx,
    gh({ "pr view": { code: 0, out: JSON.stringify({ comments: [], reviews: [], statusCheckRollup: [] }) } }),
  );
  expect(fs).toEqual([]);
});

test("feedback reopens the group and hands it to the PM", () => {
  const h = harness();
  dispatchFeedback(h.ctx, {
    grpId: 1,
    prNumber: 7,
    comments: [{ author: "bob", body: "needs a test", at: 2000 }],
    failingChecks: ["ci"],
  });
  expect(h.db.query<{ status: string }, []>("SELECT status FROM grp").get()!.status).toBe("RUNNING");
  const job = h.db.query<{ payload_json: string }, []>("SELECT payload_json FROM job").get()!;
  // Replying to a review needs judgement; noticing it did not.
  expect(JSON.parse(job.payload_json).role).toBe("pm");
  expect(JSON.parse(job.payload_json).rejection).toContain("needs a test");
});

test("the lessons list is capped where it is written", async () => {
  const h = harness();
  const app = makeApp(h.ctx);
  h.db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, clearance, token, created_at) VALUES (1, 1, 'librarian', 'm', 'L1', 'tok-lib', 0)",
  );
  const ins = h.db.prepare("INSERT INTO note (project_id, kind, lang, body, at) VALUES (1, 'lesson', 'zh', ?, ?)");
  for (let i = 0; i < LESSON_CAP; i++) ins.run(`lesson ${i}`, i);

  const r = await app(
    new Request("http://x/orch/journal", {
      method: "POST",
      body: JSON.stringify({ kind: "lesson", body: "the newest lesson" }),
      headers: { "x-orch-token": "tok-lib" },
    }),
  );
  expect(r.status).toBe(200);

  const rows = h.db
    .query<{ body: string }, []>("SELECT body FROM note WHERE kind = 'lesson' ORDER BY at DESC")
    .all();
  // A list that keeps growing becomes the very context cost it exists to prevent.
  expect(rows.length).toBe(LESSON_CAP);
  expect(rows[0]!.body).toBe("the newest lesson");
  expect(rows.some((x) => x.body === "lesson 0")).toBe(false);
});

test("eviction leaves other note kinds alone", () => {
  const h = harness();
  h.db.run("INSERT INTO note (project_id, kind, lang, body, at) VALUES (1, 'retro', 'zh', 'keep me', 0)");
  const ins = h.db.prepare("INSERT INTO note (project_id, kind, lang, body, at) VALUES (1, 'lesson', 'zh', ?, ?)");
  for (let i = 0; i < LESSON_CAP + 5; i++) ins.run(`l${i}`, i);

  expect(evictOldestLessons(h.ctx, 1)).toBe(5);
  expect(h.db.query<{ c: number }, []>("SELECT count(*) AS c FROM note WHERE kind = 'retro'").get()!.c).toBe(1);
});

test("landing archives the group without deleting its history", () => {
  const h = harness();
  h.db.run("INSERT INTO channel (project_id, grp_id, kind, created_at) VALUES (1, 1, 'group', 0)");
  h.db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, session_id, token, created_at) VALUES (1, 1, 'engineer', 'm', 'live', 'tok-x', 0)",
  );
  h.ctx.bus.emit({ grpId: 1, author: "engineer", kind: "say", body: "why we did it this way" });

  const { landed } = require("../src/mech/mergequeue.ts");
  landed(h.db, 1);

  const a = h.db.query<{ state: string; session_id: string | null; token: string | null }, []>(
    "SELECT state, session_id, token FROM agent",
  ).get()!;
  expect(a.state).toBe("retired");
  expect(a.session_id).toBeNull();
  // The token is revoked with the group, so a stale process cannot act as it.
  expect(a.token).toBeNull();
  expect(h.db.query<{ status: string }, []>("SELECT status FROM channel").get()!.status).toBe("archived");
  // Archiving must never mean deleting: a later group grepping this is the only
  // long-term memory the system has.
  expect(h.db.query<{ c: number }, []>("SELECT count(*) AS c FROM event").get()!.c).toBeGreaterThan(0);
});

test("preflight says up front whether a PR can ever be opened", async () => {
  const noRemote = await preflightPr(
    "/tmp/x",
    async () => ({ code: 1, out: "" }),
    async () => ({ code: 0, out: "" }),
  );
  // Discovering this when a branch is finished is the worst possible moment.
  expect(noRemote.ok).toBe(false);
  expect(noRemote.reason).toContain("nowhere to go");

  const notGithub = await preflightPr(
    "/tmp/x",
    async () => ({ code: 0, out: "git@gitlab.com:me/x.git" }),
    async () => ({ code: 0, out: "" }),
  );
  expect(notGithub.ok).toBe(false);
  expect(notGithub.reason).toContain("not GitHub");

  const notLoggedIn = await preflightPr(
    "/tmp/x",
    async () => ({ code: 0, out: "git@github.com:me/x.git" }),
    async () => ({ code: 1, out: "not logged in" }),
  );
  expect(notLoggedIn.ok).toBe(false);
  expect(notLoggedIn.reason).toContain("gh auth login");

  const ready = await preflightPr(
    "/tmp/x",
    async () => ({ code: 0, out: "git@github.com:me/x.git" }),
    async () => ({ code: 0, out: "Logged in" }),
  );
  expect(ready).toEqual({ ok: true, remote: "git@github.com:me/x.git" });
});
