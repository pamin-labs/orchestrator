import { expect, test } from "bun:test";
import { extractClaimedFiles, reconcile } from "../src/mech/reconcile.ts";

test("the headline case: claimed work with an empty diff is rejected", () => {
  const r = reconcile({ claims: ["Moved the token check into auth/mw.ts"], changedFiles: [] });
  expect(r.pass).toBe(false);
  expect(r.reason).toContain("no changes at all");
  expect(r.phantom).toContain("auth/mw.ts");
});

test("a claim that matches the diff passes", () => {
  const r = reconcile({
    claims: [{ files: ["auth/mw.ts"], summary: "moved the check" }],
    changedFiles: ["auth/mw.ts"],
  });
  expect(r.pass).toBe(true);
  expect(r.phantom).toEqual([]);
});

test("one real file plus one invented file still fails", () => {
  const r = reconcile({
    claims: ["changed auth/mw.ts and auth/tokens.ts"],
    changedFiles: ["auth/mw.ts"],
  });
  expect(r.pass).toBe(false);
  expect(r.phantom).toEqual(["auth/tokens.ts"]);
});

test("extra changed files are reported, not treated as a failure", () => {
  const r = reconcile({
    claims: ["auth/mw.ts"],
    changedFiles: ["auth/mw.ts", "test/mw.test.ts", "bun.lock"],
  });
  // A test file and a lockfile turning up alongside the change is normal; the
  // reviewer should see them, but they are not a defect.
  expect(r.pass).toBe(true);
  expect(r.unclaimed.sort()).toEqual(["bun.lock", "test/mw.test.ts"]);
});

test("nothing claimed and nothing changed is a failure, not a pass", () => {
  const r = reconcile({ claims: [], changedFiles: [] });
  expect(r.pass).toBe(false);
  expect(r.reason).toContain("nothing was claimed");
});

test("a claim naming a file by its tail still matches git's full path", () => {
  const r = reconcile({ claims: ["mw.ts"], changedFiles: ["src/auth/mw.ts"] });
  expect(r.pass).toBe(true);
});

test("path extraction reads prose, arrays and nested objects alike", () => {
  expect(extractClaimedFiles(["edited src/a.ts, then src/b.tsx"]).sort()).toEqual([
    "src/a.ts",
    "src/b.tsx",
  ]);
  expect(extractClaimedFiles([{ files: ["docs/x.md"] }, ["nested/y.json"]]).sort()).toEqual([
    "docs/x.md",
    "nested/y.json",
  ]);
  expect(extractClaimedFiles(["a bare sentence with no paths"])).toEqual([]);
});

test("leading ./ and / do not create phantom mismatches", () => {
  expect(reconcile({ claims: ["./src/a.ts"], changedFiles: ["src/a.ts"] }).pass).toBe(true);
  expect(reconcile({ claims: ["src/a.ts"], changedFiles: ["./src/a.ts"] }).pass).toBe(true);
});
