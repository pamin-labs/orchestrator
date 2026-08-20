import { defineConfig } from "drizzle-kit";

/**
 * `schema.ts` decides the shape; this decides where the SQL for it lands.
 *
 * No `dbCredentials`: `generate` diffs the schema against the migrations already
 * in `out` and never opens a connection, which is the only drizzle-kit command
 * this repository runs. `migrate` is called from application code at boot, where
 * the connection string is already resolved — see `platform/persistence`.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/platform/persistence/schema.ts",
  out: "./drizzle",
  casing: "snake_case",
});
