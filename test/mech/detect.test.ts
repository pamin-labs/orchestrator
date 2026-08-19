import { expect, test } from "bun:test";
import { detectGates, detectInstall, detectShared, type Root } from "../../src/mech/util/detect.ts";

/**
 * A repository root, as detection sees one.
 *
 * No temp directory any more: the repository these rules read is a clone inside
 * a container (007 §2), so `detect.ts` takes a listing and a reader rather than
 * a path — and these tests, which are the only cover these rules have, no longer
 * need a filesystem to state the same cases.
 */
const repo = (files: Record<string, string>): Root => ({
  names: Object.keys(files),
  read: (n) => files[n] ?? null,
});

test("a bun project gets test and typecheck, run with bun", () => {
  const dir = repo({
    "package.json": JSON.stringify({ scripts: { test: "bun test", lint: "eslint ." } }),
    "bun.lock": "",
    "tsconfig.json": "{}",
  });
  const g = detectGates(dir);
  expect(g.map((x) => x.name).sort()).toEqual(["lint", "test", "typecheck"]);
  // The runner is whatever the project actually uses, not whatever we prefer.
  expect(g.find((x) => x.name === "test")!.template).toBe("bun test");
});

test("an npm project without a bun lockfile uses npm", () => {
  const dir = repo({ "package.json": JSON.stringify({ scripts: { test: "jest" } }) });
  expect(detectGates(dir)[0]!.template).toBe("npm test");
});

test("rust, go, python and dotnet are each recognised", () => {
  expect(detectGates(repo({ "Cargo.toml": "[package]" })).map((g) => g.name)).toEqual(["test", "lint"]);
  expect(detectGates(repo({ "go.mod": "module x" })).map((g) => g.name)).toEqual(["test", "vet"]);
  expect(detectGates(repo({ "pyproject.toml": "[project]" }))[0]!.template).toBe("pytest -q");
  expect(detectGates(repo({ "app.csproj": "<Project/>" }))[0]!.template).toBe("dotnet test --nologo");
});

test("a Makefile counts only when it actually has a test target", () => {
  expect(detectGates(repo({ Makefile: "build:\n\tcc x.c\n" }))).toEqual([]);
  expect(detectGates(repo({ Makefile: "test:\n\t./run\n" }))[0]!.template).toBe("make test");
});

test("an unrecognised repo detects nothing rather than inventing a gate", () => {
  // Guessing a command that does not exist would fail every slice with a
  // confusing error instead of a clear "no gates" message.
  expect(detectGates(repo({ "README.md": "hi" }))).toEqual([]);
});

test("gate templates are single argv lines with no shell syntax", () => {
  for (const dir of [
    repo({ "Cargo.toml": "x" }),
    repo({ "go.mod": "x" }),
    repo({ "package.json": JSON.stringify({ scripts: { test: "x" } }) }),
  ]) {
    for (const g of detectGates(dir)) {
      expect(g.template).not.toMatch(/[;&|><$`]/);
    }
  }
});

test("workspace and lockfiles are detected as shared", () => {
  const dir = repo({ "package.json": JSON.stringify({ workspaces: ["packages/*"] }), "pnpm-workspace.yaml": "" });
  const shared = detectShared(dir);
  // Letting one group own the workspace root lets it break every other group.
  expect(shared).toContain("pnpm-workspace.yaml");
  expect(shared).toContain("packages/*/package.json");
});

test("the package.json workspace object uses its official packages field", () => {
  const objectForm = repo({ "package.json": JSON.stringify({ workspaces: { packages: ["apps/*"] } }) });
  const malformed = repo({ "package.json": JSON.stringify({ workspaces: { nope: true } }) });
  expect(detectShared(objectForm)).toContain("packages/*/package.json");
  expect(detectShared(malformed)).not.toContain("packages/*/package.json");
});

/**
 * Detection no longer runs at registration: a project is a GitHub repository and
 * there is no checkout to read until a group clones it (007 §2). These functions
 * are what that later pass calls, so they are tested on fixtures directly.
 */
test("no detected gate reaches for bunx or npx", () => {
  // `bunx tsc` re-resolves and installs on every call, and every worktree shares
  // one node_modules by symlink: two gates at once raced on it and one came back
  // `Failed to link jiti: EEXIST`. The group read that as its own build being
  // broken and burned five retries on it.
  const tree = repo({
    "package.json": JSON.stringify({ scripts: { test: "bun test", "build:web": "x", lint: "x" } }),
    "bun.lock": "",
    "tsconfig.json": "{}",
  });
  for (const r of detectGates(tree)) {
    expect(`${r.name}: ${r.template}`).not.toMatch(/\b(bunx|npx)\b/);
  }
});

test("every stack says how to install, or says it needs nothing", () => {
  // A worktree is a bare checkout and the agent cannot fix that: the sandbox
  // denies the writes an install needs, so `bun install` came back `EPERM failed
  // to link` and every gate failed for a reason the group did not cause. One
  // group sat on that blocker for hours.
  expect(detectInstall(repo({ "package.json": "{}", "bun.lock": "" }))).toBe("bun install --frozen-lockfile");
  expect(detectInstall(repo({ "package.json": "{}", "package-lock.json": "{}" }))).toBe("npm ci");
  expect(detectInstall(repo({ "go.mod": "module x\n" }))).toBe("go mod download");

  // pyproject.toml alone names no manager — poetry, pdm, hatch, rye and a plain
  // venv all use it — so it goes to the bootstrap role rather than to a guess.
  expect(detectInstall(repo({ "pyproject.toml": "[project]\n" }))).toBeNull();

  // cargo fetches on build: nothing up front, and that is an answer, not a gap.
  expect(detectInstall(repo({ "Cargo.toml": "[package]\n" }))).toBeNull();

  // An unknown stack must not guess.
  expect(detectInstall(repo({ "README.md": "hi" }))).toBeNull();
});
