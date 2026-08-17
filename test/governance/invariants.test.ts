import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ESCALATION_STATES,
  GRP_STATES,
  JOB_STATES,
  LEASE_STATES,
  SLICE_STATES,
  TASK_STATES,
} from "../../src/contracts/states.ts";
import { INVARIANT_TABLES, runInvariants, uncovered } from "../../src/mech/ops/invariants.ts";
import { testContext } from "../support/test-context.ts";

/**
 * The one check this table exists for.
 *
 * Every rule in the watchdog was bought with an incident, and all of them have the
 * same shape: a transition exactly one code path fires, which then does not fire.
 * Adding a state without saying who pushes it is how the next one gets bought, so
 * that failure happens here instead — at `bun test`, in the commit that adds it.
 */
test("every state says who pushes it out", () => {
  expect(uncovered()).toEqual({
    grp: [],
    slice: [],
    task: [],
    job: [],
    escalation: [],
    util: [],
    project: [],
    server: [],
    lease: [],
  });

  expect(Object.keys(INVARIANT_TABLES)).toEqual([
    "grp",
    "slice",
    "task",
    "job",
    "escalation",
    "util",
    "project",
    "server",
    "lease",
  ]);

  for (const i of Object.values(INVARIANT_TABLES).flat()) {
    // `driver: null` is a real answer — terminal, or a human is deliberately being
    // waited on. An empty string is the unanswered question.
    expect(i.driver === null || i.driver.length > 10).toBe(true);
    expect(i.must.length).toBeGreaterThan(10);
  }
});

test("every repair-bearing table is in the production runner", () => {
  expect(
    Object.entries(INVARIANT_TABLES)
      .filter(([, rows]) => rows.some((row) => row.repair))
      .map(([name]) => name),
  ).toEqual(["grp", "slice", "project"]);
});

test("the project repair executes through the production registry", () => {
  const ctx = testContext();
  ctx.db.run(
    "INSERT INTO project (name, repo_path, remote, created_at) VALUES ('p', '/tmp/p', 'git@github.com:me/x.git', 0)",
  );
  ctx.db.run(
    "INSERT INTO escalation (severity, question, chain_state, created_at) VALUES ('blocker', 'GitHub me/x: unavailable', 'boss', 0)",
  );

  runInvariants(ctx);

  expect(ctx.db.query<{ state: string }, []>("SELECT chain_state AS state FROM escalation").get()!.state).toBe(
    "revoked",
  );
});

test("a state in the table is a state something actually writes", () => {
  // The alignment check above cannot catch this: `states.ts` and `invariants.ts`
  // are edited together, so a state the database never produces passes green in
  // both. `lease.cancelled` lived here for exactly that reason — every writer of
  // `lease.state` is the INSERT, the executor and `finishLease`, and none of
  // them writes it; what gets cancelled is the job, and the lease row stays
  // `queued`.
  //
  // ponytail: greps for the quoted literal rather than parsing SQL. It cannot
  // see a state written through a variable, and a comment quoting the word
  // would pass it — a smoke check for "nothing writes this at all", not a
  // proof. Parse the statements if it ever misses one that matters.
  const src: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts") && !p.endsWith("states.ts") && !p.endsWith("invariants.ts")) {
        src.push(readFileSync(p, "utf8"));
      }
    }
  };
  walk("src");
  const all = src.join("\n");

  // Stored states only. `project`, `server` and `util` are computed conditions —
  // `repoHeld()` answers a boolean, `serverAction()` decides absent/refusing —
  // so there is no literal to write and nothing here to check.
  const STATES = {
    grp: GRP_STATES,
    slice: SLICE_STATES,
    task: TASK_STATES,
    job: JOB_STATES,
    escalation: ESCALATION_STATES,
    lease: LEASE_STATES,
  };
  for (const [table, states] of Object.entries(STATES)) {
    for (const s of states) {
      expect(`${table}.${s}: ${all.includes(`'${s}'`) || all.includes(`"${s}"`)}`).toBe(`${table}.${s}: true`);
    }
  }
});
