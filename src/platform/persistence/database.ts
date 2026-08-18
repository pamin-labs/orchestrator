import { Database } from "bun:sqlite";
import { maskValue } from "../observability/redaction.ts";
import { parseRepo } from "../../contracts/repository.ts";

/**
 * Single source of truth for the schema. See docs/project/plan.md §3.
 *
 * Four first-class entities: `job` (what will happen), `event` (what happened),
 * `note` (the static blackboard), `task`/`slice` (units of work).
 * Everything else is support.
 */
/**
 * A migration is SQL, or a function when the change is not expressible in it.
 *
 * The function form exists for one case so far: rewriting the skill paths stored
 * in old message bodies, where the old and new forms differ by the skill's name
 * and SQLite has no regex.
 */
const MIGRATIONS: Array<string | ((db: DB) => void)> = [
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

  -- A "group" is not a heavy entity: branch + sandbox + roster + budget + owned paths.
  CREATE TABLE grp (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id    INTEGER NOT NULL REFERENCES project(id),
    name          TEXT    NOT NULL,
    branch        TEXT,
    -- worktree is dropped by migration 031; like clearance below, it stays here
    -- because the base schema records what the first migration ran, not today.
    worktree      TEXT,
    status        TEXT    NOT NULL DEFAULT 'DRAFT',
    owns_json     TEXT    NOT NULL DEFAULT '[]',
    budget_tokens INTEGER,
    spent_tokens  INTEGER NOT NULL DEFAULT 0,
    spent_usd     REAL    NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    UNIQUE (project_id, name)
  );
  -- status: PLANNING | DRAFT | RUNNING | PAUSING | PAUSED | PARKED | PR_OPEN | DISSOLVED
  --   PLANNING: the Dispatcher/Architect are still working; DRAFT: the card awaits the boss

  -- Agent identity is durable (role/group/cost); the session is disposable.
  -- clearance is dropped by migration 029; it is left here because the base
  -- schema is what the first migration ran against, not a description of today.
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
  -- status:     pending | running | gate | qa | awaiting_boss | accepted | rejected
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
  // Anything else on 127.0.0.1 can reach the server too, so identity comes from a
  // token the spawner injects into the turn's environment, never from a field in
  // the request body that an agent could simply change.
  `
  ALTER TABLE agent ADD COLUMN token TEXT;
  CREATE UNIQUE INDEX agent_token ON agent (token) WHERE token IS NOT NULL;
  `,

  // 003 — hash of the session's stable prompt half.
  //
  // If the role prompt, model, tool whitelist or lessons list changes, the cached
  // prefix is dead, and the executor rotates the session rather than silently
  // paying full price on every remaining turn.
  `ALTER TABLE agent ADD COLUMN stable_hash TEXT;`,

  // 004 — per-slice reconcile baseline and retry counter.
  //
  // Reconcile compares against what changed *in this slice*, not on the branch:
  // otherwise every slice after the first inherits the previous ones' diff.
  `
  ALTER TABLE slice ADD COLUMN base_sha TEXT;
  ALTER TABLE slice ADD COLUMN retries INTEGER NOT NULL DEFAULT 0;
  `,

  // 005 — what the watchdog needs to notice a stuck agent. Each column exists
  // because a rule needs *deterministic* evidence: a model asked "are you going in
  // circles?" says no.
  `
  ALTER TABLE agent ADD COLUMN idle_turns INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE agent ADD COLUMN loop_file TEXT;
  ALTER TABLE agent ADD COLUMN loop_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE lease ADD COLUMN head_sha TEXT;
  ALTER TABLE grp ADD COLUMN paused_at INTEGER;
  ALTER TABLE job ADD COLUMN checkpoint_sha TEXT;
  `,

  // 006 — merge order. Assigned when a branch passes its audit, and strictly
  // serial: the alternative is finding out on main which of two groups broke it.
  `ALTER TABLE grp ADD COLUMN merge_seq INTEGER;`,

  // 007 — the PR this branch opened, and how far we have read its comments.
  `
  ALTER TABLE grp ADD COLUMN pr_number INTEGER;
  ALTER TABLE grp ADD COLUMN pr_seen_at INTEGER NOT NULL DEFAULT 0;
  `,

  // 008 — which failing checks we already reported. A check that stays red is one
  // piece of news, not one every poll.
  `ALTER TABLE grp ADD COLUMN pr_checks_sig TEXT;`,

  // 009 — when a slice started waiting on the boss. "白干的单位是一个切片"
  // (docs/project/plan.md §7) only means something if the clock on it is visible.
  `ALTER TABLE slice ADD COLUMN awaiting_at INTEGER;`,

  // 010 — when the account's quota comes back. docs/project/plan.md §11: a rate
  // limit degrades to a cheaper model and otherwise waits for the reset.
  `ALTER TABLE grp ADD COLUMN rl_resets_at INTEGER;`,

  // 011 — the boss approved, but a boundary was in the way. One click has to be
  // final.
  `ALTER TABLE grp ADD COLUMN approved_at INTEGER;`,

  // 012 — the group this one is waiting on. Recording which group owns the problem
  // is what lets the waiter start again by itself when that group lands.
  `ALTER TABLE grp ADD COLUMN blocked_on INTEGER REFERENCES grp(id);`,

  // 013 — when this branch joined the merge queue. The queue is strictly serial,
  // so a head nobody merges blocks everything behind it, and without a clock "the
  // boss forgot" and "it only just got there" look identical.
  `ALTER TABLE grp ADD COLUMN merge_seq_at INTEGER;`,

  // 014 — branch-level rework counter. docs/project/plan.md §"Gate 与审批顺序"
  // says two rounds then escalate; this is the column that makes that true.
  `ALTER TABLE grp ADD COLUMN pr_retries INTEGER NOT NULL DEFAULT 0;`,

  // 015 — shared paths this one group was granted, by name.
  //
  // Shared files belong to no group, which is right, but a defect *in* one still
  // has to be fixable. The grant is issued by the server when a group reports being
  // blocked by the file, names exactly that path, and lets this one requirement
  // through while every other group is still refused.
  `ALTER TABLE grp ADD COLUMN shared_grant TEXT;`,

  // 016 — the main commit this group has already been told to rebase onto. Without
  // it the same nudge fires every watchdog tick until the rebase finishes, which is
  // how a useful message becomes one the agent learns to skip.
  `ALTER TABLE grp ADD COLUMN rebase_seen TEXT;`,

  // 017 — what a resource contends for, so the Runner pool can be split by it.
  //
  // One global `leaseSlots` has to be the minimum any resource can tolerate: sized
  // for the browser (1, each lease is a real Chromium) every gate in the fleet
  // queues behind one screenshot; sized for `typecheck` the browsers thrash. Tags
  // name the contended thing, and each tag gets its own pool size.
  `ALTER TABLE resource ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';`,

  // 018 — consecutive turns that ended in a clearance denial. The first denial is
  // not a question — the agent takes a legal route on its next turn by itself — and
  // only a repeat means it is actually stuck.
  `ALTER TABLE agent ADD COLUMN denial_turns INTEGER NOT NULL DEFAULT 0;`,

  // 019 — when this group was last told main had moved. `rebase_seen` records
  // which commit, so a clock is what lets a burst of pushes coalesce.
  `ALTER TABLE grp ADD COLUMN rebase_seen_at INTEGER;`,

  // 020 — how much of each subscription window is gone. One row per provider,
  // overwritten; a table rather than a variable so the header is not blank after a
  // restart and does not wait for the next turn to arrive.
  `
  CREATE TABLE usage_snapshot (
    runtime TEXT PRIMARY KEY,
    json    TEXT    NOT NULL,
    at      INTEGER NOT NULL
  );
  `,

  // 021 — the context window this agent's model actually reported. Both CLIs state
  // the real number during a turn, so record it: a table in config goes stale the
  // week a model ships.
  `ALTER TABLE agent ADD COLUMN context_window INTEGER;`,

  // 022 — which provider an agent runs on, and when that provider is out of quota.
  //
  // The window belongs to the account, not to the group that happened to hit it.
  // `hold_until` is the whole mechanism: the scheduler will not dispatch a turn for
  // a held provider, and it expires by clock, so nothing polls and nobody has to be
  // awake to lift it.
  `
  ALTER TABLE agent ADD COLUMN runtime TEXT NOT NULL DEFAULT 'claude';
  ALTER TABLE usage_snapshot ADD COLUMN hold_until INTEGER;
  `,

  // 023 — the dollar columns go.
  //
  // They stay in the CREATE above because that block is history: a fresh database
  // walks the same path an old one did, and a migration that drops a column the
  // schema never created fails on every new install. Nothing displays them and
  // nothing can — two subscriptions pay for this, so the figure was never a bill.
  `
  ALTER TABLE grp DROP COLUMN spent_usd;
  ALTER TABLE slice DROP COLUMN spent_usd;
  ALTER TABLE agent DROP COLUMN total_usd;
  `,

  // 024 — one line of what a question is about, for the queue. 待办 showed the
  // question itself, which is an agent writing to another agent, in front of a
  // reader whose whole job here is to pick which one to open.
  `ALTER TABLE escalation ADD COLUMN brief TEXT;`,

  // 025 — what kind of thing is being asked. One bad premise strands every slice
  // behind it, so a requirement can hold a dozen open questions that are the same
  // problem said twelve times — twelve decisions on a page where there is one.
  `ALTER TABLE escalation ADD COLUMN kind TEXT;`,

  // 026 — the group's sandbox.
  //
  // Durable because the Sandbox object is not: a restarted orchestrator reconnects
  // to the container that is still running, or the turn's session — and with it the
  // cached prefix the whole cost model rests on — dies with the process that
  // created it. Two columns, not a join table: a sandbox has two possible owners,
  // a group or a project's standing roles.
  `
  ALTER TABLE grp ADD COLUMN sandbox_id TEXT;
  ALTER TABLE project ADD COLUMN sandbox_id TEXT;
  `,

  // 027 — where each runtime's credentials come from.
  //
  // The value never enters the sandbox: it is written to the egress sidecar's vault
  // and injected on the way out (docs/adr/005). It never enters an event, a prompt
  // or a log either, and the API only ever returns it masked. `base_url` is what
  // makes an OpenAI-compatible endpoint a configuration rather than a fork.
  `
  CREATE TABLE runtime_auth (
    runtime    TEXT PRIMARY KEY,
    mode       TEXT NOT NULL,
    secret     TEXT NOT NULL,
    base_url   TEXT,
    updated_at INTEGER NOT NULL
  );
  `,

  // 028 — when a sandbox was built, so it can be told from the credential in it.
  //
  // A sidecar is loaded with the credentials that existed when its sandbox was
  // created and never again, so storing one has to kill the running sandboxes. The
  // fix that lasts is not a third call to the same helper but a fact on the row: a
  // sandbox older than the newest credential is stale, whoever stored it, and the
  // watchdog reaps it on the next tick.
  `
  ALTER TABLE grp ADD COLUMN sandbox_at INTEGER;
  ALTER TABLE project ADD COLUMN sandbox_at INTEGER;
  `,

  // 029 — the last two columns of the clearance era. Neither was ever written, and
  // a column nobody writes is a claim nobody checks.
  `
  ALTER TABLE agent DROP COLUMN clearance;
  ALTER TABLE agent DROP COLUMN denial_turns;
  `,

  // 030 — server-scope settings that are not a project's and not the yaml's. The
  // skill tick boxes are the first: they belong to this machine rather than to a
  // project, and the boss edits them in the panel.
  `
  CREATE TABLE setting (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  );
  `,

  // 031 — the checkout moved into the container and this column stayed behind.
  // Nothing ever wrote it, and four code paths read it gated on it being non-null.
  `
  ALTER TABLE grp DROP COLUMN worktree;
  `,

  // 032 — which branch this project is cut from and measured against. NULL means
  // "ask the remote", resolved once and written back here, so the diff baseline is
  // the same value on the day a slice was cut and on the day the boss reads it.
  `
  ALTER TABLE project ADD COLUMN base_branch TEXT;
  `,

  // 033 — skill paths in old messages point at a machine the agent cannot see.
  //
  // The composer used to insert a path relative to the boss's home, which is a file
  // the agent is told to read and cannot now that turns run in a container. These
  // bodies are re-injected into later turns, which is why this is worth rewriting
  // rather than leaving as history: `/name` is what both CLIs resolve, wherever the
  // skill actually sits.
  rewriteSkillPaths,

  // 034 — a project is `owner/name`, not a directory on whoever's laptop.
  //
  // Every project now comes from GitHub (007 §2). The conversion needs neither git
  // nor the network: the remote was recorded at registration and `parseRepo` reads
  // the slug out of it. A row that cannot be converted keeps exactly what it had —
  // guessing an owner from a directory name would write a repository that may
  // belong to somebody else, and dropping the row deletes a project the boss chose.
  slugRepoPaths,

  // 035 — what this branch is called in a log, written by an agent that read it.
  //
  // Two columns rather than one so the commit and the PR can differ where they
  // should: `pr_title` is the subject both use, `pr_summary` is the body of the
  // commit and the first section of the PR — the record sections below it are still
  // built from the database, which knows them better than any agent.
  `
  ALTER TABLE grp ADD COLUMN pr_title TEXT;
  `,
  `
  ALTER TABLE grp ADD COLUMN pr_summary TEXT;
  `,

  // 036 — two settings that predate the settings table, onto it.
  //
  // Keeping them special means one value with two homes and a precedence order that
  // exists only in code — the shape this project has been burned by (see
  // `grp.worktree`, a column nothing wrote and four things read). JSON-quoted on
  // the way across, because the settings table stores JSON and these two stored the
  // bare string.
  `
  INSERT OR REPLACE INTO setting (k, v)
    SELECT 'cfg.sandbox.image', json_quote(v) FROM setting WHERE k = 'sandbox_image';
  INSERT OR REPLACE INTO setting (k, v)
    SELECT 'cfg.sandbox.server', json_quote(v) FROM setting WHERE k = 'sandbox_server_addr';
  DELETE FROM setting WHERE k IN ('sandbox_image', 'sandbox_server_addr');
  `,

  // 037 — why a group is paused, so that resuming can be about that reason.
  //
  // `paused_at` said when, never why, and eight places wrote it for eight different
  // causes — so the one bulk resume in the tree matched every PAUSED row there was.
  // Backfilled as 'unknown' rather than guessed: an existing PAUSED row is one whose
  // cause was never recorded, and a wrong reason resumes the wrong group.
  `
  ALTER TABLE grp ADD COLUMN pause_reason TEXT;
  UPDATE grp SET pause_reason = 'unknown' WHERE status IN ('PAUSED', 'PAUSING', 'PARKED');
  `,

  // 038 — durable HTTP idempotency for every mutating protocol route.
  `
  CREATE TABLE idempotency_request (
    caller       TEXT NOT NULL,
    route        TEXT NOT NULL,
    key          TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    state        TEXT NOT NULL,
    status       INTEGER,
    body         TEXT,
    content_type TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (caller, route, key)
  );
  CREATE INDEX idempotency_request_age ON idempotency_request (updated_at);
  `,

  // 039 — durable request/trace correlation across queued work and events.
  `
  ALTER TABLE job ADD COLUMN correlation_id TEXT;
  ALTER TABLE job ADD COLUMN trace_id TEXT;
  ALTER TABLE job ADD COLUMN parent_span_id TEXT;
  ALTER TABLE event ADD COLUMN correlation_id TEXT;
  ALTER TABLE event ADD COLUMN trace_id TEXT;
  ALTER TABLE event ADD COLUMN span_id TEXT;
  CREATE INDEX job_correlation ON job (correlation_id);
  CREATE INDEX event_correlation ON event (correlation_id, seq);
  `,

  // 040 — spans land here, so the panel has a trace to read without a collector.
  //
  // The three scope columns are nullable because a system span belongs to no
  // project, and they are deliberately **not** foreign keys: a span is an
  // observation of something that happened, not a reference to something that still
  // exists. Retention, not referential integrity, is what bounds this table. Three
  // indexes: `trace_id` for a whole trace, `span_scope` for a group or slice, and
  // `span_age` for the retention scan, which neither of the others can serve.
  `
  CREATE TABLE span (
    trace_id        TEXT    NOT NULL,
    span_id         TEXT    NOT NULL,
    parent_span_id  TEXT,
    name            TEXT    NOT NULL,
    kind            TEXT    NOT NULL,
    started_at      INTEGER NOT NULL,
    duration_ms     REAL    NOT NULL,
    status          TEXT    NOT NULL,
    attributes_json TEXT    NOT NULL DEFAULT '{}',
    project_id      INTEGER,
    grp_id          INTEGER,
    slice_id        INTEGER,
    PRIMARY KEY (trace_id, span_id)
  );
  CREATE INDEX span_scope ON span (grp_id, slice_id, started_at);
  CREATE INDEX span_age ON span (started_at);
  `,

  // 041 — where a paused group came from, so resuming can put it back. `release`
  // restored RUNNING unconditionally, and `mergequeue.queue()` filters on
  // `status = 'PR_OPEN'`, so a rate-limited turn on an audited branch took the
  // group out of the merge order silently.
  `
  ALTER TABLE grp ADD COLUMN paused_from TEXT;
  `,
  // 042 — why a span failed. `setStatus` takes a message and every error path in
  // this repository passes one, and the table had nowhere to put it: the panel
  // could say `index.ask` failed 2,835 times and never that the reason was a
  // missing credential. Answering that took a query against the database, which
  // is the thing 系统耗时 exists to make unnecessary.
  `
  ALTER TABLE span ADD COLUMN status_message TEXT;
  `,
];

