import { expect, test } from "bun:test";
import { Bus } from "../src/bus.ts";
import { loadConfig } from "../src/config.ts";
import { openMemory } from "../src/db.ts";
import {
  checkPrMessage,
  commitMessage,
  dispatchFeedback,
  openPr,
  pollPrs,
  prBody,
  prTitle,
  pushBlocked,
} from "../src/mech/git/prwatch.ts";
import { utilGit } from "../src/mech/git/checkout.ts";
import type { GhResult, Github } from "../src/mech/git/github.ts";
import { evictOldestLessons, LESSON_CAP, makeApp, type Ctx } from "../src/api.ts";
import { Scheduler } from "../src/scheduler.ts";
import { fakeSandbox } from "./fake-sandbox.ts";
import { seedAuth } from "./seed-auth.ts";
import type { Json } from "../src/http/respond.ts";

function harness(
  handle: (cmd: string) => { code?: number; out?: string; err?: string } = () => ({}),
  calls?: string[],
) {
  const db = openMemory();
  seedAuth(db);
  const _cfg = loadConfig();
  const sandbox = fakeSandbox((cmd) => {
    calls?.push(cmd);
    return handle(cmd);
  });
  const ctx: Ctx = {
    db,
    bus: new Bus(db),
    sched: new Scheduler(db, async () => {}),
    // `git bundle create` carries the branch out of the group's container; the
    // utility container fetches from the bundle and pushes. Both are containers,
    // so both are this one fake.
    sandbox,
    waiters: new Map(),
    config: _cfg,
  };
  // The remote is what `owner/repo` is derived from, and since 007 step 5 it is
  // also what the clone and the push use — one answer, not two columns that can
  // disagree.
  db.run(
    "INSERT INTO project (name, repo_path, remote, created_at) VALUES ('p', '/tmp/p', 'git@github.com:me/x.git', 0)",
  );
  db.run("INSERT INTO grp (project_id, name, status, branch, created_at) VALUES (1, 'g1', 'PR_OPEN', 'orch/g1', 0)");
  return { db, ctx, sandbox };
}

const ok = <T>(data: T): GhResult<T> => ({ ok: true, status: 200, data });
const boom = (status: number, message: string, bucket: "boss" | "agent" | "transient" = "agent"): GhResult<never> => ({
  ok: false,
  status,
  bucket,
  message,
});

/**
 * A GitHub that answers from a table, keyed `METHOD /path` with the query
 * dropped. Anything not in the table answers empty rather than undefined, which
 * is what a PR with no comments and no checks actually looks like.
 */
const gh = (script: Record<string, GhResult<Json>>, calls: string[] = []): Github => ({
  remaining: () => 4999,
  async request(method, path, schema) {
    const key = `${method} ${path.split("?")[0]}`;
    calls.push(key);
    const answer =
      script[key] ??
      (key.endsWith("/comments") || key.endsWith("/reviews")
        ? ok([])
        : key.endsWith("/check-runs")
          ? ok({ check_runs: [] })
          : key.endsWith("/status")
            ? ok({ statuses: [] })
            : ok(null));
    if (!answer.ok) return answer;
    const parsed = schema.safeParse(answer.data);
    return parsed.success
      ? { ...answer, data: parsed.data }
      : { ok: false, status: answer.status, bucket: "transient", message: "invalid fixture" };
  },
});

/** The PR view every poll starts with. Open, mergeable, one head commit. */
const pr = (over: Record<string, Json> = {}) =>
  ok({ state: "open", merged: false, mergeable: true, head: { sha: "deadbee" }, ...over });

const okGit = async () => ({ code: 0, out: "" });

test("opening a PR records its number once", async () => {
  const h = harness();
  // The create answer carries the number, so there is no second lookup.
  const calls: string[] = [];
  const runner = gh({ "POST /repos/me/x/pulls": ok({ number: 42 }) }, calls);
  const base = { ctx: h.ctx, git: okGit, repo: "/tmp/p", grpId: 1, title: "t", body: "b" };
  const r = await openPr({ ...base, gh: runner });
  expect(r).toEqual({ number: 42 });
  expect(h.db.query<{ pr_number: number }, []>("SELECT pr_number FROM grp").get()!.pr_number).toBe(42);
  expect(calls).toEqual(["POST /repos/me/x/pulls"]);

  // Calling again is a no-op rather than a second PR — but it does refresh the
  // description, which is three slices out of date by then.
  const second: string[] = [];
  const again = await openPr({ ...base, gh: gh({ "PATCH /repos/me/x/pulls/42": ok({ number: 42 }) }, second) });
  expect(again).toEqual({ number: 42 });
  expect(second).toEqual(["PATCH /repos/me/x/pulls/42"]);
});

