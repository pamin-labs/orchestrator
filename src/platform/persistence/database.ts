import { AsyncLocalStorage } from "node:async_hooks";
import { SQL } from "bun";
import { getTableName, is, sql } from "drizzle-orm";
import type { Logger } from "drizzle-orm/logger";
import { drizzle as bunSqlDrizzle } from "drizzle-orm/bun-sql";
import { migrate as bunSqlMigrate } from "drizzle-orm/bun-sql/migrator";
import { PgTable, type PgAsyncDatabase, type PgQueryResultHKT } from "drizzle-orm/pg-core";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../config/load.ts";
import { GRP_TERMINAL_STATES } from "../../contracts/states.ts";
import { errText } from "../process/text.ts";
import { maskValue } from "../observability/redaction.ts";
import * as schema from "./schema.ts";
import { runtime_auth, setting } from "./schema.ts";
import { eq, inArray } from "drizzle-orm";

/**
 * The database, whichever engine is under it.
 *
 * Both drivers satisfy this: `bun-sql` against the Postgres a deployment runs,
 * `pglite` against the one a test process carries. Nothing downstream is written
 * against either — a module that knew would be a module a test cannot run.
 */
export type DB = PgAsyncDatabase<PgQueryResultHKT>;

/**
 * The transaction this async context is inside, if any.
 *
 * Async-local rather than a field on anything: two requests each open one, and a
 * shared field would let either write into the other. Everything that holds its
 * own handle — the bus, the scheduler — has to write through this or its row
 * lands on a second connection, which outlives a rollback under the pool and
 * deadlocks under the single connection the tests use.
 */
export const openTransaction = new AsyncLocalStorage<{ tx: DB; onCommit: (() => void)[] }>();

/** The handle a write must use: the open transaction, or the caller's own. */
export const writeHandle = (db: DB): DB => openTransaction.getStore()?.tx ?? db;

/**
 * Run `body` in a transaction that everything holding a handle can see.
 *
 * Nesting reuses the open one: a second `db.transaction` is a second connection
 * under the pool and a second transaction on it, and an inner commit could outlive
 * an outer rollback either way.
 */
export async function transaction<T>(db: DB, body: (tx: DB) => Promise<T>): Promise<T> {
  const open = openTransaction.getStore();
  if (open) return body(open.tx);
  const onCommit: (() => void)[] = [];
  const result = await db.transaction((tx) => openTransaction.run({ tx, onCommit }, () => body(tx)));
  for (const after of onCommit) after();
  return result;
}

/**
 * Where the database is. Not a config key, and deliberately.
 *
 * `config/default.yaml` holds the three things that must be known before there is
 * a database to read settings out of; this is the fourth, and by definition it
 * cannot live in the thing it opens. It carries a password, which is the same
 * reason ORCH_SANDBOX_API_KEY is an environment variable and not a committed key.
 */
const DATABASE_URL = "ORCH_DATABASE_URL";

/**
 * Where `drizzle-kit generate` writes, and where the migrator reads.
 *
 * From `ROOT`, not from `import.meta.dir`: the release is one compiled binary and
 * a bundled module's own directory is a virtual path inside it, so a relative
 * walk finds nothing. `ROOT` is the unpacked archive, which is how `roles` and
 * `config` are already located — and the archive has to carry this folder, which
 * `release.yml` copies and its manifest check enforces.
 */
const MIGRATIONS = join(ROOT, "drizzle");

/**
 * A terminal state is terminal, where fourteen `UPDATE grp SET status` statements
 * cannot argue with it — eight of them name only the row.
 *
 * A group dissolved mid-turn is revived by whatever lands after it, and holds its
 * paths in `ownership.ts` with nobody left to release them. Returning NULL from a
 * BEFORE trigger skips the row, as `AND status <> …` would have at each site;
 * raising would throw inside a turn with no reason to expect one. Applied here so
 * `GRP_TERMINAL_STATES` stays the only copy of the list.
 */
