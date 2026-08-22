import { expect, test } from "bun:test";
import { count, sql } from "drizzle-orm";
import { Bus } from "../../src/platform/persistence/event-bus.ts";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { note } from "../../src/platform/persistence/schema.ts";
import { sameComplaint, sediment, SIMILARITY_FLOOR } from "../../src/mech/knowledge/lessons.ts";
import { bossFact } from "../../src/api/panel/attach.ts";
import type { Ctx } from "../../src/mech/ctx.ts";
import { AgentTurnPayloadSchema, type Job } from "../../src/platform/scheduling/scheduler.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";
import * as fx from "../support/factories.ts";
import { seedAuth } from "../support/seed-auth.ts";
import { loadConfig } from "../../src/platform/config/load.ts";
import { newScheduler } from "../support/scheduler.ts";

/**
 * docs/project/plan.md §7③. Without this the boss's dissatisfaction produces N isolated facts:
 * "tests are too shallow" said to three groups leaves the fourth group writing shallow
 * tests, because a fact on one group is invisible to the next.
 */
async function harness() {
  const db = await openMemory();
  await seedAuth(db);
  const f = fx.on(db);
  const ran: Job[] = [];
  const ctx: Ctx = {
    db,
    bus: new Bus(db),
    sched: newScheduler(db, async (j) => void ran.push(j)),
    sandbox: fakeSandbox(),
    waiters: new Map(),
    config: { ...loadConfig(), feedbackSedimentThreshold: 3 },
  };
  const p = await f.project.create({ name: "p" });
  for (const name of ["g1", "g2", "g3"]) await f.runningGrp.create({ project_id: p.id, name });
  return { db, ctx, ran };
}

/**
 * The same complaint reworded, in every language the boss might write in.
 *
 * Korean, Russian and Arabic are why this compares character bigrams rather than
 * tokens: 테스트가 and 테스트는 are one noun with two particles, граничных and граничные
 * one adjective in two cases, حالات and الحالات one noun with the article. Exact
 * token matching scored those three pairs 0.100, 0.250 and 0.222 — under complaints
 * that have nothing to do with each other.
 */
test("a reworded complaint is the same complaint, whatever it is written in", () => {
  expect({
    zh: sameComplaint("测试写得太浅，没有边界用例", "测试太浅了，边界都没覆盖"),
    zh2: sameComplaint("测试太浅", "测试很浅"),
    en: sameComplaint("QA tests are shallow, no edge cases", "the tests are shallow and skip edge cases"),
    ja: sameComplaint("テストが浅すぎる、境界ケースがない", "テストは浅い、境界ケースを飛ばしている"),
    ko: sameComplaint("테스트가 너무 얕다, 경계 케이스가 없다", "테스트는 얕고 경계 케이스를 건너뛴다"),
    ru: sameComplaint(
      "тесты слишком поверхностные, нет граничных случаев",
      "тесты поверхностные и пропускают граничные случаи",
    ),
    ar: sameComplaint("الاختبارات سطحية جدا ولا توجد حالات حدية", "الاختبارات سطحية وتتخطى الحالات الحدية"),
    de: sameComplaint(
      "die Tests sind zu oberflächlich, keine Randfälle",
      "die Tests sind oberflächlich und überspringen Randfälle",
    ),
    th: sameComplaint("การทดสอบตื้นเกินไป ไม่มีกรณีขอบ", "การทดสอบตื้น และข้ามกรณีขอบ"),
  }).toEqual({ zh: true, zh2: true, en: true, ja: true, ko: true, ru: true, ar: true, de: true, th: true });
});

/**
 * Unrelated complaints never merge. That is the requirement; the rest is tolerance.
 *
 * 「这个接口应该返回错误码」 and 「这个按钮应该显示提示」 share 这个 and 应该 and nothing else,
 * which a *count* of shared terms read as a match. Three of these sedimenting sends
 * the CoS a rule to write out of complaints that are not one complaint.
 */