test("refreshing an existing PR reports GitHub rejection", async () => {
  const h = harness();
  h.db.run("UPDATE grp SET pr_number = 42 WHERE id = 1");
  const result = await openPr({
    ctx: h.ctx,
    gh: gh({ "PATCH /repos/me/x/pulls/42": boom(422, "title rejected") }),
    grpId: 1,
    title: "t",
    body: "b",
  });
  expect(result).toEqual({ error: "title rejected" });
});

test("the PR body is built from the record, not from a sentence", () => {
  const h = harness();
  h.db.run(
    "INSERT INTO event (grp_id, author, kind, body, at, seq) VALUES (1, 'boss', 'boss_say', 'the timeline flickers', 0, 1)",
  );
  h.db.run(
    `INSERT INTO slice (grp_id, seq, title, accept_spec, gates_json, status, created_at)
     VALUES (1, 1, 'stable keys', 'no row remounts', '{"self":"pass","gate":"pass","qa":"fail"}', 'accepted', 0)`,
  );
  h.db.run(
    "INSERT INTO note (grp_id, kind, body, export_path, at) VALUES (1, 'decision', 'key was at+index', 'docs/journal/g1/003.md', 0)",
  );
  h.db.run("INSERT INTO note (grp_id, kind, body, at) VALUES (1, 'retro', 'memo alone was not enough', 0)");

  const body = prBody(h.ctx, 1);
  expect(body).toContain("the timeline flickers");
  expect(body).toContain("**S1 stable keys**");
  expect(body).toContain("no row remounts");
  // Only what actually passed; a failed layer must not be listed as green.
  expect(body).toContain("self, gate pass");
  expect(body).not.toContain("qa pass");
  expect(body).toContain("(docs/journal/g1/003.md)");
  expect(body).toContain("memo alone was not enough");
  expect(body).toContain("orch/g1");
});

test("a failed PR creation reports why instead of vanishing", async () => {
  const h = harness();
  const r = await openPr({
    ctx: h.ctx,
    gh: gh({
      "POST /repos/me/x/pulls": boom(422, "No commits between main and orch/g1"),
      "GET /repos/me/x/pulls": ok([]),
    }),
    grpId: 1,
    title: "t",
    body: "b",
  });
  expect("error" in r && r.error).toContain("No commits between");
});

test("a create refused because the PR already exists finds the one that is there", async () => {
  // A retry after a half-finished attempt: the branch is pushed and the PR is
  // open, but nothing wrote the number down. Without the lookup the group would
  // be told it has no PR and could never get one.
  const h = harness();
  const r = await openPr({
    ctx: h.ctx,
    gh: gh({
      "POST /repos/me/x/pulls": boom(422, "A pull request already exists for me:orch/g1."),
      "GET /repos/me/x/pulls": ok([{ number: 13 }]),
    }),
    grpId: 1,
    title: "t",
    body: "b",
  });
  expect(r).toEqual({ number: 13 });
});

test("a project with no GitHub remote says so instead of building a URL out of nothing", async () => {
  const h = harness();
  h.db.run("UPDATE project SET remote = NULL");
  const r = await openPr({
    ctx: h.ctx,
    gh: gh({}),
    grpId: 1,
    title: "t",
    body: "b",
  });
  expect("error" in r && r.error).toContain("nowhere to go");
});

