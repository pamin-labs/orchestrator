import { expect, test } from "bun:test";
import { Bus } from "../src/bus.ts";
import { openMemory, type DB } from "../src/db.ts";
import { Scheduler } from "../src/scheduler.ts";
import { RepoLock } from "../src/mech/gitlock.ts";
import type { Ctx } from "../src/api.ts";
import { detectProject } from "../src/mech/start.ts";
import { gatesFor } from "../src/mech/gate.ts";
import { fakeSandbox } from "./fake-sandbox.ts";
import { seedAuth } from "./seed-auth.ts";

/**
 * Detection runs once, from the first clone, inside the group's container.
 *
 * It used to run when the project was registered, against a checkout on the
 * host — and for the window between those two facts nothing wrote `resource` at
 * all, so a group reached its first gate and there was no such resource. These
 * assert the pass exists at the new place and stays once-per-project.
 */
function harness(files: Record<string, string>) {
  const db: DB = openMemory();
  seedAuth(db);
  const asked: string[] = [];
  const ctx: Ctx = {
    db,
    bus: new Bus(db),
    sched: new Scheduler(db, async () => {}),
    gitLock: new RepoLock(),
    waiters: new Map(),
    // The container answers exactly what a shell would: a listing, the files
    // detection opens, and whether the browser runner is there.
    sandbox: fakeSandbox((cmd) => {
      asked.push(cmd);
      if (cmd.startsWith("ls -A")) return { out: Object.keys(files).join("\n") };
      const cat = /^cat '\/work\/([^']+)'$/.exec(cmd);
      if (cat) return files[cat[1]!] !== undefined ? { out: files[cat[1]!]! } : { code: 1 };
      if (cmd.startsWith("test -f")) return files["scripts/browse.ts"] !== undefined ? { out: "yes" } : { code: 1 };
      return {};
    }),
    config: { language: "中文" },
  } as unknown as Ctx;

  db.run(
    `INSERT INTO project (name, repo_path, remote, config_json, created_at)
     VALUES ('p', 'acme/p', 'https://github.com/acme/p.git', '{"gates":[]}', 0)`,
  );
  db.run("INSERT INTO grp (project_id, name, status, created_at) VALUES (1, 'g1', 'RUNNING', 0)");
  db.run("INSERT INTO grp (project_id, name, status, created_at) VALUES (1, 'g2', 'RUNNING', 0)");
  return { db, ctx, asked };
}

const config = (db: DB): any => JSON.parse(db.query<{ config_json: string }, []>("SELECT config_json FROM project").get()!.config_json);
const resources = (db: DB) =>
  db.query<{ name: string; template: string; tags_json: string }, []>("SELECT name, template, tags_json FROM resource ORDER BY name").all();

test("the first clone is what works out the gates, the install command and the shared paths", async () => {
  const h = harness({
    "package.json": JSON.stringify({ scripts: { test: "bun test", lint: "eslint ." }, workspaces: ["packages/*"] }),
    "bun.lock": "",
    "tsconfig.json": "{}",
    "scripts/browse.ts": "",
  });

  await detectProject(h.ctx, 1, 1);

  // The resource templates, which is the half that had no writer at all: gate
  // names in project config point at nothing without these rows.
  expect(resources(h.db).map((r) => r.name)).toEqual(["browser", "lint", "test", "typecheck"]);
  expect(resources(h.db).find((r) => r.name === "test")!.template).toBe("bun test");
  // One gate at a time per repository — they run the project's own scripts, and
  // two installs at once raced on one node_modules.
  expect(JSON.parse(resources(h.db).find((r) => r.name === "lint")!.tags_json)).toEqual(["repo"]);
  // Its own pool: each browser lease is a real Chromium.
  expect(JSON.parse(resources(h.db).find((r) => r.name === "browser")!.tags_json)).toEqual(["browser"]);

  // And the project config, where the boss can correct any of it.
  const cfg = config(h.db);
  expect(cfg.gates.sort()).toEqual(["lint", "test", "typecheck"]);
  expect(gatesFor(h.db, 1).sort()).toEqual(["lint", "test", "typecheck"]);
  expect(cfg.install).toBe("bun install --frozen-lockfile");
  expect(cfg.shared).toContain("packages/*/package.json");

  // Read from the container, never from a host path.
  expect(h.asked.some((c) => c.startsWith("ls -A '/work'"))).toBe(true);
  expect(h.asked.some((c) => c === "cat '/work/package.json'")).toBe(true);
  // Only the files a rule actually opens: existence answers everything else.
  expect(h.asked.filter((c) => c.startsWith("cat "))).toEqual(["cat '/work/package.json'"]);
});

test("the second group does not detect again, and does not duplicate a resource row", async () => {
  const h = harness({ "Cargo.toml": "[package]" });

  await detectProject(h.ctx, 1, 1);
  expect(resources(h.db).map((r) => r.name)).toEqual(["lint", "test"]);
  const before = h.asked.length;

  // Marked by `config.detected`, not by "are there gates yet": a project where
  // detection finds nothing must not re-run for every group forever.
  await detectProject(h.ctx, 2, 1);
  expect(h.asked.length).toBe(before);
  expect(resources(h.db).map((r) => r.name)).toEqual(["lint", "test"]);

  // A boss who corrected the gates keeps their answer.
  h.db.run(`UPDATE project SET config_json = '{"gates":["mine"],"detected":true}'`);
  await detectProject(h.ctx, 2, 1);
  expect(config(h.db).gates).toEqual(["mine"]);
});

test("a repository with nothing detectable says so instead of failing silently later", async () => {
  // The warning registration used to give. Without it the first slice fails at a
  // gate that was never configured, which reads as the project being broken.
  const h = harness({ "README.md": "hi" });
  await detectProject(h.ctx, 1, 1);

  expect(resources(h.db)).toEqual([]);
  expect(config(h.db).gates).toEqual([]);
  // Still marked, so the second group does not ask the same question again.
  expect(config(h.db).detected).toBe(true);

  const esc = h.db.query<{ body: string; kind: string }, []>("SELECT body, kind FROM event ORDER BY seq DESC").get()!;
  expect(esc.kind).toBe("escalation");
  expect(esc.body).toContain("no gates detected");
});
