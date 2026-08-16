import { Database } from "bun:sqlite";
import { maskValue } from "./mech/util/scrub.ts";
import { parseRepo } from "./mech/git/repository.ts";

/**
 * Single source of truth for the schema. See PLAN.md §3.
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
    -- worktree is dropped by migration 024; like clearance below, it stays here
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
  -- clearance is dropped by migration 022; it is left here because the base
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

  // 034 — the group's sandbox.
  //
  // Durable because the Sandbox object is not: a restarted orchestrator has to
  // reconnect to the container that is still running, or the turn's session —
  // and with it the cached prefix the whole cost model rests on — dies with the
  // process that happened to create it.
  //
  // Two columns, not a join table: a sandbox has exactly two possible owners.
  // A group is the usual one; standing roles (Architect, CoS, Dispatcher) have
  // no group and still must not run on the host, so they share one per project.
  `
  ALTER TABLE grp ADD COLUMN sandbox_id TEXT;
  ALTER TABLE project ADD COLUMN sandbox_id TEXT;
  `,

  // 035 — where each runtime's credentials come from.
  //
  // The value never enters the sandbox: it is written to the egress sidecar's
  // vault and injected on the way out (docs/decisions/005). It never enters an
  // event, a prompt or a log either, and the API only ever returns it masked.
  //
  // `base_url` is what makes an OpenAI-compatible endpoint a configuration
  // rather than a fork.
  `
  CREATE TABLE runtime_auth (
    runtime    TEXT PRIMARY KEY,
    mode       TEXT NOT NULL,
    secret     TEXT NOT NULL,
    base_url   TEXT,
    updated_at INTEGER NOT NULL
  );
  `,

  // 036 — when a sandbox was built, so it can be told from the credential in it.
  //
  // A sidecar is loaded with the credentials that existed when its sandbox was
  // created and never again. Storing one therefore has to kill the running
  // sandboxes, and exactly one of the two ways to store one did — a login from
  // the panel saved the token and stopped, so every group kept a sidecar bound
  // to the credential that was still missing and every turn came back
  // "Authentication credentials are invalid" against a token that was fine.
  //
  // The fix that lasts is not a third call to the same helper. It is a fact on
  // the row: a sandbox older than the newest credential is stale, whoever stored
  // it and however they got there, and the watchdog reaps it on the next tick.
  `
  ALTER TABLE grp ADD COLUMN sandbox_at INTEGER;
  ALTER TABLE project ADD COLUMN sandbox_at INTEGER;
  `,

  // 022 — the last two columns of the clearance era.
  //
  // Neither was ever written: `clearance` stayed 'L1' on every row an insert ever
  // made, and the panel printed it as 「权限 L1」 — a permission level shown to the
  // boss by a system that has no permission levels. `denial_turns` counted
  // permission refusals, which cannot happen inside a container the CLI is told
  // to skip its own checks in. A column nobody writes is a claim nobody checks.
  `
  ALTER TABLE agent DROP COLUMN clearance;
  ALTER TABLE agent DROP COLUMN denial_turns;
  `,

  // 023 — server-scope settings that are not a project's and not the yaml's.
  //
  // The skill tick boxes are the first: which of the boss's own skills get staged
  // into the directory every sandbox mounts. It belongs to this machine, not to a
  // project, and the boss edits it in the panel — so neither `project.config_json`
  // nor the config yaml is the right home.
  `
  CREATE TABLE setting (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  );
  `,

  // 024 — the checkout moved into the container and this column stayed behind.
  //
  // Nothing ever wrote it. Four code paths read it and were gated on it being
  // non-null: the rollback behind "interrupt and roll back", the rebase on the way
  // out of PARKED, the rollback behind a revoked answer, and the change set the
  // reconcile gate scores claims against — that last one silently passed every
  // claim for as long as the column has existed.
  `
  ALTER TABLE grp DROP COLUMN worktree;
  `,

  // 025 — which branch this project is cut from and measured against.
  //
  // It was detected on every call and the detection returned `origin/main` where
  // four callers then wrote `origin/${...}`. NULL means "ask the remote", which is
  // resolved once and written back here — so the diff baseline is the same value
  // on the day a slice was cut and on the day the boss reads it.
  `
  ALTER TABLE project ADD COLUMN base_branch TEXT;
  `,

  // 026 — skill paths in old messages point at a machine the agent cannot see.
  //
  // The composer used to insert `.claude/skills/<name>/SKILL.md`, a path relative
  // to the boss's home. That was readable when turns ran on this machine. They run
  // in a container now, where the boss's skills are mounted somewhere else — so
  // every one of those paths is a file the agent is told to read and cannot. These
  // bodies are re-injected into later turns, which is why this is worth rewriting
  // rather than leaving as history: `/name` is what both CLIs resolve, wherever
  // the skill actually sits.
  rewriteSkillPaths,

  // 037 — a project is `owner/name`, not a directory on whoever's laptop.
  //
  // Every project now comes from GitHub (007 §2), so `repo_path` holds the slug
  // and nothing else. The conversion needs neither git nor the network: the
  // remote was recorded at registration and `parseRepo` reads the slug out of it.
  //
  // A row that cannot be converted keeps exactly what it had. Guessing an owner
  // from a directory name would write a repository that may belong to somebody
  // else, and dropping the row deletes a project the boss chose — so the data
  // stays and one question is raised naming all of them. `repoHref` still refuses
  // anything shaped like a path, so an unconverted row renders as it always did.
  slugRepoPaths,

  // 038 — what this branch is called in a log, written by an agent that read it.
  //
  // The pull request title was `orch: <group name>`, a slug the dispatcher made
  // up before any code existed, and the squashed commit carried the whole PR body
  // under it — headings, gate tables, `Opened by orchestrator`. A reviewer's log
  // is the least generous place this project shows up in, and it showed up as
  // eight rows of the same prefix.
  //
  // Two columns rather than one so the commit and the PR can differ where they
  // should: `pr_title` is the subject both use, `pr_summary` is the body of the
  // commit and the first section of the PR — the record sections below it are
  // still built from the database, which knows them better than any agent.
  `
  ALTER TABLE grp ADD COLUMN pr_title TEXT;
  `,
  `
  ALTER TABLE grp ADD COLUMN pr_summary TEXT;
  `,

  // 039 — two settings that predate the settings table, onto it.
  //
  // `sandbox_image` and `sandbox_server_addr` were the first two things the
  // panel could change about this machine, and each got its own key, its own
  // reader and its own writer. Now that every config path is settable the same
  // way, keeping them special means one value with two homes and a precedence
  // order that exists only in code — the shape this project has been burned by
  // (see `grp.worktree`, a column nothing wrote and four things read).
  //
  // JSON-quoted on the way across, because the settings table stores JSON and
  // these two stored the bare string.
  `
  INSERT OR REPLACE INTO setting (k, v)
    SELECT 'cfg.sandbox.image', json_quote(v) FROM setting WHERE k = 'sandbox_image';
  INSERT OR REPLACE INTO setting (k, v)
    SELECT 'cfg.sandbox.server', json_quote(v) FROM setting WHERE k = 'sandbox_server_addr';
  DELETE FROM setting WHERE k IN ('sandbox_image', 'sandbox_server_addr');
  `,

  // 040 — why a group is paused, so that resuming can be about that reason.
  //
  // `paused_at` said when, never why, and eight places wrote it for eight
  // different causes. So the one bulk resume in the tree — `credentialChanged`,
  // after the boss signs in — matched every PAUSED row there was: groups stopped
  // for burning their budget, groups blocked on another group, groups the boss
  // paused by hand. Signing into GitHub restarted work the boss had deliberately
  // stopped, and the rate-limited ones came back with `rl_resets_at` still set,
  // which watchdog rule 6 only ever clears for rows it finds still PAUSED.
  //
  // Backfilled as 'unknown' rather than guessed: an existing PAUSED row is one
  // whose cause was never recorded, and a wrong reason resumes the wrong group.
  `
  ALTER TABLE grp ADD COLUMN pause_reason TEXT;
  UPDATE grp SET pause_reason = 'unknown' WHERE status IN ('PAUSED', 'PAUSING', 'PARKED');
  `,
];

export type DB = Database;

/** Migration 026, exported so it can be run against a database that has rows. */
export function rewriteSkillPaths(db: DB): void {
  const like = "%skills/%/SKILL.md";
  for (const table of ["note", "event"] as const) {
    const key = table === "note" ? "id" : "seq";
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
 * value that is not an absolute path is already in its destination shape and is
 * left alone. Exported for the same reason `rewriteSkillPaths` is — a data
 * migration with a decision in it is worth a test.
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
  // One question, not one per project: they are the same problem said N times,
  // and a queue of them is N decisions on a page where there is one.
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
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  // Whatever was stored before this process started still has to be masked out
  // of everything it prints. Registered once, here, because every path into the
  // database comes through this function.
  for (const { secret } of db.query<{ secret: string }, []>("SELECT secret FROM runtime_auth").all()) {
    maskValue(secret);
  }
  return db;
}

/**
 * Which migration this SQL belongs to, 1-based, for a test that wants to replay
 * one against rows a fresh database cannot have.
 *
 * By content, not by position: `test/settings.test.ts` used to rewind
 * `max(n)` and call it "this one", which meant it silently retargeted itself at
 * whatever migration was added next — and then failed on that migration's own
 * `ALTER TABLE`, naming a column the test has never heard of.
 */
export function migrationMentioning(needle: string): number {
  const i = MIGRATIONS.findIndex((m) => typeof m === "string" && m.includes(needle));
  if (i < 0) throw new Error(`no migration mentions ${needle}`);
  return i + 1;
}

/** Apply any migrations the database has not seen yet. Idempotent. */
export function migrate(db: DB): void {
  db.exec("CREATE TABLE IF NOT EXISTS migration (n INTEGER PRIMARY KEY, at INTEGER NOT NULL)");
  const applied = db
    .query<{ n: number }, []>("SELECT n FROM migration")
    .all()
    .map((r) => r.n);
  const stamp = db.prepare("INSERT INTO migration (n, at) VALUES (?, ?)");
  for (const [i, step] of MIGRATIONS.entries()) {
    const n = i + 1;
    if (applied.includes(n)) continue;
    db.transaction(() => {
      if (typeof step === "string") db.exec(step);
      else step(db);
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