test("the branch reaches the remote before GitHub is asked to open a PR", async () => {
  // Nothing else pushes a group's branch, and GitHub refuses to create a PR for
  // a head it has never heard of. If this order ever flips, every PR fails on a
  // real remote.
  const calls: string[] = [];
  const h = harness(() => ({}), calls);
  const r = await openPr({
    ctx: h.ctx,
    gh: gh({ "POST /repos/me/x/pulls": ok({ number: 9 }) }, calls),
    grpId: 1,
    title: "t",
    body: "b",
  });
  expect(r).toEqual({ number: 9 });
  const push = calls.findIndex((c) => c.includes("push '--force-with-lease' 'origin'"));
  const create = calls.indexOf("POST /repos/me/x/pulls");
  expect(push).toBeGreaterThan(-1);
  // Order, not position: the squash and the bundle both run before the push.
  expect(push).toBeLessThan(create);
  expect(calls.findIndex((c) => c.includes("bundle create"))).toBeLessThan(push);
});

test("a push that fails names the branch, and no PR is attempted", async () => {
  const gcalls: string[] = [];
  // Only the push fails. Taking the branch out of the group's container is a
  // local fetch from a bundle with no remote to be refused by — which is the
  // point of splitting them: the group holds no credential that can push.
  const h = harness((cmd) =>
    cmd.includes("push") ? { code: 1, out: "remote: Permission to x/y denied\nfatal: unable to access" } : {},
  );
  const r = await openPr({
    ctx: h.ctx,
    gh: gh({}, gcalls),
    grpId: 1,
    title: "t",
    body: "b",
  });
  expect("error" in r && r.error).toContain("could not push orch/g1");
  expect("error" in r && r.error).toContain("Permission");
  expect(gcalls).toEqual([]);
});

test("the utility container never checks anything out, and never runs a hook", async () => {
  // 007 narrows 005 by one word: the boundary is a container that runs an
  // *agent*. This one runs none and holds the real token, so the two rules that
  // buy that are `if`s — every invocation disables hooks, and the verb list has
  // no way to produce a working tree from repository content. CVE-2024-32002 and
  // CVE-2025-48384 are what a checkout here would be worth.
  const calls: string[] = [];
  const h = harness(() => ({}), calls);
  await openPr({
    ctx: h.ctx,
    gh: gh({ "POST /repos/me/x/pulls": ok({ number: 9 }) }),
    grpId: 1,
    title: "t",
    body: "b",
  });

  const util = calls.filter((c) => c.includes("core.hooksPath=/dev/null"));
  expect(util.length).toBeGreaterThan(0);
  for (const c of util) {
    expect(/git -c core\.hooksPath=\/dev\/null (clone|fetch|push|bundle)\b/.test(c)).toBe(true);
  }
  // The mirror is bare: nothing that came out of the repository is ever written
  // somewhere something would run it.
  const clone = calls.find((c) => c.includes("core.hooksPath=/dev/null") && c.includes("clone"));
  expect(clone).toContain("--bare");
  expect(calls.some((c) => c.includes("core.hooksPath=/dev/null") && /\b(checkout|submodule)\b/.test(c))).toBe(false);
});

test("the utility container refuses a verb that is not one of its four", async () => {
  // The list is the boundary, so reaching past it has to throw rather than
  // return an exit code somebody can ignore.
  const h = harness();
  await expect(utilGit(h.ctx, ["checkout", "main"])).rejects.toThrow(/may not run 'git checkout'/);
  await expect(utilGit(h.ctx, ["submodule", "update", "--init"])).rejects.toThrow(/may not run/);
});

test("only new comments and failing checks come back", async () => {
  const h = harness();
  h.db.run("UPDATE grp SET pr_number = 7, pr_seen_at = 1000 WHERE id = 1");
  // REST field names, not `gh`'s GraphQL projection: `user.login` and
  // `created_at`, and a lower-case `conclusion` where `gh` upper-cased it.
  const payload = {
    "GET /repos/me/x/pulls/7": pr(),
    "GET /repos/me/x/issues/7/comments": ok([
      { user: { login: "alice" }, body: "old news", created_at: new Date(500).toISOString() },
      { user: { login: "bob" }, body: "needs a test", created_at: new Date(2000).toISOString() },
    ]),
    "GET /repos/me/x/commits/deadbee/check-runs": ok({
      check_runs: [
        { name: "ci", conclusion: "failure" },
        { name: "lint", conclusion: "success" },
      ],
    }),
  };
  const fs = await pollPrs(h.ctx, gh(payload));
  expect(fs.length).toBe(1);
  expect(fs[0]!.comments.map((c) => c.author)).toEqual(["bob"]);
  expect(fs[0]!.failingChecks).toEqual(["ci"]);

  // The cursor advanced and the failing set is unchanged, so a PR that stays red
  // with nothing new said does not wake the PM every 30 seconds.
  const again = await pollPrs(h.ctx, gh(payload));
  expect(again.length).toBe(0);

  // A newly broken check IS news — and the older Status API counts as one too,
  // which is the half of `statusCheckRollup` that REST keeps in its own endpoint.
  const third = await pollPrs(
    h.ctx,
    gh({
      ...payload,
      "GET /repos/me/x/issues/7/comments": ok([]),
      "GET /repos/me/x/commits/deadbee/status": ok({ statuses: [{ context: "lint", state: "failure" }] }),
    }),
  );
  expect(third[0]!.failingChecks.sort()).toEqual(["ci", "lint"]);
});

