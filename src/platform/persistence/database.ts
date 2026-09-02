import { AsyncLocalStorage } from "node:async_hooks";
import { SQL } from "bun";
import { getTableName, is, sql } from "drizzle-orm";
import type { Logger } from "drizzle-orm/logger";
import { drizzle as bunSqlDrizzle } from "drizzle-orm/bun-sql";
import { migrate as bunSqlMigrate } from "drizzle-orm/bun-sql/migrator";
import { getTableConfig, PgTable, type PgAsyncDatabase, type PgQueryResultHKT } from "drizzle-orm/pg-core";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../config/load.ts";
import { GRP_TERMINAL_STATES } from "../../contracts/states.ts";
import { isLoopback } from "../../contracts/config.ts";
import { clip, errText } from "../process/text.ts";
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
/**
 * One attempt that may fail without taking the caller's transaction with it.
 *
 * Postgres aborts the whole transaction on a constraint violation: every
 * statement after it answers `current transaction is aborted, commands ignored
 * until end of transaction block`, and that is what a retry-on-conflict is. A
 * savepoint is the only thing that makes the attempt undoable on its own.
 */
/**
 * `newGroup` retries a unique name, and both callers that create several groups
 * at once — `orch task split` and the escalation that opens a requirement — wrap
 * the lot in one transaction. So the first collision failed the insert and every
 * insert after it, which is a boss filing two tickets about the same area and
 * getting one. Outside a transaction this is a transaction, which is what the
 * retry always needed and had by accident.
 */
export async function attempt<T>(db: DB, body: (tx: DB) => Promise<T>): Promise<T> {
  const open = openTransaction.getStore();
  if (!open) return transaction(db, body);
  // The savepoint shares the outer `onCommit`: an event emitted inside it still
  // belongs to the outer commit, and fanning it out here would tell a subscriber
  // about work the outer transaction can still roll back.
  return open.tx.transaction((sp) => openTransaction.run({ ...open, tx: sp }, () => body(sp)));
}

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
export const DATABASE_URL = "ORCH_DATABASE_URL";

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
 * `host:port/database`, with the credentials taken out.
 *
 * A connection string spliced whole into a message carries its password in the
 * middle of the authority, which is how one reaches a terminal, a CI log and a
 * screenshot at once. Falls back to the scheme alone when the string does not
 * parse, because a message about an unparseable URL must not quote it either.
 */
export function addressOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return "the configured address";
  }
}

/**
 * The bare host a connection string names, for the one caller that asks whether
 * it is this machine.
 *
 * Brackets stripped: `new URL("postgres://[::1]:5432/x").hostname` keeps them,
 * and `::1` is how a loopback address is spelled everywhere else here.
 */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return "";
  }
}

/** Whether this failure is "nothing is listening there", as opposed to a bad password or a bad migration. */
export function isRefused(e: unknown): boolean {
  for (let c: unknown = e, hops = 0; c instanceof Error && hops < 4; c = c.cause, hops++) {
    // The code, not the message: Bun spells it `ERR_POSTGRES_CONNECTION_REFUSED`
    // on a `PostgresError` it wraps in a `DrizzleQueryError`, and the human half
    // of that is the untranslated "Failed to connect".
    if ("code" in c && typeof c.code === "string" && c.code.includes("CONNECTION_REFUSED")) return true;
  }
  return false;
}

/**
 * Whether a failed `open()` should be retried against the local container.
 *
 * **Loopback only.** A refused connection to this machine means the local
 * database is not running, and the container is that database — same
 * `data/postgres` volume, same credentials, so what comes back is the same data.
 * A managed PostgreSQL that refuses is an outage, and quietly starting an empty
 * one beside it and writing to it is a data split nothing would report.
 */
/**
 * **Refused only**, too: a bad password or a timeout is not "the local database
 * is not running", and retrying either against a fresh container answers a
 * question nobody asked. Both halves fail in opposite directions, which is why
 * this is one predicate with its own test rather than two `&&` at a call site.
 */
