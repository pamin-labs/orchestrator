import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectGates, detectInstall, detectShared } from "../src/mech/detect.ts";
import { Bus } from "../src/bus.ts";
import { loadConfig } from "../src/config.ts";
import { openMemory } from "../src/db.ts";
import { RepoLock } from "../src/mech/gitlock.ts";
import { Scheduler } from "../src/scheduler.ts";
import { makeApp, type Ctx } from "../src/api.ts";
import { gatesFor } from "../src/mech/gate.ts";
import { fakeSandbox } from "./fake-sandbox.ts";
import { seedAuth } from "./seed-auth.ts";

const repo = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "orch-det-"));
  for (const [name, body] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  }
  // Registration requires a real repo: every group needs a worktree, so a path
  // without `.git` is refused before the project exists.
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
};

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

test("registering a project wires its gates and resources with no manual SQL", async () => {
  const dir = repo({ "Cargo.toml": "[package]" });
  const db = openMemory();
  seedAuth(db);
  const cfg = loadConfig();
  const ctx: Ctx = {
    db,
    bus: new Bus(db),
    sched: new Scheduler(db, async () => {}),
    gitLock: new RepoLock(),
    sandbox: fakeSandbox(), waiters: new Map(),
    config: { language: "中文", workRoot: "/tmp/x" },
  };
  const app = makeApp(ctx);

  const r = await app(
    new Request("http://x/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "rusty", repo_path: dir }),
    }),
  );
  const out = (await r.json()) as { id: number; gates: string[] };
  expect(out.gates).toEqual(["test", "lint"]);
  expect(gatesFor(db, out.id)).toEqual(["test", "lint"]);
  // The resource templates exist too, or the gate names would point at nothing.
  expect(db.query<{ c: number }, []>("SELECT count(*) AS c FROM resource").get()!.c).toBe(2);
});

test("a project with nothing detectable says so instead of failing silently later", async () => {
  const dir = repo({ "README.md": "hi" });
  const db = openMemory();
  const cfg = loadConfig();
  const ctx: Ctx = {
    db,
    bus: new Bus(db),
    sched: new Scheduler(db, async () => {}),
    gitLock: new RepoLock(),
    sandbox: fakeSandbox(), waiters: new Map(),
    config: { language: "中文", workRoot: "/tmp/x" },
  };
  const r = await makeApp(ctx)(
    new Request("http://x/api/projects", { method: "POST", body: JSON.stringify({ name: "plain", repo_path: dir }) }),
  );
  expect(((await r.json()) as any).gates).toEqual([]);
  const esc = db.query<{ body: string }, []>("SELECT body FROM event WHERE kind = 'escalation'").get()!;
  expect(esc.body).toContain("no gates detected");
});

test("no detected gate reaches for bunx or npx", () => {
  // `bunx tsc` re-resolves and installs on every call, and every worktree shares
  // one node_modules by symlink: two gates at once raced on it and one came back
  // `Failed to link jiti: EEXIST`. The group read that as its own build being
  // broken and burned five retries on it.
  const repo = mkdtempSync(join(tmpdir(), "orch-detect-"));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "bun test", "build:web": "x", lint: "x" } }));
  writeFileSync(join(repo, "bun.lock"), "");
  writeFileSync(join(repo, "tsconfig.json"), "{}");
  for (const r of detectGates(repo)) {
    expect(`${r.name}: ${r.template}`).not.toMatch(/\b(bunx|npx)\b/);
  }
});

test("every stack says how to install, or says it needs nothing", () => {
  // A worktree is a bare checkout and the agent cannot fix that: the sandbox
  // denies the writes an install needs, so `bun install` came back `EPERM failed
  // to link` and every gate failed for a reason the group did not cause. One
  // group sat on that blocker for hours.
  const bun = mkdtempSync(join(tmpdir(), "orch-i-"));
  writeFileSync(join(bun, "package.json"), "{}");
  writeFileSync(join(bun, "bun.lock"), "");
  expect(detectInstall(bun)).toBe("bun install --frozen-lockfile");

  const npm = mkdtempSync(join(tmpdir(), "orch-i-"));
  writeFileSync(join(npm, "package.json"), "{}");
  writeFileSync(join(npm, "package-lock.json"), "{}");
  expect(detectInstall(npm)).toBe("npm ci");

  const go = mkdtempSync(join(tmpdir(), "orch-i-"));
  writeFileSync(join(go, "go.mod"), "module x\n");
  expect(detectInstall(go)).toBe("go mod download");

  // pyproject.toml alone names no manager — poetry, pdm, hatch, rye and a plain
  // venv all use it — so it goes to the bootstrap role rather than to a guess.
  const py = mkdtempSync(join(tmpdir(), "orch-i-"));
  writeFileSync(join(py, "pyproject.toml"), "[project]\n");
  expect(detectInstall(py)).toBeNull();

  // cargo fetches on build: nothing up front, and that is an answer, not a gap.
  const rust = mkdtempSync(join(tmpdir(), "orch-i-"));
  writeFileSync(join(rust, "Cargo.toml"), "[package]\n");
  expect(detectInstall(rust)).toBeNull();

  // An unknown stack must not guess.
  expect(detectInstall(mkdtempSync(join(tmpdir(), "orch-i-")))).toBeNull();
});