export type DB = Database;

/** Migration 033, exported so it can be run against a database that has rows. */
export function rewriteSkillPaths(db: DB): void {
  const like = "%skills/%/SKILL.md";
  for (const table of ["note", "event"] as const) {
    const key = table === "note" ? "id" : "seq";
    // fallow-ignore-next-line security-sink -- `table` is the loop variable over a two-element `as const` literal and `key` is a ternary between two source literals, so both interpolations have exactly two possible values, fixed at compile time. The pattern being matched is bound through `?`.
    const rows = db
      .query<{ id: number; body: string }, [string]>(`SELECT ${key} AS id, body FROM ${table} WHERE body LIKE ?`)
      .all(like);
    const set = db.prepare(`UPDATE ${table} SET body = ? WHERE ${key} = ?`);
    for (const r of rows) {
      const next = r.body.replace(/(?:^|(?<=\s))\.(?:claude|agents)\/skills\/([\w.:-]+)\/SKILL\.md/g, "/$1");
      if (next !== r.body) set.run(next, r.id);
    }
  }
}

/**
 * `repo_path`: absolute host path → `owner/name`.
 *
 * Idempotent, because migrations are replayed against databases at every age: a
 * value that is not an absolute path is already in its destination shape. Exported
 * because a data migration with a decision in it is worth a test.
 */