export const shouldStartLocal = (url: string, e: unknown): boolean => isRefused(e) && isLoopback(hostnameOf(url));

/**
 * What a database that would not open should have said.
 *
 * The unset case had a sentence naming the variable; the set-but-wrong case had
 * nothing, and it is the common one. What came out was `DrizzleQueryError:
 * Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"` wrapping `Failed to
 * connect` — the statement the migrator happened to be on, and not one word
 * about which address, which variable, or what to run.
 */
/** ADR 051 already required this ("a failure names both ways out"); it was delivered for the container half only. */
function unreachable(url: string, e: unknown): Error {
  const at = addressOf(url);
  // `cause`, not the driver's text spliced in: `errText` already walks the chain,
  // so a copy in the message prints the reason twice — and `server.ts` reads the
  // *code* off this chain to decide whether to start a container, which a
  // stringified copy cannot carry.
  const because = e instanceof Error ? { cause: e } : { cause: new Error(clip(String(e), 400)) };
  if (!isRefused(e)) return new Error(`opening the database at ${at} failed`, because);
  return new Error(
    `nothing is listening for PostgreSQL at ${at}.\n` +
      `Start the local one with \`bun run db:up\`, point ${DATABASE_URL} at a PostgreSQL of your own, ` +
      `or unset ${DATABASE_URL} and one will be started for you.`,
    because,
  );
}

/**
 * Open the deployment's database and bring it up to date.
 *
 * Whatever was stored before this process started still has to be masked out of
 * everything it prints, and this is the one function every path into a real
 * database comes through.
 */
/** How long a pooled connection may sit idle before it is closed. Longer than
 *  the test path's: a reconnect here costs a request rather than a test file. */
const IDLE_SECONDS = 60;

