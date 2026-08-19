import { Factory } from "fishery";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import type { PgInsertValue, PgTable } from "drizzle-orm/pg-core";
import type { DB } from "../../src/platform/persistence/database.ts";
import * as schema from "../../src/platform/persistence/schema.ts";

/**
 * Row builders for `platform/persistence/schema.ts`.
 *
 * The suite used to spell out 380 `INSERT INTO` column lists by hand — `project`
 * alone in four shapes — so a new NOT NULL column meant editing 68 call sites and
 * a new test copied whichever shape it landed next to. A default here must be a
 * value the schema accepts; a value a test is deliberately exercising still
 * belongs at that test's call site.
 */

/**
 * Fishery's own `create`, at last.
 *
 * This file used to carry an `insert()` of its own, a hand-built `INSERT` string
 * and a `table()` helper, for one reason: `create` is async by contract and
 * `bun:sqlite` was not. Postgres is, so the workaround buys nothing and the three
 * pieces are gone. The database arrives as a transient parameter, which is what
 * Fishery documents for a dependency `build` must not touch — `build()` still
 * returns a plain object and writes nothing.
 */
type Transient = { db: DB };

/**
 * The columns a row cannot exist without, made on demand.
 *
 * Fishery's associations are resolved at build time and these need the database,
 * so they run in `onCreate` instead — and only when the caller did not supply the
 * key itself, which is what keeps a test that cares about the parent in control
 * of it.
 */
type Make = (db: DB) => Promise<unknown>;
type Parents<T> = { [K in keyof T]?: (db: DB) => Promise<T[K]> };

type Insert<T extends PgTable> = InferInsertModel<T>;
type Select<T extends PgTable> = InferSelectModel<T>;

function rows<T extends PgTable>(
  table: T,
  defaults: (opts: { sequence: number }) => Partial<Insert<T>>,
  parents: Parents<Insert<T>> = {},
): Factory<Insert<T>, Transient, Select<T>> {
  return Factory.define<Insert<T>, Transient, Select<T>>(({ sequence, transientParams, onCreate }) => {
    onCreate(async (row) => {
      const db = transientParams.db;
      if (!db) throw new Error("a factory's create() needs a database: pass { transient: { db } }, or use on(db)");
      const filled: Record<string, unknown> = { ...row };
      // `Record<string, Make>` rather than `Object.entries`: entries on a mapped
      // type widens the value to `Function`, which is not callable under lint.
      const makers: Record<string, Make | undefined> = parents;
      for (const [column, make] of Object.entries(makers)) {
        if (!make) continue;
        if (filled[column] === undefined || filled[column] === null) filled[column] = await make(db);
      }
      // `values()` wants the table's own insert shape and `filled` is assembled
      // key by key, which no inference can follow. The generic is what makes it
      // opaque here; every caller below still gets the real column types.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `filled` is assembled key by key from this table's own defaults and parents; no inference can follow that
      const values = filled as PgInsertValue<T>;
      // `returning()` types its rows through `Assume<T, PgTable>["$inferSelect"]`,
      // which TypeScript cannot prove is `InferSelectModel<T>` while T is still a
      // parameter. It is the same table either way; the generic is what hides it.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `returning()` on this table returns this table's row; only the generic obscures it
      const returned = (await db.insert(table).values(values).returning()) as Select<T>[];
      const first = returned[0];
      if (!first) throw new Error("insert returned no row");
      return first;
    });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Fishery's generator returns the whole row; the missing keys arrive from a test's own params, which is the point of a factory
    return defaults({ sequence }) as Insert<T>;
  });
}

/**
 * Every factory bound to one database, so a test names it once.
 *
 * `transient()` is Fishery's, and it returns a clone — the module-level factories
 * keep no database, which is what lets two test files run in one process without
 * seeing each other's.
 */
