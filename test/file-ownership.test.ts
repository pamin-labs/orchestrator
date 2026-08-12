import { expect, test } from "bun:test";
import { openMemory, type DB } from "../src/db.ts";
import {
  canStart,
  claimsShared,
  denyOutsideOwns,
  overlaps,
  sharedFor,
  staticPrefix,
} from "../src/mech/ownership.ts";
import { head, joinQueue, landed, position, queue } from "../src/mech/mergequeue.ts";

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

test("denyWrite is generated for the top-level dirs a group does not own", () => {
  const deny = denyOutsideOwns("/wt/g1", ["src/auth/**"], ["src", "web", "docs", ".git"]);
  expect(deny).toContain("/wt/g1/web/**");
  expect(deny).toContain("/wt/g1/docs/**");
  // Its own tree stays writable, and .git is never listed.
  expect(deny.some((d) => d.includes("/src/"))).toBe(false);
  expect(deny.some((d) => d.includes(".git"))).toBe(false);
});

test("a group owning a repo-wide glob gets no extra denies", () => {
  expect(denyOutsideOwns("/wt/g1", ["**/*.ts"], ["src", "web"])).toEqual([]);
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