export function slugRepoPaths(db: DB): void {
  const rows = db
    .query<{ id: number; name: string; repo_path: string; remote: string | null }, []>(
      "SELECT id, name, repo_path, remote FROM project",
    )
    .all();
  const set = db.prepare("UPDATE project SET repo_path = ? WHERE id = ?");
  const stuck: string[] = [];
  for (const p of rows) {
    if (!p.repo_path.startsWith("/")) continue;
    const slug = p.remote ? parseRepo(p.remote) : null;
    if (slug) set.run(slug, p.id);
    else stuck.push(`${p.name}（${p.repo_path}${p.remote ? ` → ${p.remote}` : "，没记下 remote"}）`);
  }
  if (!stuck.length) return;
  // One question, not one per project: N decisions on a page where there is one.
  // Escalation INSERT exception: this data repair runs while db.ts is opening.
  db.run(
    `INSERT INTO escalation (grp_id, severity, question, brief, kind, chain_state, created_at)
     VALUES (NULL, 'blocker', ?, ?, 'env', 'boss', unixepoch() * 1000)`,
    [
      `这些项目还指着本机的目录，认不出对应的 GitHub 仓库，所以现在开不了组：\n` +
        stuck.map((s) => `· ${s}`).join("\n") +
        `\n\n每个都得说清是哪个仓库（owner/name）。最省事的做法：在设置里连好 GitHub 之后，` +
        `从仓库列表里重新添加一次，再把这条关掉。数据没动过。`,
      `${stuck.length} 个项目认不出 GitHub 仓库`,
    ],
  );
}