export function on(db: DB) {
  return {
    project: project.transient({ db }),
    grp: grp.transient({ db }),
    runningGrp: runningGrp.transient({ db }),
    agent: agent.transient({ db }),
    slice: slice.transient({ db }),
    acceptedSlice: acceptedSlice.transient({ db }),
    task: task.transient({ db }),
    job: job.transient({ db }),
    event: event.transient({ db }),
    note: note.transient({ db }),
    resource: resource.transient({ db }),
    lease: lease.transient({ db }),
    member: member.transient({ db }),
    cursor: cursor.transient({ db }),
    escalation: escalation.transient({ db }),
    channel: channel.transient({ db }),
    setting: setting.transient({ db }),
    idempotencyRequest: idempotencyRequest.transient({ db }),
    usageSnapshot: usageSnapshot.transient({ db }),
    runtimeAuth: runtimeAuth.transient({ db }),
  };
}

export const project = rows(schema.project, ({ sequence }) => ({
  name: `p${sequence}`,
  repo_path: "/tmp/p",
  created_at: 0,
}));

const channel = rows(schema.channel, () => ({ kind: "group", created_at: 0 }));

const agent = rows(schema.agent, () => ({ role: "engineer", model: "m", created_at: 0 }));

const grp = rows(schema.grp, ({ sequence }) => ({ name: `g${sequence}`, status: "DRAFT" as const, created_at: 0 }), {
  project_id: async (db) => (await project.create({}, { transient: { db } })).id,
});

const slice = rows(
  schema.slice,
  ({ sequence }) => ({ seq: sequence, title: `S${sequence}`, accept_spec: "x", created_at: 0 }),
  { grp_id: async (db) => (await grp.create({}, { transient: { db } })).id },
);

const task = rows(schema.task, ({ sequence }) => ({ title: `t${sequence}`, created_at: 0 }), {
  grp_id: async (db) => (await grp.create({}, { transient: { db } })).id,
});

const job = rows(schema.job, () => ({ kind: "agent_turn", enqueued_at: 0 }));

export const event = rows(schema.event, () => ({ author: "x", kind: "say", at: 0 }));

const note = rows(schema.note, () => ({ kind: "fact", lang: "zh", body: "n", at: 0 }));

const resource = rows(schema.resource, ({ sequence }) => ({ name: `res${sequence}`, template: "true" }));

const lease = rows(schema.lease, () => ({ enqueued_at: 0 }), {
  resource: async (db) => (await resource.create({}, { transient: { db } })).name,
});

const member = rows(schema.member, () => ({}), {
  channel_id: async (db) => (await channel.create({}, { transient: { db } })).id,
  agent_id: async (db) => (await agent.create({}, { transient: { db } })).id,
});

const cursor = rows(schema.cursor, () => ({}), {
  agent_id: async (db) => (await agent.create({}, { transient: { db } })).id,
  channel_id: async (db) => (await channel.create({}, { transient: { db } })).id,
});

const escalation = rows(schema.escalation, () => ({
  severity: "advisory",
  question: "q",
  chain_state: "pm" as const,
  created_at: 0,
}));

const setting = rows(schema.setting, ({ sequence }) => ({ k: `k${sequence}`, v: "{}" }));

const idempotencyRequest = rows(schema.idempotency_request, ({ sequence }) => ({
  caller: "boss",
  route: "/write",
  key: `key-${sequence}`,
  payload_hash: "hash",
  state: "in_progress",
  created_at: 0,
  updated_at: 0,
}));

const usageSnapshot = rows(schema.usage_snapshot, () => ({ runtime: "claude", json: {}, at: 0 }));

const runtimeAuth = rows(schema.runtime_auth, () => ({
  runtime: "claude",
  mode: "token",
  secret: "s",
  updated_at: 0,
}));

/** The states tests re-create by hand often enough to name. */
const runningGrp = grp.params({ status: "RUNNING" });
const acceptedSlice = slice.params({ status: "accepted" });