export async function open(poolSize?: number, url = process.env[DATABASE_URL]): Promise<DB> {
  if (!url) throw new Error(`${DATABASE_URL} is unset: this needs a PostgreSQL connection string`);
  // The pool is the config's, not Bun's default of ten: the panel's snapshot
  // issues nineteen statements at once, so a pool under that serves them in
  // waves. Optional because the scripts and the migration path open one before
  // there is a config to ask.
  //
  // And it gives connections back. Bun's `idleTimeout` defaults to 0 — never —
  // so the pool climbed to its maximum on the first busy moment and held every
  // backend for the life of the process: measured on a running server, 24 idle
  // connections with the oldest untouched for five minutes, against one that was
  // doing anything. A minute is well past the readiness tick and the watchdog,
  // so a working fleet keeps its pool warm and an idle one stops holding
  // twenty-odd Postgres processes to do nothing. The cost, when it is paid, is
  // one connection handshake on a request that had been idle a full minute.
  const db = bunSqlDrizzle({
    client: poolSize
      ? new SQL({ url, max: poolSize, idleTimeout: IDLE_SECONDS })
      : new SQL({ url, idleTimeout: IDLE_SECONDS }),
  });
  try {
    await bunSqlMigrate(db, { migrationsFolder: MIGRATIONS });
  } catch (e) {
    throw unreachable(url, e);
  }
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

/**
 * Named by the migrations it holds, so a change makes a new one.
 *
 * A namespace built from an older tag holds tables that are not the ones this
 * build expects, and reusing one by name gave "relation does not exist" long
 * after the mistake.
 */
const SCHEMA_TAG = schemaTag();

function schemaTag(): string {
  const hash = new Bun.CryptoHasher("sha256");
  for (const dir of readdirSync(MIGRATIONS).sort()) hash.update(readFileSync(join(MIGRATIONS, dir, "migration.sql")));
  return hash.digest("hex").slice(0, 10);
}

/**
 * The half of the name that identifies the *file*, and survives a tag change.
 *
 * Exported for the guard: if this stops agreeing with the name, reclamation
 * silently matches nothing and the generations pile up again with nothing to say.
 */
export const suffixFor = (isolate: string) =>
  `w${process.env["BUN_TEST_WORKER_ID"] ?? "0"}${isolate ? `x${Bun.hash(isolate).toString(36)}` : ""}`;

/**
 * One PostgreSQL **schema** per test file, in one shared database.
 *
 * A *database* per file cost 87% overhead — `template0` is 7,521 kB against our
 * 808 kB — so this is a schema, keyed on the **worker**. One per file is 193
 * namespaces, and building those is 193 concurrent `CREATE TABLE` storms against
 * one catalogue: measured, 94 tests time out. The template a database-per-file
 * copied absorbed that, and a schema has no `CREATE SCHEMA ... TEMPLATE`.
 */
/**
 * How long a test connection may sit idle before the pool closes it.
 *
 * Bun's default is 0, which means never — so each worker climbed to its pool
 * maximum and held every connection until the process exited. Measured on a
 * ten-core machine: eight workers, 104-176 backends live at once against a
 * `max_connections` somebody had already raised to 300, and a container that had
 * grown to 2.9 GB across a session's runs.
 */
/**
 * The maximum stays where it is: `24` is above the widest fan-out a single
 * request makes, and a pool under that deadlocks the snapshot against itself.
 * What was missing is that a connection nobody is using should go back.
 */
const TEST_IDLE_SECONDS = 5;

const nameFor = (isolate: string) => `t_${SCHEMA_TAG}_${suffixFor(isolate)}`;

/** Every connection lands in its own namespace, and the pool cannot drift off it. */
const urlFor = (ns: string): string => {
  const url = new URL(testServer());
  url.searchParams.set("options", `-csearch_path=${ns}`);
  return url.toString();
};

/**
 * This file's namespaces from older migrations, dropped as this one is made.
 *
 * The name carries the tag, so changing the migrations orphans every one of them
 * and nothing collected it: 197 databases and 1,799 MB before this existed.
 * One file's own, not a sweep — a sweep of a whole generation ran serially on the
 * one connection and took minutes.
 */
async function dropMyOldGenerations(admin: SQL, mine: string, suffix: string): Promise<void> {
  // `right(...)` rather than a `LIKE` pattern: the names are full of underscores
  // and `_` is LIKE's single-character wildcard, so the pattern that reads as
  // exact is not one, and escaping it is a backslash three languages have views on.
  const tail = `_${suffix}`;
  const stale = await admin<{ nspname: string }[]>`
    SELECT nspname FROM pg_namespace
    WHERE starts_with(nspname, 't_') AND right(nspname, ${tail.length}) = ${tail} AND nspname <> ${mine}`;
  // `CASCADE`, and best-effort: losing a race here costs memory and nothing else.
  const ddl = bunSqlDrizzle({ client: admin });
  for (const { nspname } of stale) {
    await ddl.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(nspname)} CASCADE`).catch(() => {});
  }
}

const ready = new Map<string, Promise<SQL>>();

/**
 * Hand the connections back. Registered by the test preload, not by a caller.
 *
 * Each test file evaluates this module afresh and opens its own pool, so a run
 * of 193 files leaves 193 of them behind — and the server refuses the next
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
 * The migrations, replayed into whichever namespace the connection is pointed at.
 *
 * Not `bunSqlMigrate`: that keeps its own ledger table and would need one per
 * namespace to decide what to skip, and there is nothing to skip — the namespace
 * is either absent or complete, because the tag is the hash of these files.
 */
async function buildNamespace(client: SQL): Promise<void> {
  for (const dir of readdirSync(MIGRATIONS).sort()) {
    const file = join(MIGRATIONS, dir, "migration.sql");
    // Drizzle writes this separator between statements, and the extended protocol
    // carries one statement per round trip.
    for (const statement of readFileSync(file, "utf8").split("--> statement-breakpoint")) {
      const one = statement.trim();
      if (one) await client.unsafe(one);
    }
  }
  await terminalStateGuard(bunSqlDrizzle({ client }));
}

/**
 * Connections one worker may hold, against eight tests running in it at once.
 *
 * Was 24, sized when every *file* had its own pool and the panel snapshot's
 * nineteen concurrent statements were the ceiling. One registry per worker means
 * one pool per worker, and 24 x 10 workers stood 233 backends up.
 */
/**
 * Eight is faster as well as smaller — 20s against 24s for the same suite —
 * because the contention was costing more than the queueing does. The snapshot
 * waits its turn; nothing else asks for more than a few at once.
 */
const TEST_POOL = 8;

/** Which namespace a handle is pointed at, so cancellation stays inside this file's. */
const namespaces = new WeakMap<DB, string>();
const mineNamespace = (db: DB): string => namespaces.get(db) ?? "";

/**
 * Whatever is still holding a lock in this file's namespace, after waiting failed.
 *
 * Scoped by `search_path`, not by database: every test file now shares one
 * database, so cancelling by `datname` would reach into every other worker.
 */
const clearBackends = (db: DB, ns: string): Promise<unknown> =>
  db.execute(sql`
    SELECT pg_cancel_backend(pid), CASE WHEN state = 'idle in transaction' THEN pg_terminate_backend(pid) END
    FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_backend_pid()
      AND position(${ns} in coalesce(query, '')) > 0`);

/**
 * A namespace for one test file, emptied rather than rebuilt.
 *
 * Built once per file; each call truncates it. `RESTART IDENTITY` matters as much
 * as the delete — hundreds of assertions name row 1 — and each call gets its own
 * Drizzle wrapper, because several modules cache per database *object*. Kept
 * between runs, so a test that changes the *shape* outlives its own run; dropping
 * the namespace is the repair. `isolate` names a second one.
 */
export async function openMemory(logger?: Logger, isolate = ""): Promise<DB> {
  const mine = nameFor(isolate);
  let mineReady = ready.get(mine);
  if (!mineReady) {
    mineReady = (async () => {
      const admin = new SQL({ url: testServer(), max: 1 });
      try {
        // No advisory lock *within* a run: the name belongs to one worker, which
        // `--parallel` gives one process, so two workers of the same run cannot
        // be here for the same namespace.
        //
        // Two *runs* are a different matter and this held no answer for them.
        // `BUN_TEST_WORKER_ID` restarts at 0 every run, so a second concurrent
        // `bun run test` gets the same names and empties the first one's tables
        // mid-test. It reads as duplicate keys, absent foreign parents and
        // `relation "agent" does not exist` scattered across unrelated files —
        // two agents each burned a full suite on that before it was diagnosed,
        // because a corrupt run and a broken branch look identical. `scripts/test.ts`
        // now refuses the second run by name rather than letting it produce a
        // number nobody can act on.
        const found = await admin<{ present: number }[]>`SELECT 1 AS present FROM pg_namespace WHERE nspname = ${mine}`;
        const client = new SQL({ url: urlFor(mine), max: TEST_POOL, idleTimeout: TEST_IDLE_SECONDS });
        if (found.length === 0) {
          await bunSqlDrizzle({ client: admin }).execute(sql`CREATE SCHEMA ${sql.identifier(mine)}`);
          await buildNamespace(client);
        }
        await dropMyOldGenerations(admin, mine, suffixFor(isolate));
        // Above the widest fan-out a single request makes: the panel's snapshot
        // issues nineteen statements at once, and a pool under that had them
        // waiting on each other — a request that never returned rather than a
        // slow one.
        return client;
      } finally {
        await admin.end();
      }
    })();
    ready.set(mine, mineReady);
  }
  // `logger` is Drizzle's own hook, for the two tests that count statements.
  const db = bunSqlDrizzle(logger ? { client: await mineReady, logger } : { client: await mineReady });
  namespaces.set(db, mine);
  await emptied(db);
  return db;
}

const TABLES = Object.values<unknown>(schema)
  .filter((v): v is PgTable => is(v, PgTable))
  .map((t) => getTableName(t));

/**
 * Empty every table, and reset the identities that were used.
 *
 * `DELETE`, not `TRUNCATE`: truncating makes a new relfilenode per relation — 19
 * tables, 36 indexes, 11 sequences — right on a big table, wrong on ones holding
 * single-figure rows. Measured at **1,183 calls, 33,745ms**, more than every
 * insert and select combined; `DELETE` is 5x faster and nearly free when empty.
 * A CTE for the rows and one statement for the sequences, because `DELETE` resets
 * no identity. Foreign keys are deferred for the transaction, not ordered around.
 */
/**
 * Both session settings in one statement, because `SET` takes only one.
 *
 * `lock_timeout` so a standoff with a stray from the test before ends with *this*
 * statement giving up, not with the deadlock detector picking a victim.
 * `session_replication_role` so the deletes can run in any order: foreign keys are
 * trigger-checked per statement, and a CTE puts every `DELETE` under one snapshot
 * without making them one statement — `grp` before `event` failed four runs in
 * six. `true` is `is_local`, so both end with the transaction.
 */
const SETTINGS = sql`SELECT set_config('lock_timeout', '250ms', true),
  set_config('session_replication_role', 'replica', true)`;

/**
 * Every table emptied under one snapshot. The CTE has to project something, and
 * `1` is all it has left to project — the resets used to ride here and cannot.
 */
const EMPTY = sql`WITH ${sql.join(
  TABLES.map((t, i) => sql`${sql.identifier(`d${i}`)} AS (DELETE FROM ${sql.identifier(t)})`),
  sql`, `,
)} SELECT 1`;

/** The generated identities, from `schema.ts`: Drizzle names one `<table>_<column>_seq` each. */
const IDENTITIES = Object.values<unknown>(schema)
  .filter((v): v is PgTable => is(v, PgTable))
  .flatMap((table) => {
    const config = getTableConfig(table);
    return config.columns
      .filter((c) => c.generatedIdentity)
      .map((c) => ({ seq: `${config.name}_${c.name}_seq`, table: config.name, column: c.name }));
  });

/**
 * Past whatever survived, not back to 1.
 *
 * A blind `setval(seq, 1, false)` is only right when the delete above emptied the
 * table, and it does not always: a test that leaves work in flight commits after
 * that statement's snapshot, so the row stays and the sequence is wound back
 * behind it. The next ordinary insert then asks for an id that is already there —
 * `duplicate key value violates unique constraint "agent_pkey", Key (id)=(3)`,
 * two of 16490 on the 2026-08-31 nightly and one on 2026-08-26.
 */
/**
 * A second round trip, and it used to be one: the resets were the CTE's
 * projection, which cannot see its own deletes. This statement can, being after
 * them in the same transaction. Measured over the suite, the cost of the extra
 * statement is in the noise beside what it removes.
 */
/**
 * Exported for the guard, which needs rows the reset did not delete.
 *
 * No single-threaded test can leave one behind — `emptied` deletes every table —
 * so the property is pinned here, one layer down, where the survivor can simply
 * be there.
 */
export async function resetIdentities(db: DB): Promise<void> {
  await db.execute(RESETS);
}

const RESETS = IDENTITIES.length
  ? sql`SELECT ${sql.join(
      IDENTITIES.map(
        (i) =>
          sql`setval(${i.seq}, GREATEST(1, (SELECT coalesce(max(${sql.identifier(i.column)}), 0) FROM ${sql.identifier(i.table)}) + 1), false)`,
      ),
      sql`, `,
    )}`
  : sql`SELECT 1`;

async function emptied(db: DB): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await db.transaction(async (tx) => {
        await tx.execute(SETTINGS);
        await tx.execute(EMPTY);
        await tx.execute(RESETS);
      });
      return;
    } catch (error) {
      if (attempt >= 40 || !/deadlock|lock timeout|lock_timeout/i.test(errText(error, 2_000))) throw error;
      // Only once waiting has already failed: the login flows keep writing after
      // their request returns, so cancelling on the common path would kill
      // legitimate work and report it against the next test.
      if (attempt === 20) await clearBackends(db, mineNamespace(db));
      await Bun.sleep(10);
    }
  }
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