/** Open (or create) the database and bring it up to the latest migration. */
export function open(path = "data/orchestrator.sqlite"): DB {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db);
  // Whatever was stored before this process started still has to be masked out of
  // everything it prints. Registered once, here, because every path into the
  // database comes through this function.
  for (const { secret } of db.query<{ secret: string }, []>("SELECT secret FROM runtime_auth").all()) {
    maskValue(secret);
  }
  return db;
}

/**
 * Which migration this SQL belongs to, 1-based, for a test that wants to replay one
 * against rows a fresh database cannot have.
 *
 * By content, not by position: a test that rewinds `max(n)` and calls it "this one"
 * silently retargets itself at whatever migration is added next.
 */
export function migrationMentioning(needle: string): number {
  const i = MIGRATIONS.findIndex((m) => typeof m === "string" && m.includes(needle));
  if (i < 0) throw new Error(`no migration mentions ${needle}`);
  return i + 1;
}

/** Apply any migrations the database has not seen yet. Idempotent. */
export function migrate(db: DB): void {
  db.run("CREATE TABLE IF NOT EXISTS migration (n INTEGER PRIMARY KEY, at INTEGER NOT NULL)");
  const applied = new Set(
    db
      .query<{ n: number }, []>("SELECT n FROM migration")
      .all()
      .map((r) => r.n),
  );
  const stamp = db.prepare("INSERT INTO migration (n, at) VALUES (?, ?)");
  for (const [i, step] of MIGRATIONS.entries()) {
    const n = i + 1;
    if (applied.has(n)) continue;
    db.transaction(() => {
      if (typeof step === "string") db.run(step);
      else step(db);
      stamp.run(n, Date.now());
    })();
  }
}

