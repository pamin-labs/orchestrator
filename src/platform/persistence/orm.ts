import { drizzle } from "drizzle-orm/bun-sqlite";
import type { DB } from "./database.ts";
import * as schema from "./schema.ts";

/**
 * Drizzle over the handle that is already open, never a second connection.
 *
 * The conversion is per module and the two APIs run side by side for the whole of
 * it, so they must see one another's writes inside one transaction — a second
 * connection to the same file would not, and to `:memory:` would be a different
 * database entirely. `bun:sqlite` is synchronous and so is this: `.get()` and
 * `.all()` return rows, not promises.
 */
const cache = new WeakMap<DB, ReturnType<typeof build>>();

const build = (db: DB) => drizzle({ client: db, schema });

/**
 * Cached per handle. Construction is cheap but not free, and a module that built
 * one per call would pay it on every query — while a `WeakMap` lets a closed test
 * database be collected with its wrapper.
 */
export function orm(db: DB): ReturnType<typeof build> {
  const found = cache.get(db);
  if (found) return found;
  const made = build(db);
  cache.set(db, made);
  return made;
}
