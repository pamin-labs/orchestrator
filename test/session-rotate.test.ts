import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeApp, type Ctx } from "../src/api.ts";
import { Bus } from "../src/bus.ts";
import { loadConfig, loadRoles } from "../src/config.ts";
import { openMemory } from "../src/db.ts";
import { RepoLock } from "../src/mech/gitlock.ts";
import { Scheduler } from "../src/scheduler.ts";
import { makeExecutor, type ExecDeps } from "../src/runtime/executor.ts";
import type { TurnResult } from "../src/runtime/claude.ts";
import type { TurnSpec } from "../src/runtime/claude.ts";
import { fakeSandbox } from "./fake-sandbox.ts";
import { seedAuth } from "./seed-auth.ts";

// A big cacheRead per turn, small input/cacheCreate — the pattern that made
// overTokenBudget trip every turn when session_tokens counted all four fields.
function turnUsage(over: Partial<TurnResult> = {}): TurnResult {
  return {
    sessionId: "s1",
    ok: true,
    terminalReason: "completed",
    text: "done",
    usage: { input: 10, output: 20, cacheRead: 300_000, cacheCreate: 100, thinking: 0 },
    numTurns: 1,
    toolSummaries: [],
    filesTouched: [],
    ...over,
  };
}

function harness(turn: (spec: TurnSpec) => Promise<TurnResult>) {
  const db = openMemory();
  seedAuth(db);
  const bus = new Bus(db);
  const cfg = { ...loadConfig(), dataDir: mkdtempSync(join(tmpdir(), "orch-data-")) };
  const specs: TurnSpec[] = [];
  let exec: any = null;
  const sched = new Scheduler(db, (j) => exec(j));
  const ctx: Ctx = {
    db,
    bus,
    sched,
    gitLock: new RepoLock(),
    sandbox: fakeSandbox(), waiters: new Map(),
    config: { language: cfg.language, workRoot: cfg.workRoot },
  };
  const deps: ExecDeps = {
    ctx,
    cfg,
    roles: loadRoles("roles"),
    git: async () => ({ code: 1, out: "" }),
    runTurn: async (spec) => {
      specs.push(spec);
      return turn(spec);
    },
  };
  exec = makeExecutor(deps);

  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  db.run("INSERT INTO grp (project_id, name, status, created_at) VALUES (1, 'g1', 'RUNNING', 0)");
  return { db, ctx, sched, deps, specs, app: makeApp(ctx) };
}

test("session_tokens only counts input+cacheCreate, so heavy cacheRead never trips overTokenBudget", async () => {
  const { db, sched } = harness(async () => turnUsage());
  for (let i = 0; i < 5; i++) {
    sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
    await sched.drain();
  }

  const agent = db
    .query<{ session_tokens: number; total_tokens: number }, []>(
      "SELECT session_tokens, total_tokens FROM agent",
    )
    .get()!;
  // 5 turns * (input 10 + cacheCreate 100) = 550, far under the 120k ceiling —
  // counting cacheRead too would have put this at 1.5M and rotated every turn.
  expect(agent.session_tokens).toBe(550);
  expect(agent.total_tokens).toBe(5 * (10 + 20 + 300_000 + 100));
});

test("rotating a session zeroes session_tokens instead of carrying it forward", async () => {
  const { db, sched, specs } = harness(async () => turnUsage());
  sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();
  sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();
  // Two turns in the same session: accumulated, not reset.
  expect(db.query<{ t: number }, []>("SELECT session_tokens AS t FROM agent").get()!.t).toBe(220);
  // What the runtime reported, not what we minted: codex starts a thread of its
  // own and only that id is resumable.
  expect(specs[1]!.resumeSessionId).toBe("s1");

  // Force a rotation the same way a stale stable hash or an explicit request does.
  sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer", rotate: true } });
  await sched.drain();

  // Reset by the rotation, then this turn's own usage is the only thing counted —
  // not 330, which is what carrying the old session's total forward would give.
  expect(db.query<{ t: number }, []>("SELECT session_tokens AS t FROM agent").get()!.t).toBe(110);
});
