import { Database } from "bun:sqlite";

/**
 * Single source of truth for the schema. See PLAN.md §3.
 *
 * Four first-class entities: `job` (what will happen), `event` (what happened),
 * `note` (the static blackboard), `task`/`slice` (units of work).
 * Everything else is support.
 */
const MIGRATIONS: string[] = [
  // 001 — initial schema
  `
  CREATE TABLE project (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    repo_path   TEXT    NOT NULL,
    remote      TEXT,
    config_json TEXT    NOT NULL DEFAULT '{}',
    created_at  INTEGER NOT NULL
  );

  -- A "group" is not a heavy entity: branch + worktree + roster + budget + owned paths.
  CREATE TABLE grp (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id    INTEGER NOT NULL REFERENCES project(id),
    name          TEXT    NOT NULL,
    branch        TEXT,
    worktree      TEXT,
    status        TEXT    NOT NULL DEFAULT 'DRAFT',
    owns_json     TEXT    NOT NULL DEFAULT '[]',
    budget_tokens INTEGER,
    spent_tokens  INTEGER NOT NULL DEFAULT 0,
    spent_usd     REAL    NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    UNIQUE (project_id, name)
  );
  -- status: DRAFT | RUNNING | PAUSING | PAUSED | PARKED | PR_OPEN | DISSOLVED

  -- Agent identity is durable (role/group/clearance/cost); the session is disposable.
  CREATE TABLE agent (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id     INTEGER REFERENCES project(id),
    grp_id         INTEGER REFERENCES grp(id),
    role           TEXT    NOT NULL,
    model          TEXT    NOT NULL,
    clearance      TEXT    NOT NULL DEFAULT 'L1',
    session_id     TEXT,
    session_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens   INTEGER NOT NULL DEFAULT 0,
    total_usd      REAL    NOT NULL DEFAULT 0,
    cwd            TEXT,
    activity       TEXT,
    state          TEXT    NOT NULL DEFAULT 'idle',
    created_at     INTEGER NOT NULL
  );
  -- state: idle | running | waiting_lease | blocked | retired

  -- The only thing that can start an agent. Intercept / park / budget-halt are
  -- all just operations on this queue.
  CREATE TABLE job (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    kind         TEXT    NOT NULL,
    grp_id       INTEGER REFERENCES grp(id),
    agent_id     INTEGER REFERENCES agent(id),
    slice_id     INTEGER REFERENCES slice(id),
    payload_json TEXT    NOT NULL DEFAULT '{}',
    priority     INTEGER NOT NULL DEFAULT 0,
    state        TEXT    NOT NULL DEFAULT 'pending',
    pid          INTEGER,
    error        TEXT,
    enqueued_at  INTEGER NOT NULL,
    started_at   INTEGER,
    ended_at     INTEGER
  );
  -- kind:  agent_turn | lease | watchdog | digest | notify | gate | reconcile
  -- state: pending | running | done | failed | cancelled
  CREATE INDEX job_dispatch ON job (state, priority DESC, id);
  CREATE INDEX job_grp ON job (grp_id, state);

  -- Append-only. The timeline / desk wall / channel views all read this.
  CREATE TABLE event (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER REFERENCES channel(id),
    grp_id     INTEGER REFERENCES grp(id),
    author     TEXT    NOT NULL,
    kind       TEXT    NOT NULL,
    intent     TEXT,
    severity   TEXT,
    body       TEXT    NOT NULL DEFAULT '',
    target     TEXT,
    meta_json  TEXT    NOT NULL DEFAULT '{}',
    at         INTEGER NOT NULL
  );
  -- kind:   say | boss_say | tool_summary | lease_result | commit | escalation
  --         | state_change | digest | gate_result
  -- intent: ask | request | inform | note | decision   (5 only; rest are fields)
  CREATE INDEX event_channel ON event (channel_id, seq);
  CREATE INDEX event_grp ON event (grp_id, seq);

  -- The static half of the blackboard. journal/retro also export to git.
  CREATE TABLE note (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id        INTEGER REFERENCES project(id),
    grp_id            INTEGER REFERENCES grp(id),
    slice_id          INTEGER REFERENCES slice(id),
    task_id           INTEGER REFERENCES task(id),
    kind              TEXT    NOT NULL,
    lang              TEXT    NOT NULL DEFAULT 'zh',
    body              TEXT    NOT NULL,
    frontmatter_json  TEXT    NOT NULL DEFAULT '{}',
    export_path       TEXT,
    at                INTEGER NOT NULL
  );
  -- kind: fact | decision | journal | retro | handoff | risk | onboarding | lesson
  CREATE INDEX note_lookup ON note (project_id, kind, at DESC);

  -- Independently acceptable delivery unit. Budget and session rotation hang here.
  CREATE TABLE slice (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    grp_id        INTEGER NOT NULL REFERENCES grp(id),
    seq           INTEGER NOT NULL,
    title         TEXT    NOT NULL,
    accept_spec   TEXT    NOT NULL,
    difficulty    TEXT    NOT NULL DEFAULT 'normal',
    status        TEXT    NOT NULL DEFAULT 'pending',
    gates_json    TEXT    NOT NULL DEFAULT '{}',
    budget_tokens INTEGER,
    spent_tokens  INTEGER NOT NULL DEFAULT 0,
    spent_usd     REAL    NOT NULL DEFAULT 0,
    depends_on    INTEGER REFERENCES slice(id),
    created_at    INTEGER NOT NULL,
    UNIQUE (grp_id, seq)
  );
  -- difficulty: trivial | normal | hard  -> picks the model
  -- status:     pending | running | self_review | gate | qa | awaiting_boss | accepted | rejected
  -- gates_json: {"self":"pass","gate":"fail","qa":null}

  CREATE TABLE task (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    grp_id         INTEGER NOT NULL REFERENCES grp(id),
    slice_id       INTEGER REFERENCES slice(id),
    title          TEXT    NOT NULL,
    status         TEXT    NOT NULL DEFAULT 'pending',
    owner_agent_id INTEGER REFERENCES agent(id),
    depends_on_json TEXT   NOT NULL DEFAULT '[]',
    claim_json     TEXT,
    created_at     INTEGER NOT NULL
  );
  -- claim_json: what the agent claims it produced; reconcile diffs it against git
  CREATE INDEX task_grp ON task (grp_id, status);

  CREATE TABLE channel (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES project(id),
    grp_id     INTEGER REFERENCES grp(id),
    kind       TEXT    NOT NULL,
    status     TEXT    NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL
  );
  -- kind: group | project | boss ; status: open | archived

  CREATE TABLE member (
    channel_id INTEGER NOT NULL REFERENCES channel(id),
    agent_id   INTEGER NOT NULL REFERENCES agent(id),
    mode       TEXT    NOT NULL DEFAULT 'full',
    PRIMARY KEY (channel_id, agent_id)
  );
  -- mode: full | rep  (rep = pulled in as another group's representative)

  -- Bounded delta injection: a turn gets unread since last_seq, then advances it.
  CREATE TABLE cursor (
    agent_id   INTEGER NOT NULL REFERENCES agent(id),
    channel_id INTEGER NOT NULL REFERENCES channel(id),
    last_seq   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (agent_id, channel_id)
  );

  -- Predefined command templates. Agents pick a name + validated args, never
  -- a free-form command: Runner runs on the host with real privileges.
  CREATE TABLE resource (
    name            TEXT    PRIMARY KEY,
    concurrency     INTEGER NOT NULL DEFAULT 1,
    template        TEXT    NOT NULL,
    arg_schema_json TEXT    NOT NULL DEFAULT '{}',
    error_regex     TEXT,
    cwd             TEXT
  );

  CREATE TABLE lease (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    resource      TEXT    NOT NULL REFERENCES resource(name),
    grp_id        INTEGER REFERENCES grp(id),
    agent_id      INTEGER REFERENCES agent(id),
    args_json     TEXT    NOT NULL DEFAULT '{}',
    resolved_cmd  TEXT,
    state         TEXT    NOT NULL DEFAULT 'queued',
    exit_code     INTEGER,
    log_path      TEXT,
    result_digest TEXT,
    enqueued_at   INTEGER NOT NULL,
    started_at    INTEGER,
    ended_at      INTEGER
  );
  -- state: queued | running | done | failed | cancelled
  CREATE INDEX lease_queue ON lease (resource, state, id);

  CREATE TABLE escalation (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    grp_id         INTEGER REFERENCES grp(id),
    agent_id       INTEGER REFERENCES agent(id),
    severity       TEXT    NOT NULL DEFAULT 'advisory',
    question       TEXT    NOT NULL,
    chain_state    TEXT    NOT NULL DEFAULT 'pm',
    answered_by    TEXT,
    answer         TEXT,
    ref_note_id    INTEGER REFERENCES note(id),
    checkpoint_sha TEXT,
    created_at     INTEGER NOT NULL,
    answered_at    INTEGER
  );
  -- severity: advisory | blocker
  -- chain_state: pm | architect | cos | boss | answered | revoked
  CREATE INDEX escalation_open ON escalation (chain_state, created_at);
  `,

  // 002 — per-agent bearer token.
  //
  // `orch` reaches the server over localhost TCP (see
  // docs/decisions/001-agent-transport-and-sandbox.md), and anything else on
  // 127.0.0.1 can reach it too. Identity therefore comes from a token the
  // spawner injects into the turn's environment, never from a field in the
  // request body that an agent could simply change.
  `
  ALTER TABLE agent ADD COLUMN token TEXT;
  CREATE UNIQUE INDEX agent_token ON agent (token) WHERE token IS NOT NULL;
  `,

  // 003 — hash of the session's stable prompt half.
  //
  // If the role prompt, model, tool whitelist or lessons list changes, the
  // cached prefix is dead. Recording the hash lets the executor rotate the
  // session instead of silently paying full price on every remaining turn.
  `ALTER TABLE agent ADD COLUMN stable_hash TEXT;`,

  // 004 — per-slice reconcile baseline and retry counter.
  //
  // Reconcile has to compare against what changed *in this slice*, not what
  // changed on the branch, or every slice after the first inherits the previous
  // ones' diff and the check stops meaning anything.
  `
  ALTER TABLE slice ADD COLUMN base_sha TEXT;
  ALTER TABLE slice ADD COLUMN retries INTEGER NOT NULL DEFAULT 0;
  `,

  // 005 — what the watchdog needs to notice a stuck agent.
  //
  // Each of these exists because a rule needs *deterministic* evidence. A model
  // asked "are you going in circles?" says no.
  `
  ALTER TABLE agent ADD COLUMN idle_turns INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE agent ADD COLUMN loop_file TEXT;
  ALTER TABLE agent ADD COLUMN loop_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE lease ADD COLUMN head_sha TEXT;
  ALTER TABLE grp ADD COLUMN paused_at INTEGER;
  ALTER TABLE job ADD COLUMN checkpoint_sha TEXT;
  `,

  // 006 — merge order.
  //
  // Assigned when a branch passes its audit. The queue is strictly serial: the
  // alternative is finding out on main which of two groups broke it.
  `ALTER TABLE grp ADD COLUMN merge_seq INTEGER;`,

  // 007 — the PR this branch opened, and how far we have read its comments.
  `
  ALTER TABLE grp ADD COLUMN pr_number INTEGER;
  ALTER TABLE grp ADD COLUMN pr_seen_at INTEGER NOT NULL DEFAULT 0;
  `,

  // 008 — which failing checks we already reported.
  //
  // A check that stays red is one piece of news, not one every poll: without
  // this the PM gets woken every 30 seconds for the same failure.
  `ALTER TABLE grp ADD COLUMN pr_checks_sig TEXT;`,
];

export type DB = Database;

/** Open (or create) the database and bring it up to the latest migration. */
export function open(path = "data/orchestrator.sqlite"): DB {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

/** Apply any migrations the database has not seen yet. Idempotent. */
export function migrate(db: DB): void {
  db.exec("CREATE TABLE IF NOT EXISTS migration (n INTEGER PRIMARY KEY, at INTEGER NOT NULL)");
  const applied = db.query<{ n: number }, []>("SELECT n FROM migration").all().map((r) => r.n);
  const stamp = db.prepare("INSERT INTO migration (n, at) VALUES (?, ?)");
  for (const [i, sql] of MIGRATIONS.entries()) {
    const n = i + 1;
    if (applied.includes(n)) continue;
    db.transaction(() => {
      db.exec(sql);
      stamp.run(n, Date.now());
    })();
  }
}

/** In-memory database for tests. */
export function openMemory(): DB {
  return open(":memory:");
}
