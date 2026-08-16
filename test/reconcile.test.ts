import { expect, test } from "bun:test";
import { extractClaimedFiles, reconcile, TaskClaimSchema } from "../src/mech/flow/reconcile.ts";

test("a scratch file created and deleted inside the slice is not a lie", () => {
  // Observed: the Engineer removed its own debug script and said so. Never
  // committed, so not in the diff; deleted, so not untracked either — and the
  // honest report was scored as a phantom claim twice in a row.
  const r = reconcile({
    claims: [{ files: ["tmp_probe4.mjs", "src/api.ts"], summary: "remove stray debug script" }],
    changedFiles: ["src/api.ts"],
    absent: ["tmp_probe4.mjs"],
  });
  expect(r.pass).toBe(true);
  expect(r.ignored).toEqual(["tmp_probe4.mjs"]);
});

test("a claim made entirely of paths that never existed still fails", () => {
  // Dropping them must not become the way to pass with nothing: git cannot tell an
  // invented path from a deleted scratch file, so neither counts as a delivery.
  const r = reconcile({
    claims: [{ files: ["src/invented.ts"], summary: "did the thing" }],
    changedFiles: [],
    absent: ["src/invented.ts"],
  });
  expect(r.pass).toBe(false);
});

test("the headline case: claimed work with an empty diff is rejected", () => {
  const r = reconcile({
    claims: [{ files: ["auth/mw.ts"], summary: "Moved the token check" }],
    changedFiles: [],
  });
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
    claims: [{ files: ["auth/mw.ts", "auth/tokens.ts"], summary: "changed authentication" }],
    changedFiles: ["auth/mw.ts"],
  });
  expect(r.pass).toBe(false);
  expect(r.phantom).toEqual(["auth/tokens.ts"]);
});

test("extra changed files are reported, not treated as a failure", () => {
  const r = reconcile({
    claims: [{ files: ["auth/mw.ts"], summary: "changed authentication" }],
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
  const r = reconcile({
    claims: [{ files: ["mw.ts"], summary: "changed middleware" }],
    changedFiles: ["src/auth/mw.ts"],
  });
  expect(r.pass).toBe(true);
});

test("task claims take paths only from their validated files field", () => {
  expect(extractClaimedFiles([{ files: ["docs/x.md"], summary: "mentions invented/y.ts" }])).toEqual(["docs/x.md"]);
  expect(TaskClaimSchema.safeParse({ files: ["docs/x.md"] }).success).toBe(false);
  expect(TaskClaimSchema.safeParse({ files: [], summary: "nothing" }).success).toBe(false);
  expect(TaskClaimSchema.safeParse("edited src/a.ts").success).toBe(false);
});

test("leading ./ and / do not create phantom mismatches", () => {
  expect(reconcile({ claims: [{ files: ["./src/a.ts"], summary: "x" }], changedFiles: ["src/a.ts"] }).pass).toBe(true);
  expect(reconcile({ claims: [{ files: ["src/a.ts"], summary: "x" }], changedFiles: ["./src/a.ts"] }).pass).toBe(true);
});

test("a declared no-op passes reconcile when nothing changed", () => {
  // Real case from the first multi-slice live run: the Engineer implemented the
  // whole feature while working slice 1, so slices 2 and 3 had nothing left. That
  // sent a correct branch back three times and then escalated.
  const r = reconcile({
    claims: [{ already_done: "S1 already added the zh branch" }],
    changedFiles: [],
  });
  expect(r.pass).toBe(true);
  expect(r.reason).toContain("already done");
});

test("a no-op claim alongside real changes is still reconciled normally", () => {
  const r = reconcile({
    claims: [{ already_done: "partly covered" }, { files: ["src/a.ts"], summary: "remaining change" }],
    changedFiles: ["src/a.ts"],
  });
  expect(r.pass).toBe(true);
  const phantom = reconcile({
    claims: [{ already_done: "x" }, { files: ["src/never.ts"], summary: "invented change" }],
    changedFiles: ["src/a.ts"],
  });
  // "Already done" is not a blanket exemption: a false file claim still fails.
  expect(phantom.pass).toBe(false);
  expect(phantom.phantom).toEqual(["src/never.ts"]);
});

test("the schema rejects empty and ambiguous completion accounts", () => {
  expect(TaskClaimSchema.safeParse({ already_done: "   " }).success).toBe(false);
  expect(TaskClaimSchema.safeParse({ files: ["a.ts"] }).success).toBe(false);
  expect(TaskClaimSchema.safeParse({ already_done: "x", files: ["a.ts"], summary: "x" }).success).toBe(false);
});