/**
 * The migrated schema, serialized once, so an in-memory database is a restore
 * rather than a replay. `MIGRATIONS` is a module constant, so a template built from
 * it cannot go stale while the process lives.
 */
let schemaTemplate: Uint8Array | undefined;

/**
 * In-memory database for tests.
 *
 * `open(":memory:")` replays every migration per call; a snapshot restore does not.
 * `migrate()` stays correct against the result — the `migration` table arrives
 * already stamped. `PRAGMA foreign_keys` is per-connection and does **not** travel
 * in the snapshot, so it is re-applied here or the constraint tests assert nothing.
 */
export function openMemory(): DB {
  schemaTemplate ??= open(":memory:").serialize();
  const db = Database.deserialize(schemaTemplate);
  db.run("PRAGMA foreign_keys = ON");
  return db;
}

/**
 * The `setting` key/value table, read and written in one place.
 *
 * `null` deletes rather than storing "null": the absent value is what every reader
 * here already tests for, and a row holding the four characters would read back as
 * present. Typed settings — the `cfg.*` paths with validation and defaults — are a
 * different concern and stay in `platform/config/settings.ts`.
 */
export function readSetting(db: DB, key: string): string | null {
  return db.query<{ v: string }, [string]>("SELECT v FROM setting WHERE k = ?").get(key)?.v ?? null;
}

