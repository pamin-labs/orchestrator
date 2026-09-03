import { sql } from "drizzle-orm";
import type { AnyPgColumn, PgColumn } from "drizzle-orm/pg-core";
import type { Json } from "../../contracts/json.ts";
import {
  ESCALATION_STATES,
  GRP_STATES,
  JOB_STATES,
  LEASE_STATES,
  SLICE_STATES,
  TASK_STATES,
} from "../../contracts/states.ts";
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * The database. Not a description of one — this file is where it is decided.
 *
 * It began as a typed view of 46 hand-written migrations, checked against them by
 * a test. Those are gone: `drizzle-kit generate` derives the migrations from this,
 * so the two cannot disagree and the check has nothing left to compare. Column
 * keys are the SQL names, because every row shape in the codebase is read that
 * way. A `jsonb` column is typed `Json` and not its validated shape, deliberately:
 * rows written by an older build are still in there. Read sites validate.
 */

/**
 * The state vocabulary, enforced where a write cannot argue with it.
 *
 * `text({ enum })` narrows the TypeScript type and, through `drizzle-orm/zod`,
 * the runtime schema — but it emits no SQL, so anything writing outside the app
 * could still store a word `states.ts` has never heard of. SQLite enforced this
 * with a pair of triggers per column because it cannot add a CHECK; Postgres can.
 * Built from the same constant as the column, so there is one list, not two.
 */
const stateCheck = (column: PgColumn, states: readonly string[]) =>
  check(`${column.uniqueName ?? column.name}_state`, sql`${column} IN ${states}`);

/**
 * Now, in epoch milliseconds, from the database's clock rather than a caller's.
 *
 * `unixepoch() * 1000` said this 29 times and Postgres has no such function, so
 * it is written once here instead of translated 29 times. Use it only where the
 * clock has to be the database's — one row's `created_at` compared against
 * another's, written by two processes whose clocks are not the same one. Where a
 * caller already has a timestamp, `Date.now()` is cheaper and just as true.
 */
export const nowMs = sql<number>`(extract(epoch from now()) * 1000)::bigint`;

/**
 * The newest of a `bigint` timestamp column, as a number.
 *
 * Not Drizzle's `max()`: on a `bigint` it renders `max("at")::text`, so the value
 * survives the trip into JS with its precision. Selected that is right; compared
 * it is a lexicographic comparison of digit strings, and put beside a `bigint` it
 * is a 42883 with no operator at all. Both were live — the panel's draft cards
 * threw, and the watchdog's staleness rule was ordering timestamps as text.
 */
export const maxMs = (column: PgColumn) => sql<number>`max(${column})`.mapWith(Number);

export const project = pgTable("project", {
  id: integer().primaryKey().generatedByDefaultAsIdentity(),
  name: text().notNull().unique(),
  // `owner/name`, not a directory on disk, whatever the name suggests: a project
  // outlives the laptop it was registered from. A row whose remote yields no slug
  // keeps exactly what it had — a guessed owner writes somebody else's repository.
  repo_path: text().notNull(),
  remote: text(),
  config_json: jsonb().$type<Json>().notNull().default({}),
  created_at: bigint({ mode: "number" }).notNull(),
  // Durable because the Sandbox object is not: a restarted orchestrator reconnects
  // to the container still running, or the turn's session — and the cached prefix
  // the cost model rests on — dies with the process.
  sandbox_id: text(),
  // A sidecar is loaded with the credentials that existed when it was built and
  // never again, so a sandbox older than the newest credential is stale whoever
  // stored it, and the watchdog reaps it on the next tick.
  sandbox_at: bigint({ mode: "number" }),
  // NULL means "ask the remote", resolved once and written back here, so the diff
  // baseline is the same value on the day a slice was cut and on the day the boss
  // reads it.
  base_branch: text(),
  // Whether the boss chose the base branch or we inferred it. Unpinned, GitHub's
  // `default_branch` is written over `base_branch` on every call, so a branch
  // picked in settings is reverted within one tick.
  base_branch_pinned: boolean().notNull().default(false),
});

