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