async function terminalStateGuard(db: DB): Promise<void> {
  const states = GRP_TERMINAL_STATES.map((s) => `'${s}'`).join(", ");
  // One statement per call: `execute` speaks the extended query protocol, which
  // carries exactly one, and a script sent as a single string fails to parse.
  for (const statement of [
    `CREATE OR REPLACE FUNCTION grp_status_terminal() RETURNS trigger AS $fn$
       BEGIN
         IF OLD.status IN (${states}) AND NEW.status <> OLD.status THEN RETURN NULL; END IF;
         RETURN NEW;
       END $fn$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS grp_status_terminal ON grp`,
    `CREATE TRIGGER grp_status_terminal BEFORE UPDATE OF status ON grp
       FOR EACH ROW EXECUTE FUNCTION grp_status_terminal()`,
  ]) {
    // fallow-ignore-next-line security-sink -- every statement in this list is a literal in this file; the only interpolation is `GRP_TERMINAL_STATES`, a module constant from `contracts/states.ts`, and nothing reaches here from a request
    await db.execute(sql.raw(statement));
  }
}

/**
 * Open the deployment's database and bring it up to date.
 *
 * Whatever was stored before this process started still has to be masked out of
 * everything it prints, and this is the one function every path into a real
 * database comes through.
 */
export async function open(poolSize?: number, url = process.env[DATABASE_URL]): Promise<DB> {
  if (!url) throw new Error(`${DATABASE_URL} is unset: this needs a PostgreSQL connection string`);
  // The pool is the config's, not Bun's default of ten: the panel's snapshot
  // issues nineteen statements at once, so a pool under that serves them in
  // waves. Optional because the scripts and the migration path open one before
  // there is a config to ask.
  const db = bunSqlDrizzle({ client: poolSize ? new SQL({ url, max: poolSize }) : new SQL(url) });
  await bunSqlMigrate(db, { migrationsFolder: MIGRATIONS });
  await terminalStateGuard(db);
  for (const { secret } of await db.select({ secret: runtime_auth.secret }).from(runtime_auth)) maskValue(secret);
  return db;
}

/**
 * Where the tests' PostgreSQL is — `bun run db:test:up`, on 5433.
 *
 * Its own server, not the one `db:up` starts: the suite creates and drops
 * databases, and the development data is on the other one. Same engine as
 * production, which is the point; a different port, which is the safety.
 */
const TEST_DATABASE_URL = "ORCH_TEST_DATABASE_URL";

const testServer = (): string =>
  process.env[TEST_DATABASE_URL] ?? "postgres://orchestrator:orchestrator@127.0.0.1:5433/orchestrator";

const on = (database: string): string => new URL(`/${database}`, testServer()).toString();

/**
 * Named by the schema it holds, so a change makes a new one.
 *
 * The databases copied from it are named the same way: a copy taken from an
 * older template is a database whose tables are not the ones this build expects,
 * and reusing one by name gave "relation does not exist" long after the mistake.
 */
const SCHEMA_TAG = schemaTag();
const TEMPLATE = `orch_test_template_${SCHEMA_TAG}`;

function schemaTag(): string {
  const hash = new Bun.CryptoHasher("sha256");
  for (const dir of readdirSync(MIGRATIONS).sort()) hash.update(readFileSync(join(MIGRATIONS, dir, "migration.sql")));
  return hash.digest("hex").slice(0, 10);
}

/**
 * One database per test *file*, not per worker.
 *
 * A worker runs many files, and an abandoned `Scheduler` keeps dispatching from
 * a finished job's detached `.finally` — into whatever file is running by then.
 * Sharing a database made that an ordering flake with a different victim each
 * run. A copy is 9MB and the server holds them in tmpfs, so isolation is
 * structural rather than something each test has to remember.
 */
const nameFor = (isolate: string) => `orch_test_${SCHEMA_TAG}_${Bun.hash(`${Bun.main}${isolate}`).toString(36)}`;

/** Any constant. Session-scoped, so a killed worker does not hold it. */
const LOCK = 0x0_7c_11_5e;

/**
 * A migrated database to copy, built once by whichever worker gets there first.
 *
 * `CREATE DATABASE ... TEMPLATE` is PostgreSQL's own answer to "give every test
 * worker its own database", and it is the reason this is not PGlite: that engine
 * is in-process, so a worker cannot share one and each costs 1.2GB of WASM heap —
 * ten of them swapped a 32GB machine. Two workers racing here is normal; the
 * loser's `CREATE` fails on the name and it uses what the winner built.
 */
