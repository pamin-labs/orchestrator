import { expect, test } from "bun:test";
import { openMemory, type DB } from "../src/db.ts";
import {
  canStart,
  CLAIMING,
  WRITING,
  claimsShared,
  overlaps,
  outsideOwns,
  sharedFor,
  staticPrefix,
} from "../src/mech/flow/ownership.ts";
import { head, joinQueue, landed, position, queue } from "../src/mech/flow/mergequeue.ts";
import { reconcileOwnership } from "../src/runtime/executor.ts";
import { fakeSandbox } from "./fake-sandbox.ts";
import { testContext } from "./test-context.ts";

function seed(groups: Array<{ name: string; owns: string[]; status?: string }>): DB {
  const db = openMemory();
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  const ins = db.prepare(
    "INSERT INTO grp (project_id, name, status, owns_json, branch, created_at) VALUES (1, ?, ?, ?, ?, 0)",
  );
  for (const g of groups) {
    ins.run(g.name, g.status ?? "RUNNING", JSON.stringify(g.owns), `orch/${g.name}`);
  }
  return db;
}

test("static prefix stops at a path boundary, but a literal path is itself", () => {
  expect(staticPrefix("src/auth/**")).toBe("src/auth/");
  expect(staticPrefix("src/aut*")).toBe("src/");
  expect(staticPrefix("**/*.ts")).toBe("");
  // Trimming a wildcard-free path to its directory would make `package.json`
  // an empty prefix, and an empty prefix overlaps everything in the repo.
  expect(staticPrefix("src/auth/mw.ts")).toBe("src/auth/mw.ts");
  expect(staticPrefix("package.json")).toBe("package.json");
});

test("overlap is conservative — unsure means yes", () => {
  expect(overlaps("src/auth/**", "src/auth/mw.ts")).toBe(true);
  expect(overlaps("src/**", "src/ui/**")).toBe(true);
  expect(overlaps("**/*.ts", "docs/**")).toBe(true);
  expect(overlaps("src/auth/*.ts", "src/auth/*.test.ts")).toBe(true);

  // Genuinely disjoint trees may run together.
  expect(overlaps("src/auth/**", "src/ui/**")).toBe(false);
  expect(overlaps("docs/**", "src/**")).toBe(false);
  // `src/aut*` must not read as a prefix of `src/auth/`… but both live under
  // src/, so this still overlaps, and that is the safe answer.
  expect(overlaps("src/aut*", "src/authz/**")).toBe(true);
});

test("the only group in a project needs no boundary", () => {
  // Overlap is the criterion, and there is nothing here to overlap with.
  // Demanding a declaration anyway would be ceremony.
  expect(canStart(seed([{ name: "g1", owns: [] }]), 1).ok).toBe(true);
});

test("starting undeclared beside a group that HAS declared is refused", () => {
  const db = seed([
    { name: "auth", owns: ["src/auth/**"] },
    { name: "vague", owns: [] },
  ]);
  const r = canStart(db, 2);
  // An undeclared group silently claims everything, including their paths.
  expect(r.ok).toBe(false);
  expect(r.reason).toContain("auth");
  expect(r.reason).toContain("boundary");
});

test("two undeclared groups are allowed — two blanks cannot be shown to overlap", () => {
  const db = seed([
    { name: "a", owns: [] },
    { name: "b", owns: [] },
  ]);
  expect(canStart(db, 2).ok).toBe(true);
});

test("overlapping groups cannot run in parallel, and the message names both", () => {
  const db = seed([
    { name: "auth", owns: ["src/auth/**"] },
    { name: "authz", owns: ["src/auth/mw.ts"] },
  ]);
  const r = canStart(db, 2);
  expect(r.ok).toBe(false);
  expect(r.conflicts[0]!.name).toBe("auth");
  expect(r.reason).toContain("src/auth/mw.ts");
  expect(r.reason).toContain("Architect");
});

test("disjoint groups start together", () => {
  const db = seed([
    { name: "auth", owns: ["src/auth/**"] },
    { name: "ui", owns: ["src/ui/**", "web/**"] },
  ]);
  expect(canStart(db, 2).ok).toBe(true);
});

