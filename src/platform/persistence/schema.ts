import { sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import type { EscalationState, GrpState, JobState, LeaseState, SliceState, TaskState } from "../../contracts/states.ts";
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
  // `owner/name`, not a directory on disk, whatever the name suggests: a project
  // outlives the laptop it was registered from. A row whose remote yields no slug
  // keeps exactly what it had — a guessed owner writes somebody else's repository.
  repo_path: text().notNull(),
  remote: text(),
  config_json: text().notNull().default("{}"),
  created_at: integer().notNull(),
  // Durable because the Sandbox object is not: a restarted orchestrator reconnects
  // to the container still running, or the turn's session — and the cached prefix
  // the cost model rests on — dies with the process.
  sandbox_id: text(),
  // A sidecar is loaded with the credentials that existed when it was built and
  // never again, so a sandbox older than the newest credential is stale whoever
  // stored it, and the watchdog reaps it on the next tick.
  sandbox_at: integer(),
  // NULL means "ask the remote", resolved once and written back here, so the diff
  // baseline is the same value on the day a slice was cut and on the day the boss
  // reads it.
  base_branch: text(),
  // Whether the boss chose the base branch or we inferred it. Unpinned, GitHub's
  // `default_branch` is written over `base_branch` on every call, so a branch
  // picked in settings is reverted within one tick.
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
    status: text().notNull().default("DRAFT").$type<GrpState>(),
    owns_json: text().notNull().default("[]"),
    budget_tokens: integer(),
    spent_tokens: integer().notNull().default(0),
    created_at: integer().notNull(),
    paused_at: integer(),
    // Merge order, assigned when a branch passes its audit, and strictly serial:
    // the alternative is finding out on main which of two groups broke it.
    merge_seq: integer(),
    pr_number: integer(),
    // How far this PR's comments have been read.
    pr_seen_at: integer().notNull().default(0),
    // Which failing checks were already reported. A check that stays red is one
    // piece of news, not one every poll.
    pr_checks_sig: text(),
    // When the account's quota comes back. A rate limit degrades to a cheaper
    // model and otherwise waits for this.
    rl_resets_at: integer(),
    // The boss approved, even if a boundary was in the way at the time. One click
    // has to be final.
    approved_at: integer(),
    // The group this one is waiting on. Recording which group owns the problem is
    // what lets the waiter start again by itself when that group lands.
    blocked_on: integer().references((): AnySQLiteColumn => grp.id),
    // When this branch joined the merge queue. It is strictly serial, so a head
    // nobody merges blocks everything behind it, and without a clock "the boss
    // forgot" and "it only just got there" look identical.
    merge_seq_at: integer(),
    // Branch-level rework counter: two rounds, then escalate.
    pr_retries: integer().notNull().default(0),
    // Shared paths this one group was granted, by name. Shared files belong to no
    // group, but a defect *in* one still has to be fixable: the grant names that
    // path and lets one requirement through while every other group is refused.
    shared_grant: text(),
    // The main commit this group has already been told to rebase onto. Without it
    // the same nudge fires every watchdog tick until the rebase finishes, which is
    // how a useful message becomes one the agent learns to skip.
    rebase_seen: text(),
    // When it was last told; the clock is what lets a burst of pushes coalesce.
    rebase_seen_at: integer(),
    // Same durability and staleness rules as `project.sandbox_id`/`sandbox_at`.
    sandbox_id: text(),
    sandbox_at: integer(),
    // Written by an agent that read the branch. Two columns so the commit and the
    // PR can differ where they should: `pr_title` is the subject both use,
    // `pr_summary` the commit body and the PR's first section.
    pr_title: text(),
    pr_summary: text(),
    // Why, where `paused_at` says only when. Eight places write it for eight
    // causes, so one bulk resume keyed on state alone matches every PAUSED row
    // there is; 'unknown' where nothing recorded a cause, because a wrong reason
    // resumes the wrong group.
    pause_reason: text(),
    // The state to put the group back into. Restoring RUNNING unconditionally
    // drops a rate-limited group out of the merge order, which filters on PR_OPEN.
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
    // The agent's identity. Anything else on 127.0.0.1 can reach the server too,
    // so it comes from a token the spawner injects into the turn's environment,
    // never from a request field an agent could simply change.
    token: text(),
    // Hash of the session's stable prompt half. If the role prompt, model, tool
    // whitelist or lessons list changes the cached prefix is dead, and the executor
    // rotates the session rather than silently paying full price on every turn.
    stable_hash: text(),
    // What the watchdog needs to call an agent stuck, and it has to be
    // *deterministic*: a model asked "are you going in circles?" says no.
    idle_turns: integer().notNull().default(0),
    loop_file: text(),
    loop_count: integer().notNull().default(0),
    // What this agent's model actually reported during a turn. Both CLIs state it;
    // a table in config goes stale the week a model ships.
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

/** Bounded delta injection: a turn gets the unread since `last_seq`, then advances it. */
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
    // full | rep, where rep is pulled in as another group's representative.
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
    // Picks the model.
    difficulty: text().notNull().default("normal"),
    status: text().notNull().default("pending").$type<SliceState>(),
    gates_json: text().notNull().default("{}"),
    budget_tokens: integer(),
    spent_tokens: integer().notNull().default(0),
    depends_on: integer().references((): AnySQLiteColumn => slice.id),
    created_at: integer().notNull(),
    // Reconcile's baseline for this slice. It has to compare what changed *in this
    // slice*, not on the branch, or every slice after the first inherits the
    // previous ones' diff.
    base_sha: text(),
    retries: integer().notNull().default(0),
    // When this slice started waiting on the boss. Wasted work is counted in
    // slices, which means nothing unless the clock on one is visible.
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
    status: text().notNull().default("pending").$type<TaskState>(),
    owner_agent_id: integer().references(() => agent.id),
    depends_on_json: text().notNull().default("[]"),
    // What the agent *claims* it produced; reconcile diffs it against git.
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
    // Which decision this one overturns. Retrieval weights `decision` highest
    // there is, so a reversed one comes back ranked above everything with nothing
    // in the answer saying it no longer holds; this edge is what lets retrieval
    // skip it, and without it the blackboard only grows.
    supersedes: integer().references((): AnySQLiteColumn => note.id),
  },
  (t) => [index("note_lookup").on(t.project_id, t.kind, sql`${t.at} DESC`)],
);

