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
  -- status: PLANNING | DRAFT | RUNNING | PAUSING | PAUSED | PARKED | PR_OPEN | DISSOLVED
  --   PLANNING: the Dispatcher/Architect are still working; DRAFT: the card awaits the boss

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

  // 009 — when a slice started waiting on the boss.
  //
  // "白干的单位是一个切片" (PLAN.md §7) only means something if the clock on it is
  // visible: a slice that has waited four hours is a different problem from one
  // that finished a minute ago, and the queue could not tell them apart.
  `ALTER TABLE slice ADD COLUMN awaiting_at INTEGER;`,

  // 010 — when the account's quota comes back.
  //
  // PLAN.md §11: hitting a rate limit degrades to a cheaper model and, if there is
  // nothing cheaper, waits for the reset. Without the timestamp "wait" meant "wait
  // for the boss", so one 429 at 01:00 cost the whole night.
  `ALTER TABLE grp ADD COLUMN rl_resets_at INTEGER;`,

  // 011 — the boss approved, but a boundary was in the way.
  //
  // Without this the click was thrown away: the group stayed in DRAFT, nothing
  // recorded that anyone had said yes, and the boss had to guess when to come
  // back and click again. One click has to be final.
  `ALTER TABLE grp ADD COLUMN approved_at INTEGER;`,

  // 012 — the group this one is waiting on.
  //
  // A group that hits a defect outside its own paths cannot fix it and cannot ask
  // anyone to: `orch mail` is a message, not a work item. So it escalated to the
  // boss and stopped, and the boss got a blocker with no button on it. Recording
  // which group now owns the problem is what lets the waiter start again by itself
  // when that group lands.
  `ALTER TABLE grp ADD COLUMN blocked_on INTEGER REFERENCES grp(id);`,

  // 013 — when this branch joined the merge queue.
  //
  // The queue is strictly serial, so a head nobody merges blocks everything behind
  // it — and there was no clock on it, which is what makes "the boss forgot" and
  // "it only just got there" look identical.
  `ALTER TABLE grp ADD COLUMN merge_seq_at INTEGER;`,

  // 014 — branch-level rework counter.
  //
  // A slice that keeps failing stops after `gateRetries` and asks the boss
  // (slice.retries). The branch had no such counter at all: a red branch gate sent
  // the Engineer round, a rejected audit sent the PM round, and neither loop had
  // an end. PLAN.md §"Gate 与审批顺序" says two rounds then escalate; this is the
  // column that makes that true.
  `ALTER TABLE grp ADD COLUMN pr_retries INTEGER NOT NULL DEFAULT 0;`,

  // 015 — shared paths this one group was granted, by name.
  //
  // Shared files belong to no group, which is right: two groups editing
  // package.json is the collision ownership exists to prevent. But a defect *in*
  // one still has to be fixable, and the requirement opened for it could never
  // start — the Architect can only cut its boundary to the file itself, and
  // canStart then refuses it as a shared path. `sweepApproved` retried that
  // forever. The grant is issued by the server when a group reports being blocked
  // by the file, names exactly that path, and is what lets this one requirement
  // through while every other group is still refused.
  `ALTER TABLE grp ADD COLUMN shared_grant TEXT;`,

  // 016 — the main commit this group has already been told to rebase onto.
  //
  // Without it the same nudge fires every watchdog tick for as long as the group
  // has not finished rebasing, which is exactly how a useful message becomes one
  // the agent learns to skip.
  `ALTER TABLE grp ADD COLUMN rebase_seen TEXT;`,

  // 017 — what a resource contends for, so the Runner pool can be split by it.
  //
  // One global `leaseSlots` has to be the minimum any resource can tolerate. A
  // headless browser tolerates 1 (each lease is a real Chromium); `typecheck`
  // tolerates as many as there are cores. Sized for the browser, every gate in
  // the fleet queues behind one screenshot; sized for the gates, the browsers
  // thrash. Tags name the contended thing, and each tag gets its own pool size.
  `ALTER TABLE resource ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';`,

  // 018 — consecutive turns that ended in a clearance denial.
  //
  // The first denial is not a question: the agent reached for a shape it was never
  // going to get and takes a legal route on its next turn by itself. Filing one
  // wakes three roles in the chain to think about it — measured, three turns at
  // ~3M tokens each. Only a repeat means the agent is actually stuck.
  `ALTER TABLE agent ADD COLUMN denial_turns INTEGER NOT NULL DEFAULT 0;`,

  // 019 — when this group was last told main had moved.
  //
  // `rebase_seen` records which commit, so three pushes in an hour are three
  // different shas and three rebase turns — the boss pushing a batch of fixes cost
  // one group three turns of pure rebasing. A clock lets a burst coalesce.
  `ALTER TABLE grp ADD COLUMN rebase_seen_at INTEGER;`,

  // 020 — how much of each subscription window is gone.
  //
  // One row per provider, overwritten. A table rather than a variable in the
  // server so the header is not blank after a restart, and the boss's answer to
  // "can this still run tonight" does not wait for the next turn to arrive.
  `
  CREATE TABLE usage_snapshot (
    runtime TEXT PRIMARY KEY,
    json    TEXT    NOT NULL,
    at      INTEGER NOT NULL
  );
  `,

  // 021 — the context window this agent's model actually reported.
  //
  // Rotation divided by a hardcoded 200_000 for every model. Both CLIs state the
  // real number during a turn (claude in modelUsage, codex in token_count), so
  // record it: a table in config goes stale the week a model ships.
  `ALTER TABLE agent ADD COLUMN context_window INTEGER;`,

  // 022 — which provider an agent runs on, and when that provider is out of quota.
  //
  // The window belongs to the account, not to the group that happened to hit it.
  // Pausing only that group left every other group to spend a turn discovering the
  // same wall, and a standing agent — no group to pause — kept retrying into it.
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
  // schema never created fails on every new install.
  //
  // Nothing displays them and nothing can: two subscriptions pay for this, so the
  // figure was what these turns would have cost at API rates on the half that
  // reported one, and zero on the other. A column half-populated with a number
  // nobody is billed for is worse than no column — it invites exactly the ranking
  // and the totals that were quietly wrong for every codex role.
  `
  ALTER TABLE grp DROP COLUMN spent_usd;
  ALTER TABLE slice DROP COLUMN spent_usd;
  ALTER TABLE agent DROP COLUMN total_usd;
  `,

  // 032 — one line of what a question is about, for the queue.
  //
  // 待办 showed the first two lines of the question itself, which is an agent
  // writing to another agent: `S2 "常驻岗独立分段" failed qa 3 times. Latest: 结构:
  // pass — splitDeskRows(tables.tsx:82-104)…`. Eight of those is a page of prose
  // in front of a reader whose whole job here is to pick which one to open.
  `ALTER TABLE escalation ADD COLUMN brief TEXT;`,

  // 033 — what kind of thing is being asked.
  //
  // One bad premise strands every slice behind it, so a requirement can hold a
  // dozen open questions that are all the same problem said twelve times — the
  // worktree has no playwright, the acceptance line cannot be verified. Twelve
  // cards is twelve decisions on a page where there is one.
  `ALTER TABLE escalation ADD COLUMN kind TEXT;`,
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

/**
 * What happens to a row that points at a slice being dropped.
 *
 * Re-approving a DRAFT rewrites the plan, which means the old slices go. They
 * are pointed at from four places and the delete only cleared one of them, so
 * approving a card for a group that had already run failed with the least
 * actionable message SQLite has: `FOREIGN KEY constraint failed`. Nothing said
 * which key, and the boss's only move was to click again.
 *
 * `null` = the row survives and forgets the slice (history: what ran, what was
 * written down). `delete` = the row was part of the plan being replaced.
 *
 * `test/drop-slices.test.ts` reads `PRAGMA foreign_key_list` for every table and
 * fails if one references `slice` without a line here — so the next table to
 * grow a `slice_id` cannot reintroduce this bug quietly.
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