test("a finished group stops holding its paths", () => {
  const db = seed([
    { name: "old", owns: ["src/auth/**"], status: "DISSOLVED" },
    { name: "new", owns: ["src/auth/**"] },
  ]);
  expect(canStart(db, 2).ok).toBe(true);
});

test("a parked group still holds them — it is coming back", () => {
  const db = seed([
    { name: "parked", owns: ["src/auth/**"], status: "PARKED" },
    { name: "new", owns: ["src/auth/**"] },
  ]);
  expect(canStart(db, 2).ok).toBe(false);
});

test("shared files belong to no group", () => {
  const db = seed([{ name: "g1", owns: ["src/auth/**", "package.json"] }]);
  const r = canStart(db, 1);
  expect(r.ok).toBe(false);
  expect(r.sharedClaimed).toContain("package.json");
  expect(r.reason).toContain("no group");
});

test("a project may declare extra shared paths", () => {
  const db = seed([{ name: "g1", owns: ["proto/**"] }]);
  db.run("UPDATE project SET config_json = ? WHERE id = 1", [JSON.stringify({ shared: ["proto/**"] })]);
  expect(sharedFor(db, 1)).toContain("proto/**");
  expect(claimsShared(["proto/api.proto"], sharedFor(db, 1))).toHaveLength(1);
  expect(canStart(db, 1).ok).toBe(false);
});

// -------------------------------------------------------------- merge queue

test("branches merge in the order they passed audit", () => {
  const db = seed([
    { name: "a", owns: ["src/a/**"], status: "PR_OPEN" },
    { name: "b", owns: ["src/b/**"], status: "PR_OPEN" },
  ]);
  expect(joinQueue(db, 2)).toBe(1);
  expect(joinQueue(db, 1)).toBe(2);
  expect(queue(db, 1).map((e) => e.name)).toEqual(["b", "a"]);
  // Only the head is offered: three "ready to merge" cards invite the boss to
  // merge them in the wrong order.
  expect(head(db, 1)!.name).toBe("b");
});

test("joining twice keeps the original place in line", () => {
  const db = seed([{ name: "a", owns: ["src/a/**"], status: "PR_OPEN" }]);
  expect(joinQueue(db, 1)).toBe(1);
  expect(joinQueue(db, 1)).toBe(1);
});

test("a group knows where it is in line", () => {
  const db = seed([
    { name: "a", owns: ["src/a/**"], status: "PR_OPEN" },
    { name: "b", owns: ["src/b/**"], status: "PR_OPEN" },
  ]);
  joinQueue(db, 1);
  joinQueue(db, 2);
  expect(position(db, 2)).toEqual({ position: 2, total: 2 });
  expect(position(db, 1)).toEqual({ position: 1, total: 2 });
});

test("landing dissolves the group and returns who now needs a rebase", () => {
  const db = seed([
    { name: "a", owns: ["src/a/**"], status: "PR_OPEN" },
    { name: "b", owns: ["src/b/**"], status: "PR_OPEN" },
    { name: "c", owns: ["src/c/**"], status: "PR_OPEN" },
  ]);
  for (const id of [1, 2, 3]) joinQueue(db, id);

  const stale = landed(db, 1);
  // Their branch point is now behind main, and a stale base is what turns a
  // clean merge into a conflict later.
  expect(stale).toEqual([2, 3]);
  expect(db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()!.status).toBe("DISSOLVED");
  expect(head(db, 1)!.name).toBe("b");
});

test("a group not in the queue has no position", () => {
  const db = seed([{ name: "a", owns: ["src/a/**"] }]);
  expect(position(db, 1)).toBeNull();
  expect(head(db, 1)).toBeNull();
});

