// fallow-ignore-file unused-file -- nothing in `src` reads this yet: it lands ahead of the query sites so that `test/platform/schema-equivalence.test.ts` can prove it matches the migrated database before anything depends on it. `stale-suppressions` deletes this line for whoever writes the first Drizzle query.
import { sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { index, integer, primaryKey, real, sqliteTable, text, unique, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * The database as the 46 migrations in `database.ts` leave it, described once.
 *
 * Not a second source of truth: `test/platform/schema-equivalence.test.ts` reads
 * both and fails on any difference, so this file is a typed view of the migrated
 * schema rather than a definition of it. Column keys are the SQL names, because
 * every row shape in the codebase is already read that way.
 */

export const project = sqliteTable("project", {
  id: integer().primaryKey({ autoIncrement: true }),
  name: text().notNull().unique(),
  repo_path: text().notNull(),
  remote: text(),
  config_json: text().notNull().default("{}"),
  created_at: integer().notNull(),
  sandbox_id: text(),
  sandbox_at: integer(),
  base_branch: text(),
  base_branch_pinned: integer().notNull().default(0),
});

export const grp = sqliteTable(
  "grp",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    project_id: integer()
      .notNull()
      .references(() => project.id),
    name: text().notNull(),
    branch: text(),
    status: text().notNull().default("DRAFT"),
    owns_json: text().notNull().default("[]"),
    budget_tokens: integer(),
    spent_tokens: integer().notNull().default(0),
    created_at: integer().notNull(),
    paused_at: integer(),
    merge_seq: integer(),
    pr_number: integer(),
    pr_seen_at: integer().notNull().default(0),
    pr_checks_sig: text(),
    rl_resets_at: integer(),
    approved_at: integer(),
    blocked_on: integer().references((): AnySQLiteColumn => grp.id),
    merge_seq_at: integer(),
    pr_retries: integer().notNull().default(0),
    shared_grant: text(),
    rebase_seen: text(),
    rebase_seen_at: integer(),
    sandbox_id: text(),
    sandbox_at: integer(),
    pr_title: text(),
    pr_summary: text(),
    pause_reason: text(),
    paused_from: text(),
  },
  (t) => [unique().on(t.project_id, t.name)],
);

export const agent = sqliteTable(
  "agent",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    project_id: integer().references(() => project.id),
    grp_id: integer().references(() => grp.id),
    role: text().notNull(),
    model: text().notNull(),
    session_id: text(),
    session_tokens: integer().notNull().default(0),
    total_tokens: integer().notNull().default(0),
    cwd: text(),
    activity: text(),
    state: text().notNull().default("idle"),
    created_at: integer().notNull(),
    token: text(),
    stable_hash: text(),
    idle_turns: integer().notNull().default(0),
    loop_file: text(),
    loop_count: integer().notNull().default(0),
    context_window: integer(),
    runtime: text().notNull().default("claude"),
  },
  (t) => [uniqueIndex("agent_token").on(t.token).where(sql`${t.token} IS NOT NULL`)],
);

export const channel = sqliteTable("channel", {
  id: integer().primaryKey({ autoIncrement: true }),
  project_id: integer().references(() => project.id),
  grp_id: integer().references(() => grp.id),
  kind: text().notNull(),
  status: text().notNull().default("open"),
  created_at: integer().notNull(),
});

export const cursor = sqliteTable(
  "cursor",
  {
    agent_id: integer()
      .notNull()
      .references(() => agent.id),
    channel_id: integer()
      .notNull()
      .references(() => channel.id),
    last_seq: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.agent_id, t.channel_id] })],
);

export const member = sqliteTable(
  "member",
  {
    channel_id: integer()
      .notNull()
      .references(() => channel.id),
    agent_id: integer()
      .notNull()
      .references(() => agent.id),
    mode: text().notNull().default("full"),
  },
  (t) => [primaryKey({ columns: [t.channel_id, t.agent_id] })],
);

export const slice = sqliteTable(
  "slice",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    grp_id: integer()
      .notNull()
      .references(() => grp.id),
    seq: integer().notNull(),
    title: text().notNull(),
    accept_spec: text().notNull(),
    difficulty: text().notNull().default("normal"),
    status: text().notNull().default("pending"),
    gates_json: text().notNull().default("{}"),
    budget_tokens: integer(),
    spent_tokens: integer().notNull().default(0),
    depends_on: integer().references((): AnySQLiteColumn => slice.id),
    created_at: integer().notNull(),
    base_sha: text(),
    retries: integer().notNull().default(0),
    awaiting_at: integer(),
  },
  (t) => [unique().on(t.grp_id, t.seq)],
);

export const task = sqliteTable(
  "task",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    grp_id: integer()
      .notNull()
      .references(() => grp.id),
    slice_id: integer().references(() => slice.id),
    title: text().notNull(),
    status: text().notNull().default("pending"),
    owner_agent_id: integer().references(() => agent.id),
    depends_on_json: text().notNull().default("[]"),
    claim_json: text(),
    created_at: integer().notNull(),
  },
  (t) => [index("task_grp").on(t.grp_id, t.status)],
);

