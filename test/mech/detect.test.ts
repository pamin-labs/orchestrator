import { expect, test } from "bun:test";
import { detectGates, detectInstall, detectShared, type Root, WORKFLOWS } from "../../src/mech/util/detect.ts";

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

/**
 * A repository with a workflow, as detection sees one: the root listing, plus one
 * directory it may list and read from.
 */
const withCi = (files: Record<string, string>, workflows: Record<string, string>): Root => ({
  names: Object.keys(files),
  read: (n) => files[n] ?? workflows[n.replace(`${WORKFLOWS}/`, "")] ?? null,
  list: (dir) => (dir === WORKFLOWS ? Object.keys(workflows) : []),
});

/**
 * The stacks no rule knows are the ones that used to get nothing at all — and
 * "no gates" is not "no opinion", it fails every slice (`gate.ts`). A workflow is
 * the one place any language writes down what a clean machine runs.
 */
test("a stack no rule knows takes its gates from what CI runs", () => {
  const g = detectGates(
    withCi(
      { "mix.exs": "defmodule X", "README.md": "" },
      {
        "ci.yml": `name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: mix deps.get
      - name: 跑测试
        run: mix test
      - run: mix format --check-formatted`,
      },
    ),
  );
  expect(g.map((x) => x.name)).toEqual(["lint", "test"]);
  expect(g.find((x) => x.name === "test")!.template).toBe("mix test");
  // Classified by the command, not the step's `name:` — that is prose, in
  // whatever language the author wrote it in.
  expect(g.find((x) => x.name === "lint")!.template).toBe("mix format --check-formatted");
});

/**
 * `lease.ts` tokenises a template on whitespace and never runs a shell, so `a &&
 * b` would hand `&&` to `a` as an argument: a gate that looks like it ran and did
 * half of nothing. A `${{ … }}` only the CI runner can expand is the same class.
 */
test("a CI step that could not be a template is not taken as one", () => {
  const g = detectGates(
    withCi(
      { "dune-project": "(lang dune 3.0)" },
      {
        "ci.yml": `jobs:
  t:
    steps:
      - run: make deps && make test
      - run: dune test --profile \${{ matrix.profile }}
      - run: dune runtest`,
      },
    ),
  );
  expect(g.map((x) => x.template)).toEqual(["dune runtest"]);
});

/**
 * A recognised stack keeps its convention. A CI step is written for a machine
 * that has the services CI starts — this repository's own `bun run test` needs a
 * PostgreSQL container — so preferring it would trade "no gate" for "a gate that
 * cannot pass", which is worse: the first is visible, the second reads as the
 * agent's fault.
 */
test("a recognised stack is not overridden by its workflow", () => {
  const g = detectGates(
    withCi(
      { "package.json": JSON.stringify({ scripts: { test: "bun test" } }), "bun.lock": "" },
      { "ci.yml": `jobs:\n  t:\n    steps:\n      - run: bun run test:ci` },
    ),
  );
  expect(g.find((x) => x.name === "test")!.template).toBe("bun test");
});

/** No workflows, an unparseable one, and a caller that cannot list: all silent. */
test("nothing to read from CI leaves the project as it was", () => {
  expect(detectGates(withCi({ "mix.exs": "x" }, {}))).toEqual([]);
  expect(detectGates(withCi({ "mix.exs": "x" }, { "ci.yml": "jobs: [oops\n  - :" }))).toEqual([]);
  expect(detectGates(repo({ "mix.exs": "x" }))).toEqual([]);
});

/**
 * The two things a name-shaped guess gets wrong, both measured against this
 * repository's own workflows before they were fixed.
 *
 * `check` in the test vocabulary took `i18n:check` as the test gate. And "first
 * match in file order" took `format:check` as lint, with `bun run lint` further
 * down the same file — so a command that *ends* in the gate's own name wins over
 * one that merely mentions it.
 */
test("the command named for the gate beats the one that only mentions it", () => {
  const g = detectGates(
    withCi(
      { "shard.yml": "name: x" },
      {
        "ci.yml": `jobs:
  t:
    steps:
      - run: bun run format:check
      - run: bun run i18n:check
      - run: bun run lint
      - run: bun run test`,
      },
    ),
  );
  expect(Object.fromEntries(g.map((x) => [x.name, x.template]))).toEqual({
    lint: "bun run lint",
    test: "bun run test",
  });
});