test("feedback from a deleted GitHub user is still delivered", async () => {
  const h = harness();
  h.db.run("UPDATE grp SET pr_number = 7, pr_seen_at = 1000 WHERE id = 1");
  const fs = await pollPrs(
    h.ctx,
    gh({
      "GET /repos/me/x/pulls/7": pr(),
      "GET /repos/me/x/issues/7/comments": ok([
        { user: null, body: "still valid feedback", created_at: new Date(2000).toISOString() },
      ]),
      "GET /repos/me/x/pulls/7/reviews": ok([
        { user: null, body: "review survives deletion", submitted_at: new Date(3000).toISOString() },
      ]),
    }),
  );

  expect(fs[0]!.comments.map((c) => c.body)).toEqual(["still valid feedback", "review survives deletion"]);
});

test("a checks request that fails is not a PR that went green", async () => {
  // The four requests replacing one `gh pr view` are all-or-nothing on purpose:
  // an empty failing set is news, and a 502 must not be reported as one.
  const h = harness();
  h.db.run("UPDATE grp SET pr_number = 7, pr_checks_sig = 'ci' WHERE id = 1");
  const fs = await pollPrs(
    h.ctx,
    gh({
      "GET /repos/me/x/pulls/7": pr(),
      "GET /repos/me/x/commits/deadbee/check-runs": boom(502, "bad gateway", "transient"),
    }),
  );
  expect(fs).toEqual([]);
  // And the cursor did not move, so the next tick asks again.
  expect(h.db.query<{ s: string }, []>("SELECT pr_checks_sig AS s FROM grp").get()!.s).toBe("ci");
});

test("a PR closed on GitHub stops its group and lets the queue past; reopening puts it back", async () => {
  const h = harness();
  h.db.run("UPDATE grp SET pr_number = 7, merge_seq = 1 WHERE id = 1");
  const view = (state: string) => gh({ "GET /repos/me/x/pulls/7": pr({ state }) });

  const closed = await pollPrs(h.ctx, view("closed"));
  expect(closed[0]!.closed).toBe(true);

  // The group has to actually be paused for the reopen half to be reachable —
  // that is what the server does with this feedback.
  h.db.run("UPDATE grp SET status = 'PAUSED', merge_seq = NULL WHERE id = 1");
  // Still closed: nothing new to say, and no second escalation.
  expect(await pollPrs(h.ctx, view("closed"))).toEqual([]);

  const back = await pollPrs(h.ctx, view("open"));
  expect(back[0]!.reopened).toBe(true);
});

test("a quiet PR produces nothing at all", async () => {
  const h = harness();
  h.db.run("UPDATE grp SET pr_number = 7 WHERE id = 1");
  const fs = await pollPrs(h.ctx, gh({ "GET /repos/me/x/pulls/7": pr() }));
  expect(fs).toEqual([]);
});