async function ensureTemplate(admin: SQL): Promise<void> {
  const existing = await admin<{ present: number }[]>`SELECT 1 AS present FROM pg_database WHERE datname = ${TEMPLATE}`;
  if (existing.length > 0) return;
  // Built under another name and renamed, so that the template existing means it
  // is migrated. Created in place, a process that died between the CREATE and
  // the migrations left an empty one — and every copy after it was a database
  // whose tables did not exist.
  const building = `${TEMPLATE}_building`;
  await admin.unsafe(`DROP DATABASE IF EXISTS "${building}" WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE "${building}"`);
  const client = new SQL(on(building));
  const db = bunSqlDrizzle({ client });
  await bunSqlMigrate(db, { migrationsFolder: MIGRATIONS });
  await terminalStateGuard(db);
  // Closed, and it matters: `CREATE DATABASE ... TEMPLATE` refuses while any
  // session is connected to the source.
  await client.end();
  await admin.unsafe(`ALTER DATABASE "${building}" RENAME TO "${TEMPLATE}"`);
}

const ready = new Map<string, Promise<SQL>>();

/**
 * Hand the connections back. Registered by the test preload, not by a caller.
 *
 * Each test file evaluates this module afresh and opens its own pool, so a run
 * of 188 files leaves 188 of them behind — and the server refuses the next
 * connection long before the suite is finished.
 */
export async function closeTestDatabases(): Promise<void> {
  await Promise.all([...ready.values()].map(async (open) => (await open).end()));
  ready.clear();
}

/** Bring a database up to the schema, without naming the driver's own class. */
export async function applyMigrations(db: DB): Promise<void> {
  // One entry point, so a caller does not have to name the driver's own database
  // class to say "bring this up to date".
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `DB` is the shared supertype; the migrator names the concrete driver class this always is
  await bunSqlMigrate(db as Parameters<typeof bunSqlMigrate>[0], { migrationsFolder: MIGRATIONS });
}

/**
 * Empty the tables, retrying while the last test is still letting go.
 *
 * A detached chain from the test before still holds a read lock on one of them,
 * and it is finishing rather than stuck — so waiting is the whole fix, but the
 * wait has to be *this* statement's. Left plain, the deadlock detector picks the
 * victim, and the abort landed on the stray, arriving as a failure in the next
 * test. `lock_timeout` under `deadlock_timeout` makes this one always give up
 * first; `SET LOCAL` in a transaction, or the pool settles it elsewhere.
 */