/** Append-only. The timeline, the desk wall and the channel views all read this. */
export const event = sqliteTable(
  "event",
  {
    seq: integer().primaryKey({ autoIncrement: true }),
    channel_id: integer().references(() => channel.id),
    grp_id: integer().references(() => grp.id),
    author: text().notNull(),
    kind: text().notNull(),
    // ask | request | inform | note | decision — five, deliberately. Anything
    // finer a reader wants is a field, not a sixth intent.
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

/**
 * The only thing that can start an agent.
 *
 * Intercept, park and budget-halt are all just operations on this queue.
 */
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
    state: text().notNull().default("pending").$type<JobState>(),
    pid: integer(),
    error: text(),
    enqueued_at: integer().notNull(),
    started_at: integer(),
    ended_at: integer(),
    checkpoint_sha: text(),
    correlation_id: text(),
    trace_id: text(),
    parent_span_id: text(),
    // The sampling decision travels with the job. Rebuilt from the parent context
    // with SAMPLED written out instead, a job enqueued by a request the sampler
    // had dropped comes back sampled, and every span under it with it. NULL on
    // rows written before the column existed.
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
  // Agents pick a name plus validated args, never a free-form command: the Runner
  // runs on the host with real privileges.
  template: text().notNull(),
  arg_schema_json: text().notNull().default("{}"),
  error_regex: text(),
  cwd: text(),
  // What this resource contends for, so the Runner pool can be split by it. One
  // global slot count must be the minimum any resource tolerates: sized for the
  // browser, every gate queues behind one screenshot; sized for `typecheck`, the
  // browsers thrash.
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
    state: text().notNull().default("queued").$type<LeaseState>(),
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
    chain_state: text().notNull().default("pm").$type<EscalationState>(),
    answered_by: text(),
    answer: text(),
    ref_note_id: integer().references(() => note.id),
    checkpoint_sha: text(),
    created_at: integer().notNull(),
    answered_at: integer(),
    // One line of what the question is about, for the queue. `question` is an
    // agent writing to another agent, shown to a reader whose whole job here is
    // picking which one to open.
    brief: text(),
    // What kind of thing is being asked. One bad premise strands every slice
    // behind it, so a requirement can hold a dozen open questions that are the
    // same problem said twelve times — twelve decisions on a page where there is
    // one.
    kind: text(),
  },
  (t) => [index("escalation_open").on(t.chain_state, t.created_at)],
);

/** Spans land here, so the panel has a trace to read without a collector. */
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
    // Scope. Nullable because a system span belongs to no project, and
    // deliberately **not** foreign keys: a span is an observation, not a reference
    // to something that still exists, and retention rather than referential
    // integrity is what bounds this table.
    project_id: integer(),
    grp_id: integer(),
    slice_id: integer(),
    // Why the span failed. `setStatus` takes a message and every error path passes
    // one; with nowhere to put it the panel can say `index.ask` failed and never
    // that the reason was a missing credential.
    status_message: text(),
  },
  (t) => [
    primaryKey({ columns: [t.trace_id, t.span_id] }),
    // Its own index: the retention scan is what neither of the others serves.
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

/** Server-scope settings: this machine's, not a project's and not the yaml's. */
export const setting = sqliteTable("setting", {
  k: text().primaryKey(),
  // JSON, including for a plain string. One value, one encoding.
  v: text().notNull(),
});

export const runtime_auth = sqliteTable("runtime_auth", {
  runtime: text().primaryKey(),
  mode: text().notNull(),
  // Never enters the sandbox: it goes to the egress sidecar's vault and is
  // injected on the way out (docs/adr/005), never into an event, a prompt or a
  // log, and the API returns it masked.
  secret: text().notNull(),
  // An OpenAI-compatible endpoint is configuration, not a fork.
  base_url: text(),
  updated_at: integer().notNull(),
});

/**
 * How much of each subscription window is gone. One row per provider, overwritten.
 *
 * A table rather than a variable, so the header is not blank after a restart
 * waiting for the next turn to refill it.
 */
export const usage_snapshot = sqliteTable("usage_snapshot", {
  runtime: text().primaryKey(),
  json: text().notNull(),
  at: integer().notNull(),
  // When the provider's window comes back — it belongs to the account, not the
  // group that hit it. The scheduler will not dispatch for a held provider, and
  // the hold expires by clock, so nothing polls and nobody has to be awake to
  // lift it.
  hold_until: integer(),
});

/** Written by `migrate()` itself, not by a migration, and still part of the schema. */
export const migration = sqliteTable("migration", {
  n: integer().primaryKey(),
  at: integer().notNull(),
});