export const grp = pgTable(
  "grp",
  {
    id: integer().primaryKey().generatedByDefaultAsIdentity(),
    project_id: integer()
      .notNull()
      .references(() => project.id),
    name: text().notNull(),
    // What the boss reads, where `name` is what git and the CLI read. `name` is
    // the branch, the worktree path, the journal path and the key agents address
    // a group by, under a unique constraint — so it stays an ascii slug and the
    // sentence goes here. Null on every group nothing wrote a title for, and the
    // panel falls back to `name` for those.
    title: text(),
    branch: text(),
    status: text({ enum: GRP_STATES }).notNull().default("DRAFT"),
    owns_json: jsonb().$type<Json>().notNull().default([]),
    budget_tokens: bigint({ mode: "number" }),
    spent_tokens: bigint({ mode: "number" }).notNull().default(0),
    created_at: bigint({ mode: "number" }).notNull(),
    paused_at: bigint({ mode: "number" }),
    // Merge order, assigned when a branch passes its audit, and strictly serial:
    // the alternative is finding out on main which of two groups broke it.
    merge_seq: integer(),
    pr_number: integer(),
    // How far this PR's comments have been read.
    pr_seen_at: bigint({ mode: "number" }).notNull().default(0),
    // Which failing checks were already reported. A check that stays red is one
    // piece of news, not one every poll.
    pr_checks_sig: text(),
    // When the account's quota comes back. A rate limit degrades to a cheaper
    // model and otherwise waits for this.
    rl_resets_at: bigint({ mode: "number" }),
    // The boss approved, even if a boundary was in the way at the time. One click
    // has to be final.
    approved_at: bigint({ mode: "number" }),
    // The group this one is waiting on. Recording which group owns the problem is
    // what lets the waiter start again by itself when that group lands.
    blocked_on: integer().references((): AnyPgColumn => grp.id),
    // When this branch joined the merge queue. It is strictly serial, so a head
    // nobody merges blocks everything behind it, and without a clock "the boss
    // forgot" and "it only just got there" look identical.
    merge_seq_at: bigint({ mode: "number" }),
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
    rebase_seen_at: bigint({ mode: "number" }),
    // How far this branch is from the base, measured every watchdog tick in the
    // group's own clone. Null until the first measurement. `rebase_seen` says a
    // nudge was sent; these say whether it was acted on.
    base_ahead: integer(),
    base_behind: integer(),
    // Same durability and staleness rules as `project.sandbox_id`/`sandbox_at`.
    sandbox_id: text(),
    sandbox_at: bigint({ mode: "number" }),
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
  (t) => [unique().on(t.project_id, t.name), stateCheck(t.status, GRP_STATES)],
);

export const agent = pgTable(
  "agent",
  {
    id: integer().primaryKey().generatedByDefaultAsIdentity(),
    project_id: integer().references(() => project.id),
    grp_id: integer().references(() => grp.id),
    role: text().notNull(),
    model: text().notNull(),
    session_id: text(),
    session_tokens: bigint({ mode: "number" }).notNull().default(0),
    total_tokens: bigint({ mode: "number" }).notNull().default(0),
    cwd: text(),
    activity: text(),
    state: text().notNull().default("idle"),
    created_at: bigint({ mode: "number" }).notNull(),
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

export const channel = pgTable("channel", {
  id: integer().primaryKey().generatedByDefaultAsIdentity(),
  project_id: integer().references(() => project.id),
  grp_id: integer().references(() => grp.id),
  kind: text().notNull(),
  status: text().notNull().default("open"),
  created_at: bigint({ mode: "number" }).notNull(),
});

/** Bounded delta injection: a turn gets the unread since `last_seq`, then advances it. */
export const cursor = pgTable(
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

export const member = pgTable(
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

export const slice = pgTable(
  "slice",
  {
    id: integer().primaryKey().generatedByDefaultAsIdentity(),
    grp_id: integer()
      .notNull()
      .references(() => grp.id),
    seq: integer().notNull(),
    title: text().notNull(),
    accept_spec: text().notNull(),
    // Picks the model.
    difficulty: text().notNull().default("normal"),
    status: text({ enum: SLICE_STATES }).notNull().default("pending"),
    gates_json: jsonb().$type<Json>().notNull().default({}),
    budget_tokens: bigint({ mode: "number" }),
    spent_tokens: bigint({ mode: "number" }).notNull().default(0),
    depends_on: integer().references((): AnyPgColumn => slice.id),
    created_at: bigint({ mode: "number" }).notNull(),
    // Reconcile's baseline for this slice. It has to compare what changed *in this
    // slice*, not on the branch, or every slice after the first inherits the
    // previous ones' diff.
    base_sha: text(),
    retries: integer().notNull().default(0),
    // When this slice started waiting on the boss. Wasted work is counted in
    // slices, which means nothing unless the clock on one is visible.
    awaiting_at: bigint({ mode: "number" }),
  },
  (t) => [unique().on(t.grp_id, t.seq), stateCheck(t.status, SLICE_STATES)],
);

export const task = pgTable(
  "task",
  {
    id: integer().primaryKey().generatedByDefaultAsIdentity(),
    grp_id: integer()
      .notNull()
      .references(() => grp.id),
    slice_id: integer().references(() => slice.id),
    title: text().notNull(),
    status: text({ enum: TASK_STATES }).notNull().default("pending"),
    owner_agent_id: integer().references(() => agent.id),
    depends_on_json: jsonb().$type<Json>().notNull().default([]),
    // What the agent *claims* it produced; reconcile diffs it against git.
    claim_json: jsonb().$type<Json>(),
    created_at: bigint({ mode: "number" }).notNull(),
  },
  (t) => [index("task_grp").on(t.grp_id, t.status), stateCheck(t.status, TASK_STATES)],
);

export const note = pgTable(
  "note",
  {
    id: integer().primaryKey().generatedByDefaultAsIdentity(),
    project_id: integer().references(() => project.id),
    grp_id: integer().references(() => grp.id),
    slice_id: integer().references(() => slice.id),
    task_id: integer().references(() => task.id),
    kind: text().notNull(),
    /**
     * What language this note is written in, stated by whoever writes it.
     * Nullable because `saveSingletonNote` stores JSON blobs, which are in no
     * language — it used to default to `zh`, from when the product had one.
     */
    lang: text(),
    body: text().notNull(),
    frontmatter_json: jsonb().$type<Json>().notNull().default({}),
    export_path: text(),
    at: bigint({ mode: "number" }).notNull(),
    // Which decision this one overturns. Retrieval weights `decision` highest
    // there is, so a reversed one comes back ranked above everything with nothing
    // in the answer saying it no longer holds; this edge is what lets retrieval
    // skip it, and without it the blackboard only grows.
    supersedes: integer().references((): AnyPgColumn => note.id),
  },
  (t) => [
    index("note_lookup").on(t.project_id, t.kind, sql`${t.at} DESC`),
    // The other way in, and the panel's: `note_lookup` leads with `project_id`,
    // which none of the group reads know. Both of the snapshot's `DISTINCT ON
    // (grp_id) … ORDER BY grp_id, at DESC, id DESC` cards, the correlated
    // `max(at)` behind the late-objection window, and the approve path's "which
    // card was filed" all name a group and no project, so every one of them was
    // reading the table. The column order is that `ORDER BY` spelled out, so the
    // distinct is a scan rather than a sort.
    index("note_grp").on(t.grp_id, sql`${t.at} DESC`, sql`${t.id} DESC`),
  ],
);

/** Append-only. The timeline, the desk wall and the channel views all read this. */
export const event = pgTable(
  "event",
  {
    seq: integer().primaryKey().generatedByDefaultAsIdentity(),
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
    meta_json: jsonb().$type<Json>().notNull().default({}),
    at: bigint({ mode: "number" }).notNull(),
    correlation_id: text(),
    trace_id: text(),
    span_id: text(),
  },
  (t) => [
    index("event_channel").on(t.channel_id, t.seq),
    index("event_grp").on(t.grp_id, t.seq),
    index("event_correlation").on(t.correlation_id, t.seq),
    // Every read that names a kind, which is every read that is not a channel
    // tail. `state_change` is the kind by volume — seventy-nine emitters against
    // four for `tool_summary` — and no reader wants it, so the prefix is what
    // turns "scan the log" into "scan the handful of rows that could match": the
    // cost panel's 24-hour histogram and its recent-turn sample, the watchdog's
    // per-finding re-emit clock, and the two draft-group reads in the snapshot.
    // `at` and not `seq` as the second column, so the histogram's window is an
    // index range rather than a filter — `recentTurns` orders by `at` for the
    // same reason.
    index("event_kind").on(t.kind, t.at),
    // Retention, which had nothing. `trimEvents` runs on the thirty-second
    // heartbeat and its predicate is `at < cutoff AND kind NOT IN (…)`; the
    // negation cannot use `event_kind` at all, so this was a sequential scan of
    // the largest table twice a minute, for ever, to delete nothing.
    //
    // Not a partial index on the same `NOT IN`, which is the tempting shape:
    // Drizzle renders `notInArray` as bind parameters, and matching a partial
    // index's predicate needs constants at plan time — under a generic plan the
    // implication fails and the index is simply never chosen. An index that
    // looks right and is never used is worse than none.
    index("event_age").on(t.at),
  ],
);

/**
 * The only thing that can start an agent.
 *
 * Intercept, park and budget-halt are all just operations on this queue.
 */
export const job = pgTable(
  "job",
  {
    id: integer().primaryKey().generatedByDefaultAsIdentity(),
    kind: text().notNull(),
    grp_id: integer().references(() => grp.id),
    agent_id: integer().references(() => agent.id),
    slice_id: integer().references(() => slice.id),
    payload_json: jsonb().$type<Json>().notNull().default({}),
    priority: integer().notNull().default(0),
    state: text({ enum: JOB_STATES }).notNull().default("pending"),
    pid: integer(),
    error: text(),
    enqueued_at: bigint({ mode: "number" }).notNull(),
    started_at: bigint({ mode: "number" }),
    ended_at: bigint({ mode: "number" }),
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
    // The two correlated subqueries the desk wall is drawn from — how many turns
    // this agent has finished, and which slice its newest job was for. Nothing
    // prunes this table, so both grew with the age of the installation while the
    // panel asked them at up to four times a second. `id` second because the
    // slice lookup is `ORDER BY id DESC LIMIT 1`.
    index("job_agent").on(t.agent_id, t.id),
    stateCheck(t.state, JOB_STATES),
  ],
);

export const resource = pgTable("resource", {
  name: text().primaryKey(),
  concurrency: integer().notNull().default(1),
  // Agents pick a name plus validated args, never a free-form command: the Runner
  // runs on the host with real privileges.
  template: text().notNull(),
  arg_schema_json: jsonb().$type<Json>().notNull().default({}),
  error_regex: text(),
  cwd: text(),
  // What this resource contends for, so the Runner pool can be split by it. One
  // global slot count must be the minimum any resource tolerates: sized for the
  // browser, every gate queues behind one screenshot; sized for `typecheck`, the
  // browsers thrash.
  tags_json: jsonb().$type<Json>().notNull().default([]),
});

export const lease = pgTable(
  "lease",
  {
    id: integer().primaryKey().generatedByDefaultAsIdentity(),
    resource: text()
      .notNull()
      .references(() => resource.name),
    grp_id: integer().references(() => grp.id),
    agent_id: integer().references(() => agent.id),
    args_json: jsonb().$type<Json>().notNull().default({}),
    resolved_cmd: text(),
    state: text({ enum: LEASE_STATES }).notNull().default("queued"),
    exit_code: integer(),
    log_path: text(),
    result_digest: text(),
    enqueued_at: bigint({ mode: "number" }).notNull(),
    started_at: bigint({ mode: "number" }),
    ended_at: bigint({ mode: "number" }),
    head_sha: text(),
  },
  (t) => [index("lease_queue").on(t.resource, t.state, t.id), stateCheck(t.state, LEASE_STATES)],
);

export const escalation = pgTable(
  "escalation",
  {
    id: integer().primaryKey().generatedByDefaultAsIdentity(),
    grp_id: integer().references(() => grp.id),
    agent_id: integer().references(() => agent.id),
    severity: text().notNull().default("advisory"),
    question: text().notNull(),
    chain_state: text({ enum: ESCALATION_STATES }).notNull().default("pm"),
    answered_by: text(),
    answer: text(),
    ref_note_id: integer().references(() => note.id),
    checkpoint_sha: text(),
    created_at: bigint({ mode: "number" }).notNull(),
    answered_at: bigint({ mode: "number" }),
    // What the question is about, for the matchers. Dedupe, auto-answer and
    // revoke used to compare the opening line of `question` — a primary key made
    // of a sentence, so editing the sentence broke them and nothing failed.
    // Null where nothing matches: an agent's own question is not a subject the
    // server names. `escalate.ts` owns the vocabulary.
    dedupe_key: text(),
    // One line of what the question is about, for the queue. `question` is an
    // agent writing to another agent, shown to a reader whose whole job here is
    // picking which one to open.
    brief: text(),
    // The descriptors `question` and `brief` were rendered from, where the server
    // wrote them. `event.meta_json.say` beside `event.body`, one table over: the
    // text stays because prompts splice it and it is what leaves this machine,
    // and the panel prefers the descriptor so a browser renders its own language.
    // Null for a row an agent wrote and for every row stored before this column.
    question_said: jsonb().$type<Json>(),
    brief_said: jsonb().$type<Json>(),
    // What kind of thing is being asked. One bad premise strands every slice
    // behind it, so a requirement can hold a dozen open questions that are the
    // same problem said twelve times — twelve decisions on a page where there is
    // one.
    kind: text(),
  },
  (t) => [index("escalation_open").on(t.chain_state, t.created_at), stateCheck(t.chain_state, ESCALATION_STATES)],
);

/** Spans land here, so the panel has a trace to read without a collector. */
export const span = pgTable(
  "span",
  {
    trace_id: text().notNull(),
    span_id: text().notNull(),
    parent_span_id: text(),
    name: text().notNull(),
    kind: text().notNull(),
    started_at: bigint({ mode: "number" }).notNull(),
    duration_ms: doublePrecision().notNull(),
    status: text().notNull(),
    attributes_json: jsonb().$type<Json>().notNull().default({}),
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

export const idempotency_request = pgTable(
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
    created_at: bigint({ mode: "number" }).notNull(),
    updated_at: bigint({ mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.caller, t.route, t.key] }), index("idempotency_request_age").on(t.updated_at)],
);

/** Server-scope settings: this machine's, not a project's and not the yaml's. */
export const setting = pgTable("setting", {
  k: text().primaryKey(),
  // JSON, including for a plain string. One value, one encoding.
  v: text().notNull(),
});

export const runtime_auth = pgTable("runtime_auth", {
  runtime: text().primaryKey(),
  mode: text().notNull(),
  // Never enters the sandbox: it goes to the egress sidecar's vault and is
  // injected on the way out (docs/adr/005), never into an event, a prompt or a
  // log, and the API returns it masked.
  secret: text().notNull(),
  // An OpenAI-compatible endpoint is configuration, not a fork.
  base_url: text(),
  updated_at: bigint({ mode: "number" }).notNull(),
});

/**
 * How much of each subscription window is gone. One row per provider, overwritten.
 *
 * A table rather than a variable, so the header is not blank after a restart
 * waiting for the next turn to refill it.
 */
export const usage_snapshot = pgTable("usage_snapshot", {
  runtime: text().primaryKey(),
  json: jsonb().$type<Json>().notNull(),
  at: bigint({ mode: "number" }).notNull(),
  // When the provider's window comes back — it belongs to the account, not the
  // group that hit it. The scheduler will not dispatch for a held provider, and
  // the hold expires by clock, so nothing polls and nobody has to be awake to
  // lift it.
  hold_until: bigint({ mode: "number" }),
});
