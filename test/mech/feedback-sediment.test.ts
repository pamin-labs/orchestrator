import { expect, test } from "bun:test";
import { Bus } from "../../src/platform/persistence/event-bus.ts";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { OVERLAP_FLOOR, sameComplaint, sediment, terms } from "../../src/mech/knowledge/lessons.ts";
import { bossFact } from "../../src/api/panel/attach.ts";
import type { Ctx } from "../../src/mech/ctx.ts";
import { AgentTurnPayloadSchema, Scheduler, type Job } from "../../src/platform/scheduling/scheduler.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";
import * as fx from "../support/factories.ts";
import { seedAuth } from "../support/seed-auth.ts";
import { loadConfig } from "../../src/platform/config/load.ts";

/**
 * docs/project/plan.md §7③. Without this the boss's dissatisfaction produces N isolated facts:
 * "tests are too shallow" said to three groups leaves the fourth group writing shallow
 * tests, because a fact on one group is invisible to the next.
 */
function harness() {
  const db = openMemory();
  seedAuth(db);
  const ran: Job[] = [];
  const ctx: Ctx = {
    db,
    bus: new Bus(db),
    sched: new Scheduler(db, async (j) => void ran.push(j)),
    sandbox: fakeSandbox(),
    waiters: new Map(),
    config: { ...loadConfig(), feedbackSedimentThreshold: 3 },
  };
  const p = fx.project.insert(db, { name: "p" });
  for (const name of ["g1", "g2", "g3"]) fx.runningGrp.insert(db, { project_id: p.id, name });
  return { db, ctx, ran };
}

test("the same complaint in different words is recognised; unrelated ones are not", () => {
  expect(terms("测试写得太浅").has("测试")).toBe(true);
  // Two shared distinctive terms, not one: one is a coincidence.
  expect(OVERLAP_FLOOR).toBe(2);
  expect(sameComplaint("测试写得太浅，没有边界用例", "测试太浅了，边界都没覆盖")).toBe(true);
  expect(sameComplaint("QA tests are shallow, no edge cases", "the tests are shallow and skip edge cases")).toBe(true);
  expect(sameComplaint("测试写得太浅", "这个按钮颜色不对")).toBe(false);
});

test("the third time it becomes a project rule, and does not fire again on the same three", () => {
  const h = harness();
  const cosTurns = () => h.ran.filter((j) => AgentTurnPayloadSchema.parse(JSON.parse(j.payload_json)).role === "cos");

  bossFact(h.ctx, 1, "测试写得太浅，边界用例没有");
  expect(cosTurns().length).toBe(0);
  bossFact(h.ctx, 2, "测试太浅了，边界都没覆盖");
  expect(cosTurns().length).toBe(0);
  // Third: the CoS is asked to write the rule, and gets all three so it can generalise.
  bossFact(h.ctx, 3, "又是测试太浅，边界情况呢");
  const turn = cosTurns();
  expect(turn.length).toBe(1);
  expect(AgentTurnPayloadSchema.parse(JSON.parse(turn[0]!.payload_json)).sediment).toHaveLength(3);

  // The three are marked, so a fourth unrelated fact does not re-fire on them — that
  // is how one complaint would become a rule every single time forever.
  bossFact(h.ctx, 1, "按钮颜色不对");
  expect(cosTurns().length).toBe(1);

  const marked = h.db
    .query<{ c: number }, []>("SELECT count(*) AS c FROM note WHERE json_extract(frontmatter_json, '$.sedimented') = 1")
    .get()!.c;
  expect(marked).toBe(3);
});

test("a project's complaints are its own", () => {
  const h = harness();
  const other = fx.project.insert(h.db, { name: "other", repo_path: "/tmp/o" });
  fx.runningGrp.insert(h.db, { project_id: other.id, name: "x" });
  bossFact(h.ctx, 1, "测试写得太浅，边界用例没有");
  bossFact(h.ctx, 2, "测试太浅了，边界都没覆盖");
  bossFact(h.ctx, 4, "测试太浅，边界没覆盖"); // other project
  expect(h.ran.filter((j) => AgentTurnPayloadSchema.parse(JSON.parse(j.payload_json)).role === "cos").length).toBe(0);
  expect(sediment(h.ctx, 1, 3)).toBe(0);
});
