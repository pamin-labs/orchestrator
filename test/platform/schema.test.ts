import { expect, test } from "bun:test";
import { SQL } from "bun";
import { errText } from "../../src/platform/process/text.ts";
import { z } from "zod";
import { valueOr } from "../../src/contracts/json.ts";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../../src/platform/config/load.ts";
import { applyMigrations, open, openMemory } from "../../src/platform/persistence/database.ts";
import { escalation, event, project } from "../../src/platform/persistence/schema.ts";
import { escalationKey } from "../../src/mech/flow/escalate.ts";
import * as fx from "../support/factories.ts";

/**
 * `execute()` types its rows as `unknown` on the shared `DB`, so this validates
 * rather than asserts. One engine now serves tests and production, so the shape
 * a test sees is the shape a deployment gets — which was not true while the
 * suite ran on a second engine that returned `{rows, …}` where this one returns
 * an array.
 */
const Introspection = z.array(z.object({ table_name: z.string() }));

const tableNames = async () => {
  const db = await openMemory();
  const rows = await db.execute(
    // `pg_catalog`, not `information_schema`: the suite shares one database across
    // 193 namespaces, and those views join over every relation in it.
    sql`SELECT c.relname AS table_name FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relkind = 'r'`,
  );
  return valueOr(rows, Introspection, []).map((r) => r.table_name);
};

test("the schema has the four first-class tables plus support tables", async () => {
  const names = await tableNames();
  for (const t of ["job", "event", "note", "task", "slice"]) expect(names).toContain(t);
  for (const t of ["project", "grp", "agent", "channel", "member", "cursor"]) expect(names).toContain(t);
  for (const t of ["resource", "lease", "escalation"]) expect(names).toContain(t);

  // Deliberately absent: mail folded into `event`; facts/journal/decision/retro
  // folded into `note`. Re-adding them means the abstraction drifted.
  expect(names).not.toContain("mail");
  expect(names).not.toContain("journal");
});

/**
 * A second boot must not re-run the schema.
 *
 * Every deployment migrates on start, so this runs on every restart forever.
 * Drizzle decides applied-versus-pending by folder name against its own journal
 * table, which is one more thing to get wrong than the version integer this
 * replaces — and getting it wrong means a restart failing on `CREATE TABLE`.
 */
test("migrating a database that is already migrated changes nothing", async () => {
  // A real database, not this file's namespace: the suite builds a namespace by
  // replaying the SQL and keeps no ledger, so the thing under test — the migrator
  // deciding it has nothing to apply — only exists on the path a deployment takes.
  // That is the state every restart finds, and it is `open()` that finds it.
  const url =
    process.env["ORCH_TEST_DATABASE_URL"] ?? "postgres://orchestrator:orchestrator@127.0.0.1:5433/orchestrator";
  const probe = "orch_test_migrate_twice";
  const admin = new SQL({ url, max: 1 });
  const on = new URL(`/${probe}`, url).toString();
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${probe}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${probe}"`);
    const db = await open(1, on);
    const Count = z.array(z.object({ n: z.number() }));
    const applied = async () =>
      valueOr(await db.execute(sql`SELECT count(*)::int AS n FROM drizzle."__drizzle_migrations"`), Count, [])[0]?.n ??
      0;
    const first = await applied();
    expect(first).toBeGreaterThan(0);
    await applyMigrations(db);
    expect(await applied()).toBe(first);
  } finally {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${probe}" WITH (FORCE)`).catch(() => {});
    await admin.end();
  }
}, 30_000);

test("agent tokens are unique, and NULL is not a duplicate", async () => {
  const db = await openMemory();
  const f = fx.on(db);
  const project = await f.project.create({ name: "p" });
  const hire = (token: string | null) => f.agent.create({ project_id: project.id, model: "sonnet", token });
  await hire("tok-a");
  // Caught rather than `await expect(...).rejects`: bun types that as void, so
  // awaiting it trips `await-thenable` and not awaiting leaks the rejection.
  expect(
    await hire("tok-a").then(
      () => null,
      (e: unknown) => errText(e),
    ),
  ).toBeString();
  // Retired agents keep their row with a cleared token; several may coexist.
  await hire(null);
  await hire(null);
});

test("foreign keys are enforced", async () => {
  const db = await openMemory();
  const refused = await fx
    .on(db)
    .grp.create({ project_id: 999, name: "x" })
    .then(
      () => null,
      (e: unknown) => errText(e),
    );
  expect(refused).toBeString();
});

/**
 * One database serves the file, so isolation is the truncate, not the
 * object.
 *
 * `openMemory()` hands back the same database every time — a fresh instance is
 * 670ms and emptying this one is 9ms. That trade is only safe while the emptying
 * is complete, and the failure it buys is the worst kind: a test that passes on a
 * row the previous test wrote.
 */