test("a group granted one shared path by name may start; everyone else still may not", () => {
  // Shared files belong to no group, and that must stay true — two groups editing
  // package.json is the collision ownership exists to prevent. But a defect in one
  // still has to be fixable, and the requirement opened for exactly that could
  // never start: the boundary can only be the file itself, which canStart then
  // refused as shared. sweepApproved retried that forever, silently.
  const db = seed([
    { name: "other", owns: ["src/a/**"] },
    { name: "fix-tsconfig", owns: ["tsconfig.json"], status: "DRAFT" },
    { name: "opportunist", owns: ["tsconfig.json"], status: "DRAFT" },
  ]);
  expect(canStart(db, 2).ok).toBe(false);

  db.run("UPDATE grp SET shared_grant = ? WHERE id = 2", [JSON.stringify(["tsconfig.json"])]);
  expect(canStart(db, 2).ok).toBe(true);
  // The grant is by name and by group: nobody else gets in on it.
  expect(canStart(db, 3).ok).toBe(false);
  expect(canStart(db, 3).sharedClaimed).toContain("tsconfig.json");
});

test("after-the-fact ownership catches a write outside the boundary", () => {
  // The container knows nothing about which group owns which file, so this rule
  // runs against `git status` once the turn is over. It is the only clock left.
  const owns = ["src/auth/**", "docs/auth.md"];
  const changed = [
    "src/auth/mw.ts", // owned, deep
    "docs/auth.md", // owned, exact
    "web/dist/app.js", // build output: the gate writes it for every group
    "src/db.ts", // NOT owned — a sibling one level in
    "package.json", // NOT owned — shared, and being shared is not permission
  ];
  expect(outsideOwns(changed, owns)).toEqual(["src/db.ts", "package.json"]);

  // `src/*` is one level, `src/**` is any depth.
  expect(outsideOwns(["src/a/b.ts"], ["src/*"])).toEqual(["src/a/b.ts"]);
  expect(outsideOwns(["src/a/b.ts"], ["src/**"])).toEqual([]);

  // The two the hand-written matcher got wrong, both in the direction that lets
  // a stray write stand: it ignored the extension after a `**` and treated any
  // `*` as unbounded depth. A file this rule fails to name is a file that is
  // never rolled back, and nothing anywhere else notices.
  expect(outsideOwns(["src/a/b.js"], ["src/a/**/*.ts"])).toEqual(["src/a/b.js"]);
  expect(outsideOwns(["src/a/b.ts"], ["src/a/**/*.ts"])).toEqual([]);
  expect(outsideOwns(["src/deep/nested/x.ts"], ["src/*.ts"])).toEqual(["src/deep/nested/x.ts"]);

  // And the one rule that is ours rather than the glob library's: a
  // wildcard-free entry is a directory claim. Agents write `owns: ["src/mech"]`
  // and mean everything under it.
  expect(outsideOwns(["src/mech/flow/gate.ts"], ["src/mech"])).toEqual([]);

  // A group that declared no boundary is not policed here: nothing to police it
  // against, and reverting everything it wrote is worse than reverting nothing.
  expect(outsideOwns(changed, [])).toEqual([]);
});

test("the revert actually runs, against the group's own checkout", async () => {
  // The rule was right and unreachable: the reconcile ran the HOST git runner
  // against `/work`, a path that exists only inside the container, so the one
  // mechanism enforcing file ownership after 005 threw on every turn. Nothing
  // asserted the wiring, only the pure function above it.
  const db = seed([{ name: "g1", owns: ["src/auth/**"] }]);
  // shq quotes every argument, so the command is `git 'status' '--porcelain' '-z'`,
  // and `-z` means the separator is NUL. The second status is the read-back: the
  // announcement is made from what is gone, not from what we tried to remove.
  const cwds: string[] = [];
  let statuses = 0;
  const sandbox = fakeSandbox((cmd, cwd) => {
    cwds.push(cwd);
    if (!cmd.includes("'status'")) return {};
    return { out: ++statuses === 1 ? " M src/auth/mw.ts\0?? web/stray.ts\0" : " M src/auth/mw.ts\0" };
  });
  const ctx = testContext({ db, sandbox });

  await reconcileOwnership(
    { ctx },
    { role: "engineer" },
    { grp_id: 1 },
    {
      owns_json: JSON.stringify(["src/auth/**"]),
    },
  );

  const ran = sandbox.commands.join("\n");
  // The group's own checkout, inside its container. There is no `/work` here.
  expect(new Set(cwds)).toEqual(new Set(["/work"]));
  expect(ran).toContain("'checkout' '--' 'web/stray.ts'");
  expect(ran).toContain("'clean' '-fd' '--' 'web/stray.ts'");
  // What it kept: the owned file is not in either repair command.
  expect(ran).not.toContain("src/auth/mw.ts");
  // Said out loud, or the agent watches its own work vanish.
  expect(
    ctx.bus
      .since(0)
      .map((event) => event.body)
      .join(" "),
  ).toContain("web/stray.ts");
});

