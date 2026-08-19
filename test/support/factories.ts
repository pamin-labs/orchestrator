import { Factory, type DeepPartial } from "fishery";
import type { DB } from "../../src/platform/persistence/database.ts";

/**
 * Row builders for the schema in `platform/persistence/database.ts`.
 *
 * The suite used to spell out 380 `INSERT INTO` column lists by hand — `project`
 * alone in four shapes — so a new NOT NULL column meant editing 68 call sites and
 * a new test copied whichever shape it landed next to. A default here must be a
 * value the schema accepts; a value a test is deliberately exercising still belongs
 * at that test's call site.
 */
/**
 * `insert` rather than Fishery's `create`: `create` is async by contract and
 * `bun:sqlite` is not. Sequences, traits (`.params()`) and deep overrides are
 * Fishery's; the foreign keys a row cannot exist without are filled by `parents`
 * below, because those need the database and Fishery's associations are resolved
 * at build time.
 */

/** What SQLite accepts as a bound parameter in this schema. */
type Cell = string | number | null;

/** How to produce a row this one references and cannot be inserted without. */
type Parents = Record<string, (db: DB) => Cell>;

class TableFactory<T extends Record<string, Cell | undefined>, S = T & { id: number }> extends Factory<T> {
  /** Assigned by `table`. `Factory.clone` copies it, so traits keep it. */
  table = "";
  parents: Parents = {};

  /** Build a row, fill the keys it cannot exist without, and store it. */
  insert(db: DB, params?: DeepPartial<T>): S {
    const row: Record<string, Cell | undefined> = { ...this.build(params) };
    for (const [column, make] of Object.entries(this.parents)) row[column] ??= make(db);
    const columns: string[] = [];
    const values: Cell[] = [];
    for (const [column, value] of Object.entries(row)) {
      if (value === undefined) continue;
      columns.push(column);
      values.push(value);
    }
    const sql = `INSERT INTO ${this.table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) RETURNING *`;
    const stored = db.query<S, Cell[]>(sql).get(...values);
    if (!stored) throw new Error(`insert into ${this.table} returned no row`);
    return stored;
  }
}

function table<T extends Record<string, Cell | undefined>, S = T & { id: number }>(
  name: string,
  generator: (opts: { sequence: number }) => T,
  parents: Parents = {},
): TableFactory<T, S> {
  // `new` rather than Fishery's `define`. `define` is the documented entry point
  // for a Factory subclass, but its five type parameters assume the subclass
  // widens `Factory<T, I, C, P>`; this one narrows `C` to the stored row while
  // extending `Factory<T>`, and the call does not type-check. The constructor is
  // public and the generic is written out here, so nothing is lost but the sugar.
  const factory = new TableFactory<T, S>(generator);
  factory.table = name;
  factory.parents = parents;
  return factory;
}

type ProjectRow = {
  id?: number;
  name: string;
  repo_path: string;
  remote?: string | null;
  config_json?: string;
  base_branch?: string | null;
  sandbox_id?: string | null;
  sandbox_at?: number | null;
  created_at: number;
};

type GrpRow = {
  id?: number;
  project_id?: number | null;
  name: string;
  branch?: string | null;
  status?: string;
  owns_json?: string;
  budget_tokens?: number | null;
  spent_tokens?: number;
  created_at: number;
  paused_at?: number | null;
  pause_reason?: string | null;
  merge_seq?: number | null;
  merge_seq_at?: number | null;
  pr_number?: number | null;
  pr_seen_at?: number;
  pr_checks_sig?: string | null;
  pr_retries?: number;
  pr_title?: string | null;
  pr_summary?: string | null;
  rl_resets_at?: number | null;
  approved_at?: number | null;
  blocked_on?: number | null;
  shared_grant?: string | null;
  rebase_seen?: string | null;
  rebase_seen_at?: number | null;
  sandbox_id?: string | null;
  sandbox_at?: number | null;
};

type AgentRow = {
  id?: number;
  project_id?: number | null;
  grp_id?: number | null;
  role: string;
  model: string;
  session_id?: string | null;
  session_tokens?: number;
  total_tokens?: number;
  cwd?: string | null;
  activity?: string | null;
  state?: string;
  created_at: number;
  token?: string | null;
  stable_hash?: string | null;
  idle_turns?: number;
  loop_file?: string | null;
  loop_count?: number;
  context_window?: number | null;
  runtime?: string;
};

type SliceRow = {
  id?: number;
  grp_id?: number | null;
  seq: number;
  title: string;
  accept_spec: string;
  difficulty?: string;
  status?: string;
  gates_json?: string;
  budget_tokens?: number | null;
  spent_tokens?: number;
  depends_on?: number | null;
  created_at: number;
  base_sha?: string | null;
  retries?: number;
  awaiting_at?: number | null;
};

type TaskRow = {
  id?: number;
  grp_id?: number | null;
  slice_id?: number | null;
  title: string;
  status?: string;
  owner_agent_id?: number | null;
  depends_on_json?: string;
  claim_json?: string | null;
  created_at: number;
};

type JobRow = {
  id?: number;
  kind: string;
  grp_id?: number | null;
  agent_id?: number | null;
  slice_id?: number | null;
  payload_json?: string;
  priority?: number;
  state?: string;
  pid?: number | null;
  error?: string | null;
  enqueued_at: number;
  started_at?: number | null;
  ended_at?: number | null;
  checkpoint_sha?: string | null;
  correlation_id?: string | null;
  trace_id?: string | null;
  parent_span_id?: string | null;
};