export function writeSetting(db: DB, key: string, value: string | null): void {
  if (value === null) db.run("DELETE FROM setting WHERE k = ?", [key]);
  else db.run("INSERT INTO setting (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", [key, value]);
}

/**
 * What happens to a row that points at a slice being dropped.
 *
 * `null` = the row survives and forgets the slice (history: what ran, what was
 * written down). `delete` = the row was part of the plan being replaced.
 * `test/drop-slices.test.ts` reads `PRAGMA foreign_key_list` for every table and
 * fails if one references `slice` without a line here.
 */
export const SLICE_REFS: Record<string, Record<string, "null" | "delete">> = {
  task: { slice_id: "delete" },
  job: { slice_id: "null" },
  note: { slice_id: "null" },
  slice: { depends_on: "null" },
};

/** Drop a group's slices and everything that was planned with them. */
export function dropSlices(db: DB, grpId: number): void {
  const pick = "SELECT id FROM slice WHERE grp_id = ?";
  db.transaction(() => {
    for (const [table, cols] of Object.entries(SLICE_REFS)) {
      for (const [col, how] of Object.entries(cols)) {
        db.run(
          how === "null"
            ? `UPDATE ${table} SET ${col} = NULL WHERE ${col} IN (${pick})`
            : `DELETE FROM ${table} WHERE ${col} IN (${pick})`,
          [grpId],
        );
      }
    }
    db.run("DELETE FROM slice WHERE grp_id = ?", [grpId]);
  })();
}