async function emptied(db: DB, statement: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '250ms'`);
        // fallow-ignore-next-line security-sink -- the caller builds this from `getTableName` over the tables in `schema.ts`; there is no request path into it and this function is test-only
        await tx.execute(sql.raw(statement));
      });
      return;
    } catch (error) {
      if (attempt >= 40 || !/deadlock|lock timeout|lock_timeout/i.test(errText(error, 2_000))) throw error;
      // Only once the wait has already failed. Unconditionally clearing the
      // database's other backends looks tidier and is wrong: the login flows keep
      // working after their request returns, on purpose, so the common path would
      // cancel legitimate work and report it against the next test —
      // `canceling statement due to user request`, seen once in six runs. A
      // statement that has held a lock through the retries is a different thing.
      if (attempt === 20) await clearBackends(db);
      await Bun.sleep(10);
    }
  }
}

/** Whatever is still holding a lock in this database, after waiting did not work. */
const clearBackends = (db: DB): Promise<unknown> =>
  db.execute(sql`
    SELECT pg_cancel_backend(pid), CASE WHEN state = 'idle in transaction' THEN pg_terminate_backend(pid) END
    FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_backend_pid()`);

/**
 * A database for one test file, emptied rather than rebuilt.
 *
 * A template copy, made once per file; each call truncates it. `RESTART IDENTITY`
 * matters as much as the delete — hundreds of assertions here name row 1 — and
 * each call gets its own Drizzle wrapper, because several modules cache per
 * database *object*. `isolate` names a second database, for the rare test whose
 * subject is two of them; each name is another pool, so it is for the handful
 * that need it rather than a way to avoid sharing.
 */
export async function openMemory(logger?: Logger, isolate = ""): Promise<DB> {
  const mine = nameFor(isolate);
  let mineReady = ready.get(mine);
  if (!mineReady) {
    mineReady = (async () => {
      // `max: 1`, because the lock below is per *session*: on a pool, the
      // acquire, the work and the release each take whichever connection is
      // free, so two workers were inside at once and Postgres reported the
      // collision as a deadlock rather than as a lock nobody held.
      const admin = new SQL({ url: testServer(), max: 1 });
      // One worker at a time through here. Postgres refuses to copy a template
      // another session is connected to, so two workers arriving together made one
      // of them throw — and a worker that throws during setup loses its whole file
      // silently, which is how two files became one with nothing reported.
      await admin`SELECT pg_advisory_lock(${LOCK})`;
      try {
        await ensureTemplate(admin);
        const found = await admin<{ present: number }[]>`SELECT 1 AS present FROM pg_database WHERE datname = ${mine}`;
        // Left in place between runs rather than dropped: `openMemory` empties it,
        // and dropping one a sibling still holds is how a worker kills a peer.
        if (found.length === 0) await admin.unsafe(`CREATE DATABASE "${mine}" TEMPLATE "${TEMPLATE}"`);
      } finally {
        await admin`SELECT pg_advisory_unlock(${LOCK})`;
        await admin.end();
      }
      // Above the widest fan-out a single request makes: the panel's snapshot issues
      // nineteen statements at once, and a pool under that had them waiting on each
      // other — a request that never returned rather than one that was slow.
      return new SQL({ url: on(mine), max: 24 });
    })();
    ready.set(mine, mineReady);
  }
  // `logger` is Drizzle's own hook, for the two tests that count statements.
  const db = bunSqlDrizzle(logger ? { client: await mineReady, logger } : { client: await mineReady });
  const names = Object.values<unknown>(schema)
    .filter((v): v is PgTable => is(v, PgTable))
    .map((t) => `"${getTableName(t)}"`)
    .join(", ");
  await emptied(db, `TRUNCATE ${names} RESTART IDENTITY CASCADE`);
  return db;
}

/**
 * The `setting` key/value table, read and written in one place.
 *
 * `null` deletes rather than storing "null": the absent value is what every reader
 * here already tests for, and a row holding the four characters would read back as
 * present. Typed settings — the `cfg.*` paths with validation and defaults — are a
 * different concern and stay in `platform/config/settings.ts`.
 */
export async function readSetting(db: DB, key: string): Promise<string | null> {
  const [row] = await db.select({ v: setting.v }).from(setting).where(eq(setting.k, key));
  return row?.v ?? null;
}

export async function writeSetting(db: DB, key: string, value: string | null): Promise<void> {
  if (value === null) await db.delete(setting).where(eq(setting.k, key));
  else
    await db
      .insert(setting)
      .values({ k: key, v: value })
      .onConflictDoUpdate({ target: setting.k, set: { v: value } });
}

/**
 * What happens to a row that points at a slice being dropped.
 *
 * `null` = the row survives and forgets the slice (history: what ran, what was
 * written down). `delete` = the row was part of the plan being replaced. Columns
 * rather than names, so a renamed one is a compile error instead of a statement
 * that fails at the moment a boss replaces a plan. `test/platform/drop-slices.ts`
 * reads every foreign key pointing at `slice` and fails on one missing here.
 */
export const SLICE_REFS = [
  { table: schema.task, column: schema.task.slice_id, how: "delete" },
  { table: schema.job, column: schema.job.slice_id, how: "null" },
  { table: schema.note, column: schema.note.slice_id, how: "null" },
  { table: schema.slice, column: schema.slice.depends_on, how: "null" },
] as const;

/** Drop a group's slices and everything that was planned with them. */
export async function dropSlices(db: DB, grpId: number): Promise<void> {
  const doomed = db.select({ id: schema.slice.id }).from(schema.slice).where(eq(schema.slice.grp_id, grpId));
  await db.transaction(async (tx) => {
    for (const { table, column, how } of SLICE_REFS) {
      const match = inArray(column, doomed);
      if (how === "null")
        await tx
          .update(table)
          .set({ [column.name]: null })
          .where(match);
      else await tx.delete(table).where(match);
    }
    await tx.delete(schema.slice).where(eq(schema.slice.grp_id, grpId));
  });
}
