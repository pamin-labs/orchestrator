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

const tree: Record<string, string[]> = {
  "": ["src", "web", "docs", ".git", "README.md"],
  src: ["auth", "ui", "db"],
  "src/auth": ["mw.ts", "tokens.ts"],
};
const listDir = (rel: string) => tree[rel] ?? [];

test("denial walks down the owned path, not just the top level", () => {
  const deny = denyOutsideOwns("/wt/g1", ["src/auth/**"], listDir);
  expect(deny).toContain("/wt/g1/web/**");
  expect(deny).toContain("/wt/g1/docs/**");
  // The case top-level-only denial missed, and the likeliest place to wander: a
  // sibling module one level in.
  expect(deny).toContain("/wt/g1/src/ui/**");
  expect(deny).toContain("/wt/g1/src/db/**");
  // Its own path stays writable at every level, and .git is never listed.
  expect(deny.some((d) => d.includes("/src/auth"))).toBe(false);
  expect(deny.some((d) => d === "/wt/g1/src/**")).toBe(false);
  expect(deny.some((d) => d.includes(".git"))).toBe(false);
});

test("files are denied as well as directories", () => {
  const deny = denyOutsideOwns("/wt/g1", ["src/auth/**"], listDir);
  // A stray edit to a top-level file is as unwanted as one to a sibling module.
  expect(deny).toContain("/wt/g1/README.md");
});

test("a wildcard stops the walk — everything below it is owned", () => {
  expect(denyOutsideOwns("/wt/g1", ["**/*.ts"], listDir)).toEqual([]);
  const src = denyOutsideOwns("/wt/g1", ["src/*"], listDir);
  expect(src).toContain("/wt/g1/web/**");
  // Nothing inside src is denied: the group owns all of it.
  expect(src.some((d) => d.includes("/src/"))).toBe(false);
});

test("two owned paths keep both branches writable", () => {
  const deny = denyOutsideOwns("/wt/g1", ["src/auth/**", "src/db/**"], listDir);
  expect(deny).toContain("/wt/g1/src/ui/**");
  expect(deny.some((d) => d.includes("/src/auth"))).toBe(false);
  expect(deny.some((d) => d.includes("/src/db"))).toBe(false);
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