type EventRow = {
  seq?: number;
  channel_id?: number | null;
  grp_id?: number | null;
  author: string;
  kind: string;
  intent?: string | null;
  severity?: string | null;
  body?: string;
  target?: string | null;
  meta_json?: string;
  at: number;
  correlation_id?: string | null;
  trace_id?: string | null;
  span_id?: string | null;
};

type NoteRow = {
  id?: number;
  project_id?: number | null;
  grp_id?: number | null;
  slice_id?: number | null;
  task_id?: number | null;
  kind: string;
  lang?: string;
  body: string;
  frontmatter_json?: string;
  export_path?: string | null;
  at: number;
};

type ResourceRow = {
  name: string;
  concurrency?: number;
  template: string;
  arg_schema_json?: string;
  error_regex?: string | null;
  cwd?: string | null;
  tags_json?: string;
};

type LeaseRow = {
  id?: number;
  resource?: string;
  grp_id?: number | null;
  agent_id?: number | null;
  args_json?: string;
  resolved_cmd?: string | null;
  state?: string;
  exit_code?: number | null;
  log_path?: string | null;
  result_digest?: string | null;
  enqueued_at: number;
  started_at?: number | null;
  ended_at?: number | null;
  head_sha?: string | null;
};

type EscalationRow = {
  id?: number;
  grp_id?: number | null;
  agent_id?: number | null;
  severity?: string;
  question: string;
  chain_state?: string;
  answered_by?: string | null;
  answer?: string | null;
  ref_note_id?: number | null;
  checkpoint_sha?: string | null;
  created_at: number;
  answered_at?: number | null;
  brief?: string | null;
  kind?: string | null;
};

type MemberRow = {
  channel_id?: number;
  agent_id?: number;
  mode?: string;
};

type CursorRow = {
  agent_id?: number;
  channel_id?: number;
  last_seq?: number;
};

type ChannelRow = {
  id?: number;
  project_id?: number | null;
  grp_id?: number | null;
  kind: string;
  status?: string;
  created_at: number;
};

type SettingRow = { k: string; v: string };

type IdempotencyRequestRow = {
  caller: string;
  route: string;
  key: string;
  payload_hash: string;
  state: string;
  status?: number | null;
  body?: string | null;
  content_type?: string | null;
  created_at: number;
  updated_at: number;
};

type UsageSnapshotRow = { runtime: string; json: string; at: number; hold_until?: number | null };

type RuntimeAuthRow = {
  runtime: string;
  mode: string;
  secret: string;
  base_url?: string | null;
  updated_at: number;
};

export const project = table<ProjectRow>("project", ({ sequence }) => ({
  name: `p${sequence}`,
  repo_path: "/tmp/p",
  created_at: 0,
}));

export const grp = table<GrpRow>("grp", ({ sequence }) => ({ name: `g${sequence}`, status: "DRAFT", created_at: 0 }), {
  project_id: (db) => project.insert(db).id,
});

export const agent = table<AgentRow>("agent", () => ({
  role: "engineer",
  model: "m",
  created_at: 0,
}));

export const slice = table<SliceRow>(
  "slice",
  ({ sequence }) => ({ seq: sequence, title: `S${sequence}`, accept_spec: "x", created_at: 0 }),
  { grp_id: (db) => grp.insert(db).id },
);

export const task = table<TaskRow>("task", ({ sequence }) => ({ title: `t${sequence}`, created_at: 0 }), {
  grp_id: (db) => grp.insert(db).id,
});

export const job = table<JobRow>("job", () => ({ kind: "agent_turn", enqueued_at: 0 }));

export const event = table<EventRow, EventRow & { seq: number }>("event", () => ({
  author: "x",
  kind: "say",
  at: 0,
}));

export const note = table<NoteRow>("note", () => ({
  kind: "fact",
  lang: "zh",
  body: "n",
  at: 0,
}));

export const resource = table<ResourceRow, ResourceRow>("resource", ({ sequence }) => ({
  name: `res${sequence}`,
  template: "true",
}));

export const lease = table<LeaseRow>("lease", () => ({ enqueued_at: 0 }), {
  resource: (db) => resource.insert(db).name,
});

export const member = table<MemberRow, MemberRow>("member", () => ({}), {
  channel_id: (db) => channel.insert(db).id,
  agent_id: (db) => agent.insert(db).id,
});

export const cursor = table<CursorRow, CursorRow>("cursor", () => ({}), {
  agent_id: (db) => agent.insert(db).id,
  channel_id: (db) => channel.insert(db).id,
});

export const escalation = table<EscalationRow>("escalation", () => ({
  severity: "advisory",
  question: "q",
  chain_state: "pm",
  created_at: 0,
}));

export const channel = table<ChannelRow>("channel", () => ({
  kind: "group",
  created_at: 0,
}));

export const setting = table<SettingRow, SettingRow>("setting", ({ sequence }) => ({
  k: `k${sequence}`,
  v: "{}",
}));

export const idempotencyRequest = table<IdempotencyRequestRow, IdempotencyRequestRow>(
  "idempotency_request",
  ({ sequence }) => ({
    caller: "boss",
    route: "/write",
    key: `key-${sequence}`,
    payload_hash: "hash",
    state: "in_progress",
    created_at: 0,
    updated_at: 0,
  }),
);

export const usageSnapshot = table<UsageSnapshotRow, UsageSnapshotRow>("usage_snapshot", () => ({
  runtime: "claude",
  json: "{}",
  at: 0,
}));

export const runtimeAuth = table<RuntimeAuthRow, RuntimeAuthRow>("runtime_auth", () => ({
  runtime: "claude",
  mode: "token",
  secret: "s",
  updated_at: 0,
}));

/** The states tests re-create by hand often enough to name. */
export const runningGrp = grp.params({ status: "RUNNING" });
export const acceptedSlice = slice.params({ status: "accepted" });