test("mergeable still being computed is not a conflict", async () => {
  // REST answers `mergeable: null` while GitHub works it out in the background.
  // Reading that as CONFLICTING would send an Engineer to rebase a branch that
  // merges perfectly well, every time a PR is polled right after a push.
  const h = harness();
  h.db.run("UPDATE grp SET pr_number = 7 WHERE id = 1");
  const fs = await pollPrs(h.ctx, gh({ "GET /repos/me/x/pulls/7": pr({ mergeable: null }) }));
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
    "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, 1, 'librarian', 'm', 'tok-lib', 0)",
  );
  const ins = h.db.prepare("INSERT INTO note (project_id, kind, lang, body, at) VALUES (1, 'lesson', 'zh', ?, ?)");
  for (let i = 0; i < LESSON_CAP; i++) ins.run(`lesson ${i}`, i);

  const r = await app(
    new Request("http://x/orch/journal", {
      method: "POST",
      body: JSON.stringify({ kind: "lesson", body: "the newest lesson" }),
      headers: { "content-type": "application/json", "x-orch-token": "tok-lib" },
    }),
  );
  expect(r.status).toBe(200);

  const rows = h.db.query<{ body: string }, []>("SELECT body FROM note WHERE kind = 'lesson' ORDER BY at DESC").all();
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

  const { landed } = require("../src/mech/flow/mergequeue.ts");
  landed(h.db, 1);

  const a = h.db
    .query<{ state: string; session_id: string | null; token: string | null }, []>(
      "SELECT state, session_id, token FROM agent",
    )
    .get()!;
  expect(a.state).toBe("retired");
  expect(a.session_id).toBeNull();
  // The token is revoked with the group, so a stale process cannot act as it.
  expect(a.token).toBeNull();
  expect(h.db.query<{ status: string }, []>("SELECT status FROM channel").get()!.status).toBe("archived");
  // Archiving must never mean deleting: a later group grepping this is the only
  // long-term memory the system has.
  expect(h.db.query<{ c: number }, []>("SELECT count(*) AS c FROM event").get()!.c).toBeGreaterThan(0);
});

test("read access is caught at registration, and it names the level", () => {
  // `viewerPermission: READ` in gh's projection is `permissions: {pull: true}` in
  // REST's, and the boss reads the same sentence either way. Naming the level is
  // what makes it actionable — "no push access" alone does not say what to ask
  // for. Discovering this when a branch is finished is the worst possible moment.
  const read = pushBlocked({ pull: true, push: false }, "me/x")!;
  expect(read).toContain("no push access");
  expect(read).toContain("READ");
  expect(pushBlocked({ pull: true, triage: true }, "me/x")).toContain("TRIAGE");

  // Anything that can push is silence.
  expect(pushBlocked({ push: true }, "me/x")).toBeNull();
  expect(pushBlocked({ admin: true }, "me/x")).toBeNull();
  expect(pushBlocked({ maintain: true }, "me/x")).toBeNull();

  // No permissions block at all is not evidence of anything, so it says nothing
  // rather than accusing a repository that answered a different question.
  expect(pushBlocked(undefined, "me/x")).toBeNull();
  expect(pushBlocked({}, "me/x")).toBeNull();
});

test("a branch that stopped merging wakes the Engineer, not the PM", async () => {
  // Nothing watched for this: a PR that went stale sat at PR_OPEN with an empty
  // queue, and the only way anyone found out was the boss opening GitHub.
  const h = harness();
  h.db.run("UPDATE grp SET pr_number = 7 WHERE id = 1");
  const stale = gh({ "GET /repos/me/x/pulls/7": pr({ mergeable: false, mergeable_state: "dirty" }) });
  const fs = await pollPrs(h.ctx, stale);
  expect(fs[0]!.conflicting).toBe(true);

  dispatchFeedback(h.ctx, fs[0]!);
  const p = JSON.parse(
    h.db.query<{ payload_json: string }, []>("SELECT payload_json FROM job ORDER BY id DESC LIMIT 1").get()!
      .payload_json,
  );
  // Reading a review and deciding what to concede is the PM's. `git rebase` is not.
  expect(p.role).toBe("engineer");
  expect(p.rejection).toContain("rebase");

  // Still conflicting on the next poll is not new news; the group is already on it.
  const again = await pollPrs(h.ctx, stale);
  expect(again).toHaveLength(0);
});

