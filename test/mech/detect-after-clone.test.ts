import { expect, test } from "bun:test";
import { z } from "zod";
import type { Json } from "../../src/contracts/json.ts";
import { asc, desc } from "drizzle-orm";
import { openMemory, type DB } from "../../src/platform/persistence/database.ts";
import { event, project, resource } from "../../src/platform/persistence/schema.ts";
import { detectProject } from "../../src/mech/flow/start.ts";
import { gatesFor } from "../../src/mech/gate.ts";
import { projectConfig } from "../../src/mech/util/rows.ts";
import * as fx from "../support/factories.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";
import { seedAuth } from "../support/seed-auth.ts";
import { testContext } from "../support/test-context.ts";

/**
 * Detection runs once, from the first clone, inside the group's container.
 *
 * It used to run when the project was registered, against a checkout on the
 * host — and for the window between those two facts nothing wrote `resource` at
 * all, so a group reached its first gate and there was no such resource. These
 * assert the pass exists at the new place and stays once-per-project.
 */
async function harness(files: Record<string, string>) {
  const db = await openMemory();
  const f = fx.on(db);
  await seedAuth(db);
  const asked: string[] = [];
  const ctx = await testContext({
    db,
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
  });

  const p = await f.project.create({
    name: "p",
    repo_path: "acme/p",
    remote: "https://github.com/acme/p.git",
    config_json: { gates: [] },
  });
  for (const name of ["g1", "g2"]) await f.runningGrp.create({ project_id: p.id, name });
  return { db, ctx, asked };
}

const config = (db: DB) => projectConfig(db, 1);
const storedDetection = async (db: DB) =>
  z
    .looseObject({ detected: z.boolean(), gates: z.array(z.string()) })
    .parse((await db.select({ config_json: project.config_json }).from(project))[0]!.config_json);
const resources = (db: DB) =>
  db
    .select({ name: resource.name, template: resource.template, tags_json: resource.tags_json })
    .from(resource)
    .orderBy(asc(resource.name));

test("the first clone is what works out the gates, the install command and the shared paths", async () => {
  const h = await harness({
    "package.json": JSON.stringify({ scripts: { test: "bun test", lint: "eslint ." }, workspaces: ["packages/*"] }),
    "bun.lock": "",
    "tsconfig.json": "{}",
    "scripts/browse.ts": "",
  });

  await detectProject(h.ctx, 1, 1);

  // The resource templates, which is the half that had no writer at all: gate
  // names in project config point at nothing without these rows.
  const rows = await resources(h.db);
  expect(rows.map((r) => r.name)).toEqual(["browser", "lint", "test", "typecheck"]);
  expect(rows.find((r) => r.name === "test")!.template).toBe("bun test");
  // One gate at a time per repository — they run the project's own scripts, and
  // two installs at once raced on one node_modules.
  expect(rows.find((r) => r.name === "lint")!.tags_json).toEqual(["repo"]);
  // Its own pool: each browser lease is a real Chromium.
  expect(rows.find((r) => r.name === "browser")!.tags_json).toEqual(["browser"]);

  // And the project config, where the boss can correct any of it.
  const cfg = await config(h.db);
  expect(cfg.gates?.sort()).toEqual(["lint", "test", "typecheck"]);
  expect((await gatesFor(h.db, 1)).sort()).toEqual(["lint", "test", "typecheck"]);
  expect(cfg.install).toBe("bun install --frozen-lockfile");
  expect(cfg.shared).toContain("packages/*/package.json");

  // Read from the container, never from a host path.
  expect(h.asked.some((c) => c.startsWith("ls -A '/work'"))).toBe(true);
  expect(h.asked).toContain("cat '/work/package.json'");
  // Only the files a rule actually opens: existence answers everything else.
  expect(h.asked.filter((c) => c.startsWith("cat "))).toEqual(["cat '/work/package.json'"]);
});

test("the second group does not detect again, and does not duplicate a resource row", async () => {
  const h = await harness({ "Cargo.toml": "[package]" });

  await detectProject(h.ctx, 1, 1);
  expect((await resources(h.db)).map((r) => r.name)).toEqual(["lint", "test"]);
  const before = h.asked.length;

  // Marked by `config.detected`, not by "are there gates yet": a project where
  // detection finds nothing must not re-run for every group forever.
  await detectProject(h.ctx, 2, 1);
  expect(h.asked.length).toBe(before);
  expect((await resources(h.db)).map((r) => r.name)).toEqual(["lint", "test"]);

  // A boss who corrected the gates keeps their answer.
  await h.db.update(project).set({ config_json: { gates: ["mine"], detected: true } });
  await detectProject(h.ctx, 2, 1);
  expect((await config(h.db)).gates).toEqual(["mine"]);
});

for (const [name, stored, gates] of [
  ["detected", { detected: "true", gates: ["mine"] }, ["mine"]],
  ["gates", { detected: true, gates: "test" }, ["test", "lint"]],
] satisfies [string, Json, string[]][]) {
  test(`malformed ${name} is repaired without dropping unknown config`, async () => {
    const h = await harness({ "Cargo.toml": "[package]" });
    await h.db.update(project).set({ config_json: { ...stored, migration: { version: 7 } } });

    await detectProject(h.ctx, 1, 1);

    expect(h.asked.length).toBeGreaterThan(0);
    expect(await storedDetection(h.db)).toMatchObject({ detected: true, gates, migration: { version: 7 } });
  });
}

test("a repository with nothing detectable says so instead of failing silently later", async () => {
  // The warning registration used to give. Without it the first slice fails at a
  // gate that was never configured, which reads as the project being broken.
  const h = await harness({ "README.md": "hi" });
  await detectProject(h.ctx, 1, 1);

  expect(await resources(h.db)).toEqual([]);
  expect((await config(h.db)).gates).toEqual([]);
  // Still marked, so the second group does not ask the same question again.
  expect((await config(h.db)).detected).toBe(true);

  const [esc] = await h.db.select({ body: event.body, kind: event.kind }).from(event).orderBy(desc(event.seq)).limit(1);
  expect(esc!.kind).toBe("escalation");
  expect(esc!.body).toContain("no gates detected");
});