export const note = sqliteTable(
  "note",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    project_id: integer().references(() => project.id),
    grp_id: integer().references(() => grp.id),
    slice_id: integer().references(() => slice.id),
    task_id: integer().references(() => task.id),
    kind: text().notNull(),
    lang: text().notNull().default("zh"),
    body: text().notNull(),
    frontmatter_json: text().notNull().default("{}"),
    export_path: text(),
    at: integer().notNull(),
    supersedes: integer().references((): AnySQLiteColumn => note.id),
  },
  (t) => [index("note_lookup").on(t.project_id, t.kind, sql`${t.at} DESC`)],
);

export const event = sqliteTable(
  "event",
  {
    seq: integer().primaryKey({ autoIncrement: true }),
    channel_id: integer().references(() => channel.id),
    grp_id: integer().references(() => grp.id),
    author: text().notNull(),
    kind: text().notNull(),
    intent: text(),
    severity: text(),
    body: text().notNull().default(""),
    target: text(),
    meta_json: text().notNull().default("{}"),
    at: integer().notNull(),
    correlation_id: text(),
    trace_id: text(),
    span_id: text(),
  },
  (t) => [
    index("event_channel").on(t.channel_id, t.seq),
    index("event_grp").on(t.grp_id, t.seq),
    index("event_correlation").on(t.correlation_id, t.seq),
  ],
);

export const job = sqliteTable(
  "job",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    kind: text().notNull(),
    grp_id: integer().references(() => grp.id),
    agent_id: integer().references(() => agent.id),
    slice_id: integer().references(() => slice.id),
    payload_json: text().notNull().default("{}"),
    priority: integer().notNull().default(0),
    state: text().notNull().default("pending"),
    pid: integer(),
    error: text(),
    enqueued_at: integer().notNull(),
    started_at: integer(),
    ended_at: integer(),
    checkpoint_sha: text(),
    correlation_id: text(),
    trace_id: text(),
    parent_span_id: text(),
    trace_flags: integer(),
  },
  (t) => [
    index("job_dispatch").on(t.state, sql`${t.priority} DESC`, t.id),
    index("job_grp").on(t.grp_id, t.state),
    index("job_correlation").on(t.correlation_id),
  ],
);

export const resource = sqliteTable("resource", {
  name: text().primaryKey(),
  concurrency: integer().notNull().default(1),
  template: text().notNull(),
  arg_schema_json: text().notNull().default("{}"),
  error_regex: text(),
  cwd: text(),
  tags_json: text().notNull().default("[]"),
});

export const lease = sqliteTable(
  "lease",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    resource: text()
      .notNull()
      .references(() => resource.name),
    grp_id: integer().references(() => grp.id),
    agent_id: integer().references(() => agent.id),
    args_json: text().notNull().default("{}"),
    resolved_cmd: text(),
    state: text().notNull().default("queued"),
    exit_code: integer(),
    log_path: text(),
    result_digest: text(),
    enqueued_at: integer().notNull(),
    started_at: integer(),
    ended_at: integer(),
    head_sha: text(),
  },
  (t) => [index("lease_queue").on(t.resource, t.state, t.id)],
);

export const escalation = sqliteTable(
  "escalation",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    grp_id: integer().references(() => grp.id),
    agent_id: integer().references(() => agent.id),
    severity: text().notNull().default("advisory"),
    question: text().notNull(),
    chain_state: text().notNull().default("pm"),
    answered_by: text(),
    answer: text(),
    ref_note_id: integer().references(() => note.id),
    checkpoint_sha: text(),
    created_at: integer().notNull(),
    answered_at: integer(),
    brief: text(),
    kind: text(),
  },
  (t) => [index("escalation_open").on(t.chain_state, t.created_at)],
);

export const span = sqliteTable(
  "span",
  {
    trace_id: text().notNull(),
    span_id: text().notNull(),
    parent_span_id: text(),
    name: text().notNull(),
    kind: text().notNull(),
    started_at: integer().notNull(),
    duration_ms: real().notNull(),
    status: text().notNull(),
    attributes_json: text().notNull().default("{}"),
    project_id: integer(),
    grp_id: integer(),
    slice_id: integer(),
    status_message: text(),
  },
  (t) => [
    primaryKey({ columns: [t.trace_id, t.span_id] }),
    index("span_age").on(t.started_at),
    index("span_scope").on(t.grp_id, t.slice_id, t.started_at),
  ],
);

export const idempotency_request = sqliteTable(
  "idempotency_request",
  {
    caller: text().notNull(),
    route: text().notNull(),
    key: text().notNull(),
    payload_hash: text().notNull(),
    state: text().notNull(),
    status: integer(),
    body: text(),
    content_type: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.caller, t.route, t.key] }), index("idempotency_request_age").on(t.updated_at)],
);

export const setting = sqliteTable("setting", {
  k: text().primaryKey(),
  v: text().notNull(),
});

export const runtime_auth = sqliteTable("runtime_auth", {
  runtime: text().primaryKey(),
  mode: text().notNull(),
  secret: text().notNull(),
  base_url: text(),
  updated_at: integer().notNull(),
});

export const usage_snapshot = sqliteTable("usage_snapshot", {
  runtime: text().primaryKey(),
  json: text().notNull(),
  at: integer().notNull(),
  hold_until: integer(),
});

/** Written by `migrate()` itself, not by a migration, and still part of the schema. */
export const migration = sqliteTable("migration", {
  n: integer().primaryKey(),
  at: integer().notNull(),
});