test("complaints with nothing in common do not merge", () => {
  expect({
    functionWords: sameComplaint("这个接口应该返回错误码", "这个按钮应该显示提示"),
    zh: sameComplaint("测试写得太浅", "这个按钮颜色不对"),
    ko: sameComplaint("테스트가 너무 얕다", "이 버튼 색깔이 이상하다"),
    de: sameComplaint("die Tests sind zu oberflächlich", "die Farbe dieses Knopfes ist falsch"),
    en: sameComplaint("the tests are shallow", "this button colour is wrong"),
  }).toEqual({ functionWords: false, zh: false, ko: false, de: false, en: false });
});

/**
 * Same subject, different problem, and this deliberately merges them.
 *
 * Surface similarity cannot separate 「构建失败」 from 「构建太慢」 — measured, every method
 * tried scores the pair at or above a true rewording — and it does not need to. Both
 * are complaints about the build, the CoS reads all three before writing anything,
 * and the alternative is a floor that also drops Korean.
 */
test("same subject, different problem, sediments together on purpose", () => {
  expect(sameComplaint("构建失败", "构建太慢")).toBe(true);
});

/**
 * A complaint with no terms is not alike anything, including itself.
 *
 * Punctuation, or one character after the stop words. Zero over zero as a match
 * would make every contentless note kin to every other.
 */
test("a complaint with nothing in it matches nothing", () => {
  expect(sameComplaint("、。！", "、。！")).toBe(false);
  expect(sameComplaint("", "测试太浅")).toBe(false);
});

test("the floor sits in the gap the measurement found", () => {
  // 0.310 is the lowest true pair measured (Korean), 0.170 the highest false one.
  expect(SIMILARITY_FLOOR).toBeGreaterThan(0.17);
  expect(SIMILARITY_FLOOR).toBeLessThan(0.31);
});

test("the third time it becomes a project rule, and does not fire again on the same three", async () => {
  const h = await harness();
  const cosTurns = () => h.ran.filter((j) => AgentTurnPayloadSchema.parse(j.payload_json).role === "cos");

  await bossFact(h.ctx, 1, "测试写得太浅，边界用例没有");
  expect(cosTurns().length).toBe(0);
  await bossFact(h.ctx, 2, "测试太浅了，边界都没覆盖");
  expect(cosTurns().length).toBe(0);
  // Third: the CoS is asked to write the rule, and gets all three so it can generalise.
  await bossFact(h.ctx, 3, "又是测试太浅，边界情况呢");
  const turn = cosTurns();
  expect(turn.length).toBe(1);
  expect(AgentTurnPayloadSchema.parse(turn[0]!.payload_json).sediment).toHaveLength(3);

  // The three are marked, so a fourth unrelated fact does not re-fire on them — that
  // is how one complaint would become a rule every single time forever.
  await bossFact(h.ctx, 1, "按钮颜色不对");
  expect(cosTurns().length).toBe(1);

  // The same predicate `lessons.ts` selects on: the mark is the JSON string "1".
  const [marked] = await h.db
    .select({ c: count() })
    .from(note)
    .where(sql`${note.frontmatter_json} ->> 'sedimented' = '1'`);
  expect(marked!.c).toBe(3);
});

test("a project's complaints are its own", async () => {
  const h = await harness();
  const f = fx.on(h.db);
  const other = await f.project.create({ name: "other", repo_path: "/tmp/o" });
  await f.runningGrp.create({ project_id: other.id, name: "x" });
  await bossFact(h.ctx, 1, "测试写得太浅，边界用例没有");
  await bossFact(h.ctx, 2, "测试太浅了，边界都没覆盖");
  await bossFact(h.ctx, 4, "测试太浅，边界没覆盖"); // other project
  expect(h.ran.filter((j) => AgentTurnPayloadSchema.parse(j.payload_json).role === "cos").length).toBe(0);
  expect(await sediment(h.ctx, 1, 3)).toBe(0);
});
