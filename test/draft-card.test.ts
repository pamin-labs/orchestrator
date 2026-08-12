import { expect, test } from "bun:test";
import { validateDraftCard } from "../src/mech/validate.ts";

const good = `目标 : token 校验挪到 middleware
不做 : 不动 legacy client 的鉴权协议
验收 : bun test 全绿
验收 : 单请求只查 DB 一次（加断言）
切片 : token 校验挪到 middleware [normal] — mw.test.ts 绿
切片 : legacy header 兼容 [trivial] — 老 client 的 e2e 用例绿
切片 : 补 middleware 单测 [normal] — 覆盖 401/403 两条路径
风险 : 老 client 带 legacy header，加了兼容分支
反对 : 无`;

test("a well-formed card parses", () => {
  const r = validateDraftCard(good);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.goal).toBe("token 校验挪到 middleware");
  expect(r.accept.length).toBe(2);
  expect(r.slices.length).toBe(3);
  expect(r.slices[0]).toEqual({
    title: "token 校验挪到 middleware",
    difficulty: "normal",
    accept: "mw.test.ts 绿",
  });
  expect(r.objection).toBe("无");
  expect(r.lines).toBeLessThanOrEqual(12);
});

test("12 lines is the limit; 13 are rejected — the card blocks the boss", () => {
  const twelve = `${good}\n切片 : d [trivial] — x\n切片 : e [trivial] — y\n风险 : 第二条风险`;
  expect(twelve.split("\n").length).toBe(12);
  expect(validateDraftCard(twelve).ok).toBe(true);

  const r = validateDraftCard(`${twelve}\n反对 : Architect 觉得 S2 该合进 S1`);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("max 12");
});

test("a missing section is named, not silently defaulted", () => {
  const r = validateDraftCard(good.split("\n").filter((l) => !l.startsWith("不做")).join("\n"));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("不做");
});

test("a slice without a difficulty tag is rejected — the tag picks the model", () => {
  const r = validateDraftCard(good.replace(" [normal] ", " "));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("difficulty");
});

test("an unknown difficulty is rejected", () => {
  const r = validateDraftCard(good.replace("[trivial]", "[easy]"));
  expect(r.ok).toBe(false);
});

test("a slice with no acceptance method is rejected", () => {
  const r = validateDraftCard(good.replace(" [normal] — mw.test.ts 绿", " [normal]"));
  expect(r.ok).toBe(false);
});

test("wrong slice count is rejected on both ends", () => {
  const two = good.split("\n").filter((l) => !l.startsWith("切片 : 补")).join("\n");
  expect(validateDraftCard(two).ok).toBe(false);
});

test("wrong acceptance-criteria count is rejected", () => {
  const one = good.split("\n").filter((l) => !l.includes("只查 DB")).join("\n");
  const r = validateDraftCard(one);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("2-3");
});

test("an empty 反对 is rejected — Architect must object or write 无", () => {
  const r = validateDraftCard(good.replace("反对 : 无", "反对 :"));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("反对");
});

test("full-width colons and bullet continuations are accepted", () => {
  const wide = good.replace(/ : /g, "：").replace("切片：补", "切片：- 补");
  expect(validateDraftCard(wide).ok).toBe(true);
});

test("two slices accepted by the same thing are one deliverable", () => {
  const dup = good.replace("切片 : legacy header 兼容 [trivial] — 老 client 的 e2e 用例绿", "切片 : legacy header 兼容 [trivial] — mw.test.ts 绿");
  const r = validateDraftCard(dup);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("one deliverable");
});

test("nested acceptance criteria mean one slice finishes the other", () => {
  const nested = good.replace(
    "切片 : 补 middleware 单测 [normal] — 覆盖 401/403 两条路径",
    "切片 : 再加一点 [normal] — mw.test.ts 绿并且覆盖 401",
  );
  const r = validateDraftCard(nested);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("nested acceptance");
});

test("a tests-only slice is refused — tests belong with their change", () => {
  // The exact shape a real run produced: 加参数 / 实现分支 / 补充测试用例.
  for (const title of ["补充测试用例", "添加单元测试", "add tests", "测试"]) {
    const card = good.replace("切片 : 补 middleware 单测 [normal] — 覆盖 401/403 两条路径", `切片 : ${title} [trivial] — 覆盖两条路径`);
    const r = validateDraftCard(card);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Tests belong with");
  }
});

test("a slice that adds a test suite for something specific is still allowed", () => {
  // The guard is narrow on purpose: only bare "tests" is refused, because a named
  // test target can genuinely be its own deliverable.
  const card = good.replace(
    "切片 : 补 middleware 单测 [normal] — 覆盖 401/403 两条路径",
    "切片 : legacy client 回归测试套件 [normal] — 覆盖 401/403 两条路径",
  );
  expect(validateDraftCard(card).ok).toBe(true);
});

test("a single-slice card is never blamed for a bad split", () => {
  const one = `目标 : x
不做 : y
验收 : a 绿
验收 : b 绿
切片 : 测试 [trivial] — 全绿
风险 : 无
反对 : 无`;
  // 3-5 slices is enforced separately; a lone slice cannot overlap anything.
  const r = validateDraftCard(one);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("3-5");
});

test("two slices may both require the suite to pass", () => {
  // A false positive here blocks a correct card, and "the tests pass" is true of
  // every slice — so it is never evidence that two slices overlap.
  const card = `目标 : x
不做 : y
验收 : bun test 全绿
验收 : 无回归
切片 : zh 支持 [normal] — bun test 全绿
切片 : locale 自动探测 [normal] — bun test 全绿且能从 env 读出 zh
切片 : 文档 [trivial] — README 写明用法
风险 : 无
反对 : 无`;
  expect(validateDraftCard(card).ok).toBe(true);
});

test("a genuinely nested criterion is still caught", () => {
  const card = `目标 : x
不做 : y
验收 : a
验收 : b
切片 : 加 lang 参数 [normal] — greet("x","zh") 返回你好 x
切片 : 顺便再做点 [normal] — greet("x","zh") 返回你好 x 并且 greet("x") 不变
切片 : 文档 [trivial] — README 写明用法
风险 : 无
反对 : 无`;
  const r = validateDraftCard(card);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("nested acceptance");
});
