import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory } from "../../src/platform/persistence/database.ts";

const ROOT = join(import.meta.dir, "../..");

/**
 * A second database, built from `schema.ts` instead of from the migrations.
 *
 * `drizzle-kit generate` is the only way to turn a Drizzle schema into DDL:
 * `drizzle-kit@1.0.0-beta.24` exports `defineConfig` and a studio server, and
 * nothing that renders SQL. Generating into an empty directory is what makes the
 * output a full `CREATE TABLE` set rather than a diff against a previous state.
 */
function fromSchemaFile(): Database {
  const out = mkdtempSync(join(tmpdir(), "schema-equivalence-"));
  try {
    const gen = Bun.spawnSync(
      [
        join(ROOT, "node_modules/.bin/drizzle-kit"),
        "generate",
        "--dialect=sqlite",
        "--schema=./src/platform/persistence/schema.ts",
        `--out=${out}`,
      ],
      { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
    );
    if (gen.exitCode !== 0)
      throw new Error(`drizzle-kit generate failed: ${gen.stderr.toString()}${gen.stdout.toString()}`);
    const dirs = readdirSync(out, { withFileTypes: true }).filter((e) => e.isDirectory());
    if (dirs.length !== 1) throw new Error(`expected one migration directory, got ${dirs.length}`);
    const db = new Database(":memory:");
    for (const statement of readFileSync(join(out, dirs[0]!.name, "migration.sql"), "utf8").split(
      "--> statement-breakpoint",
    )) {
      if (statement.trim()) db.run(statement);
    }
    return db;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/**
 * One sorted line per thing the schema asserts, read from the PRAGMAs rather than
 * from `sqlite_master`: SQLite stores `CREATE TABLE` text verbatim, so whitespace,
 * comments and the order ALTER TABLE left the columns in differ harmlessly.
 *
 * Not covered, because Drizzle cannot express them: the thirteen state triggers,
 * and the body of a partial index's WHERE — `index_list` reports only that one
 * exists.
 */
function facts(db: Database): string[] {
  const all = <T>(sql: string): T[] => db.query<T, []>(sql).all();
  const lines: string[] = [];
  const tables = all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  for (const { name: table } of tables) {
    lines.push(`${table}: table exists`);
    for (const c of all<Col>(`PRAGMA table_info(${table})`)) {
      lines.push(
        `${table}.${c.name}: ${c.type.toUpperCase()} notnull=${c.notnull} default=${c.dflt_value ?? "none"} pk=${c.pk}`,
      );
    }
    for (const i of all<Idx>(`PRAGMA index_list(${table})`)) {
      const cols = all<IdxCol>(`PRAGMA index_xinfo(${i.name})`)
        .filter((c) => c.key === 1)
        .map((c) => `${c.name}${c.desc === 1 ? " DESC" : ""}`)
        .join(", ");
      lines.push(`${table} index ${i.name}: unique=${i.unique} partial=${i.partial} origin=${i.origin} (${cols})`);
    }
    for (const f of all<Fk>(`PRAGMA foreign_key_list(${table})`)) {
      lines.push(`${table}.${f.from} references ${f.table}.${f.to}: update ${f.on_update}, delete ${f.on_delete}`);
    }
  }
  return lines.sort();
}

type Col = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number };
type Idx = { name: string; unique: number; origin: string; partial: number };
type IdxCol = { name: string | null; desc: number; key: number };
type Fk = { table: string; from: string; to: string; on_update: string; on_delete: string };

test("schema.ts describes exactly the database the migrations produce", () => {
  const migrated = new Set(facts(openMemory()));
  const declared = new Set(facts(fromSchemaFile()));
  expect({
    inMigrationsButNotInSchema: [...migrated].filter((f) => !declared.has(f)),
    inSchemaButNotInMigrations: [...declared].filter((f) => !migrated.has(f)),
  }).toEqual({ inMigrationsButNotInSchema: [], inSchemaButNotInMigrations: [] });
}, 30_000);