test("a path git had to quote is still the path that gets rolled back", async () => {
  // `git status --porcelain` applies core.quotePath, which is on by default, so
  // any path outside ASCII — or merely containing a space — arrives as
  // `"docs/\\350\\256\\276\\350\\256\\241.md"`. That string matches no pathspec:
  // git answers `error: pathspec ... did not match any file(s)`, exits 1, changes
  // nothing. The exit code was not read, so the bus announced a revert that had
  // not happened — decision 005's last enforcement failing open and reporting
  // success, in a project whose output language is Chinese.
  const db = seed([{ name: "g1", owns: ["src/auth/**"] }]);
  let statuses = 0;
  const sandbox = fakeSandbox((cmd) => {
    if (!cmd.includes("'status'")) return {};
    return { out: ++statuses === 1 ? "?? docs/设计 稿.md\0" : "" };
  });
  const ctx = testContext({ db, sandbox });

  await reconcileOwnership(
    { ctx },
    { role: "engineer" },
    { grp_id: 1 },
    {
      owns_json: JSON.stringify(["src/auth/**"]),
    },
  );

  expect(sandbox.commands.join("\n")).toContain("'clean' '-fd' '--' 'docs/设计 稿.md'");
  expect(
    ctx.bus
      .since(0)
      .map((event) => event.body)
      .join(" "),
  ).toContain("docs/设计 稿.md");
});

test("a revert that changed nothing says so instead of claiming it worked", async () => {
  const db = seed([{ name: "g1", owns: ["src/auth/**"] }]);
  // Both status calls report the stray: git ran, git exited non-zero, the file
  // is still there.
  const sandbox = fakeSandbox((cmd) =>
    cmd.includes("'status'") ? { out: "?? web/stray.ts\0" } : { code: 1, out: "error: pathspec did not match" },
  );
  const ctx = testContext({ db, sandbox });

  await reconcileOwnership(
    { ctx },
    { role: "engineer" },
    { grp_id: 1 },
    {
      owns_json: JSON.stringify(["src/auth/**"]),
    },
  );

  const all = ctx.bus
    .since(0)
    .map((event) => event.body)
    .join(" ");
  expect(all).toContain("could not roll back");
  expect(all).toContain("web/stray.ts");
});

test("a DRAFT group owns its paths for the boundary check, and blocks nobody's start", () => {
  // Two questions, and they had been sharing one hardcoded status list per call
  // site — four sites, three different lists. A DRAFT group has declared paths
  // (`newGroup` populates owns_json at insert) but holds no worktree, so it must
  // count for "who claimed this" and must not count for "who is writing".
  expect(CLAIMING).toContain("DRAFT");
  expect(CLAIMING).toContain("PLANNING");
  expect(CLAIMING).not.toContain("DISSOLVED");
  expect(WRITING).not.toContain("DRAFT");
  expect(WRITING).not.toContain("PLANNING");

  // The direction that would have deadlocked: two unstarted groups on the same
  // path. Neither is writing, so approving either one still starts it — and the
  // second is refused then, because by that point the first is RUNNING.
  const db = seed([
    { name: "a", owns: ["src/x/**"], status: "DRAFT" },
    { name: "b", owns: ["src/x/**"], status: "DRAFT" },
  ]);
  expect(canStart(db, 1).ok).toBe(true);
  db.run("UPDATE grp SET status = 'RUNNING' WHERE id = 1");
  expect(canStart(db, 2).ok).toBe(false);
});
