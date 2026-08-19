import { expect, test } from "bun:test";
import { makeApp } from "../../src/composition/api.ts";
import type { Ctx } from "../../src/mech/ctx.ts";
import { Bus } from "../../src/platform/persistence/event-bus.ts";
import { loadConfig, loadRoles } from "../../src/platform/config/load.ts";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { Scheduler, type Executor } from "../../src/platform/scheduling/scheduler.ts";
import { makeExecutor, sessionFor, type ExecDeps } from "../../src/application/executor.ts";
import type { TurnResult } from "../../src/runtime/claude.ts";
import type { TurnSpec } from "../../src/runtime/claude.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";
import * as fx from "../support/factories.ts";
import { seedAuth } from "../support/seed-auth.ts";
import { tempDir } from "../support/temp.ts";

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
  const cfg = { ...loadConfig(), dataDir: tempDir("orch-data-") };
  const specs: TurnSpec[] = [];
  let exec: Executor;
  const sched = new Scheduler(db, (j) => exec(j));
  const ctx: Ctx = {
    db,
    bus,
    sched,
    sandbox: fakeSandbox(),
    waiters: new Map(),
    config: cfg,
  };
  const deps: ExecDeps = {
    ctx,
    cfg,
    roles: loadRoles("roles"),
    runTurn: async (spec) => {
      specs.push(spec);
      return turn(spec);
    },
  };
  exec = makeExecutor(deps);

  const p = fx.project.insert(db, { name: "p" });
  fx.runningGrp.insert(db, { project_id: p.id, name: "g1" });
  return { db, ctx, sched, deps, specs, app: makeApp(ctx) };
}

test("session_tokens only counts input+cacheCreate, so heavy cacheRead never trips overTokenBudget", async () => {
  const { db, sched } = harness(async () => turnUsage());
  for (let i = 0; i < 5; i++) {
    sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
    await sched.drain();
  }

  const agent = db
    .query<{ session_tokens: number; total_tokens: number }, []>("SELECT session_tokens, total_tokens FROM agent")
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

/**
 * The one decision inside the turn spec, checked without running a turn.
 *
 * Wrong in either direction and silent in both: resuming a session the provider
 * has rotated away from fails the turn, and starting a new one while a session
 * was live throws away the cached prefix that makes a long requirement
 * affordable. It used to be a ternary inside an object literal, reachable only
 * by running a turn and reading the spec back out — which is why the whole
 * assembly showed as untested.
 */
test("a turn resumes only when there is a session and nothing asked to rotate", () => {
  const at = (rotate: boolean, session_id: string | null) =>
    sessionFor({ rotate, sessionId: "next", agent: { session_id } });

  expect(at(false, "live")).toEqual({ resumeSessionId: "next" });
  // Rotation is the whole point of rotation: the live session is abandoned.
  expect(at(true, "live")).toEqual({ newSessionId: "next" });
  // Nothing to resume. Both spellings of absent, because the column is nullable
  // and the row is fresh before the first turn.
  expect(at(false, null)).toEqual({ newSessionId: "next" });
  expect(at(false, "")).toEqual({ newSessionId: "next" });
});