test("a PR that merged after its group was knocked back is still seen", async () => {
  // A group leaves PR_OPEN whenever anything sends the branch back — an Auditor
  // verdict, a review comment — while the PR itself stays live and mergeable. The
  // poll was keyed on the group's status, so a merge landing in that window was
  // invisible: grp16's PR went in, nothing wound the group up, and it kept hiring
  // turns for a branch already byte-identical to main. A pr_number is what is worth
  // polling on.
  const h = harness();
  h.db.run("UPDATE grp SET pr_number = 2, status = 'RUNNING' WHERE id = 1");
  // REST has no MERGED state: a merged PR is `closed` with `merged: true`, and
  // reading only `state` would file every merge as a close.
  const merged = gh({ "GET /repos/me/x/pulls/2": pr({ state: "closed", merged: true }) });
  const fs = await pollPrs(h.ctx, merged);
  expect(fs).toHaveLength(1);
  expect(fs[0]!.merged).toBe(true);

  // DISSOLVED is the one status that stops mattering: it has already been wound up.
  h.db.run("UPDATE grp SET status = 'DISSOLVED' WHERE id = 1");
  const gone = await pollPrs(h.ctx, merged);
  expect(gone).toHaveLength(0);
});

test("every pull request says what opened it", () => {
  // A reviewer deciding whether to trust a diff should know what produced it,
  // and a pull request that hides it is the kind of thing that gets a project
  // banned from a repository rather than asked about.
  //
  // One line, at the bottom, no badge — the body above it is already the
  // evidence, and DESIGN.md's rule holds here too: say it once.
  const h = harness();
  const body = prBody(h.ctx, 1);
  expect(body).toContain("https://github.com/pamin-labs/orchestrator");
  expect(body.split("\n").filter((l) => l.includes("orchestrator]("))).toHaveLength(1);
});

test("the message the Scribe files is the convention, enforced", () => {
  // Every rule here is one `roles/scribe.yaml` states, and it lists these four
  // refusals by name. A prompt that permits what the validator rejects teaches
  // the model to write something that gets thrown away — at the end of the only
  // turn it gets.
  const body = "The mount was empty inside the container and nothing said so.";
  expect(checkPrMessage("fix(sandbox): the skills mount was empty on macOS", body)).toBeNull();

  expect(checkPrMessage("update the mount path", body)).toContain("type prefix");
  expect(checkPrMessage(`fix(sandbox): ${"x".repeat(70)}`, body)).toContain("72");
  expect(checkPrMessage("fix(sandbox): the mount was empty.", body)).toContain("full stop");
  // The panel is Chinese, the journals are Chinese, and this is the one place
  // where the language has to stop being: it is read in somebody else's repo.
  expect(checkPrMessage("fix(sandbox): 挂载是空的", body)).toContain("English");
  expect(checkPrMessage("fix(sandbox): the mount was empty", "挂载是空的，什么都没说")).toContain("English");
  expect(checkPrMessage("fix(sandbox): the mount was empty", "fixed it")).toContain("one line is not that");
});

test("the commit gets the Scribe's message and the pull request gets the record", () => {
  // These were the same string: the squashed commit carried `## Slices (3, all
  // accepted)`, a gate table and `Opened by orchestrator` into `git log` — a
  // description written for a review page, pasted into the one place that
  // outlives it.
  const h = harness();
  h.db.run("UPDATE grp SET pr_title = ?, pr_summary = ? WHERE id = 1", [
    "fix(mailbox): the prefix check and the fetch read different strings",
    "One `if` guards the sandbox boundary and it compared the raw path.",
  ]);

  expect(prTitle(h.ctx, 1)).toStartWith("fix(mailbox):");
  const commit = commitMessage(h.ctx, 1, prTitle(h.ctx, 1));
  expect(commit).toContain("One `if` guards");
  expect(commit).not.toContain("Opened by");
  expect(commit).not.toContain("##");

  // The pull request keeps both, the Scribe's part first: it is the only section
  // written by something that read the diff.
  const body = prBody(h.ctx, 1);
  expect(body).toStartWith("One `if` guards");
  expect(body).toContain("Opened by");
});

test("with no Scribe message the branch is still publishable", () => {
  // The fallback, and the point of it: a finished branch sitting at the head of
  // a strictly serial merge queue stops every group behind it, so "nobody wrote
  // a title" may not be a reason to hold it. `orch:` is now the mark of that,
  // not the normal case it used to be for every PR this project opened.
  const h = harness();
  expect(prTitle(h.ctx, 1)).toBe("orch: g1");
  expect(commitMessage(h.ctx, 1, "orch: g1")).toBe("orch: g1");
});