test("rows do not survive from one openMemory to the next", async () => {
  const first = await openMemory();
  await fx.on(first).event.create({ author: "engineer", body: "leak" });
  const second = await openMemory();
  expect(await second.select().from(event)).toEqual([]);
});

test("event.seq is monotonic — the timeline never reorders, and restarts at 1", async () => {
  const db = await openMemory();
  const f = fx.on(db);
  const written = [];
  for (const body of ["a", "b", "c"]) written.push(await f.event.create({ author: "engineer", body, at: Date.now() }));
  // `RESTART IDENTITY` is half of what the truncate above has to do: without it
  // a test asserting on row 1 passes alone and fails after any other test.
  expect(written.map((e) => e.seq)).toEqual([1, 2, 3]);
});

test("slice seq is unique per group", async () => {
  const db = await openMemory();
  const f = fx.on(db);
  const project = await f.project.create({ name: "p" });
  const group = await f.grp.create({ project_id: project.id, name: "g" });
  const cut = (title: string, accept_spec: string) => f.slice.create({ grp_id: group.id, seq: 1, title, accept_spec });
  await cut("S1", "tests pass");
  expect(
    await cut("dup", "x").then(
      () => null,
      (e: unknown) => errText(e),
    ),
  ).toBeString();
});

/**
 * A migration that fails stamps no version and leaves the rows alone.
 *
 * This is what a restart does on every deployment, so the bad case is a database
 * half-way between two schemas on a machine nobody is watching. Postgres has
 * transactional DDL and Drizzle wraps every pending migration in one transaction
 * — worth a test rather than a reading, because the guarantee is the library's
 * and it is the only thing standing between a bad file and a broken install.
 */
test("a failing migration leaves neither a version nor a changed row behind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-migrations-"));
  const real = join(ROOT, "drizzle");
  cpSync(real, dir, { recursive: true });

  const db = await openMemory();
  await db.insert(project).values({ name: "before", repo_path: "o/n", created_at: 1 });

  // Sorted by folder name, so a later timestamp is a later migration.
  const broken = join(dir, "29999999999999_broken");
  mkdirSync(broken);
  writeFileSync(join(broken, "migration.sql"), "ALTER TABLE project ADD COLUMN a text;\nSELECT this_is_not_sql();");

  const failed =
    await // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the migrator names the concrete driver class that `DB` always is here
    migrate(db as Parameters<typeof migrate>[0], { migrationsFolder: dir }).then(
      () => null,
      (e: unknown) => errText(e),
    );
  expect(failed).toBeString();
  const Names = z.array(z.object({ name: z.string() }));
  const applied = valueOr(await db.execute(sql`SELECT name FROM drizzle."__drizzle_migrations"`), Names, []).map(
    (r) => r.name,
  );

  expect({
    stampedBroken: applied.some((n) => n.includes("broken")),
    rows: (await db.select({ name: project.name }).from(project)).map((r) => r.name),
  }).toEqual({ stampedBroken: false, rows: ["before"] });
  rmSync(dir, { recursive: true, force: true });
});

test("the escalation backfill gives every stored question the key its prose used to be", async () => {
  // Rows already stored have no key and cannot get one from the code that files
  // them — they were filed before it existed. The migration is the only place the
  // mapping from the four literal prefixes to the four keys is still known, so
  // this runs the shipped statements rather than a copy of them.
  const db = await openMemory();
  const f = fx.on(db);
  const legacy = [
    ["budget: g1 用完了 100 tokens，全组已挂起。", escalationKey.budget],
    ["PR #12 被关掉了（没有合入）。这一组已经停下并让出了合入队列。", escalationKey.prClosed(12)],
    ["claude 的凭据不好使了：401", escalationKey.auth("claude")],
    // A runtime or slug holding `_` is why the old matchers could not use LIKE.
    ["a_b 的凭据不好使了：401", escalationKey.auth("a_b")],
    ["GitHub me/x_y: Bad credentials\n\nGitHub 认不了这个登录了", escalationKey.githubRepo("me/x_y")],
    // An agent's own words are nobody's subject, and nothing ever matched them.
    ["我不知道该用哪个库", null],
  ] as const;
  for (const [question] of legacy) await f.escalation.create({ question, chain_state: "boss" });
  await db.update(escalation).set({ dedupe_key: null });

  const file = join(ROOT, "drizzle", "20260822013502_escalation_matches_a_key_not_prose", "migration.sql");
  const updates = readFileSync(file, "utf8")
    .split("--> statement-breakpoint")
    .map((one) => one.trim())
    // Comments and all, which is how `buildNamespace` feeds them to the driver.
    .filter((one) => one.includes('UPDATE "escalation"'));
  expect(updates).toHaveLength(4);
  for (const one of updates) await db.execute(sql.raw(one));

  expect(
    (await db.select({ k: escalation.dedupe_key }).from(escalation).orderBy(escalation.id)).map((r) => r.k),
  ).toEqual(legacy.map(([, key]) => key));
});
