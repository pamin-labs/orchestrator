import { expect, test } from "bun:test";
import { criteriaIn, validateDraftCard, validateSelfReview } from "../../src/mech/util/validate.ts";

const good = `## goal
token 校验挪到 middleware

## non-goals
不动 legacy client 的鉴权协议

## accept
- bun test 全绿
- 单请求只查 DB 一次（加断言）

## slices
| slice | difficulty | accept |
| --- | --- | --- |
| token 校验挪到 middleware | normal | mw.test.ts 绿 |
| legacy header 兼容 | trivial | 老 client 的 e2e 用例绿 |
| 补 middleware 单测 | normal | 覆盖 401/403 两条路径 |

## risk
- 老 client 带 legacy header，加了兼容分支

## objection
无`;

/** The shape agents emitted before Markdown, still sitting in `note.body`. */
const legacy = `goal : token 校验挪到 middleware
non-goals : 不动 legacy client 的鉴权协议
accept : bun test 全绿
accept : 单请求只查 DB 一次（加断言）
slices : token 校验挪到 middleware [normal] — mw.test.ts 绿
slices : legacy header 兼容 [trivial] — 老 client 的 e2e 用例绿
slices : 补 middleware 单测 [normal] — 覆盖 401/403 两条路径
risk : 老 client 带 legacy header，加了兼容分支
objection : 无`;

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

test("a card stored in the pre-Markdown format still parses", () => {
  // Cards live in `note.body` as text and are re-validated when the boss
  // approves, so a group filed before this format existed must not become
  // unapprovable. Legacy path, removed in 0.2.0.
  const r = validateDraftCard(legacy);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.slices.length).toBe(3);
  expect(r.slices[1]).toEqual({
    title: "legacy header 兼容",
    difficulty: "trivial",
    accept: "老 client 的 e2e 用例绿",
  });
});

test("the same card in either format gives the same result", () => {
  // The parser was swapped; the card was not. If these two ever disagree, an
  // approved group would get different slices depending on when it was filed.
  expect(validateDraftCard(good)).toEqual(validateDraftCard(legacy));
});

test("12 content lines is the limit; 13 are rejected — the card blocks the boss", () => {
  // Headings and the table header are structure: nine content lines here.
  const twelve = good
    .replace(
      "| 补 middleware 单测 | normal | 覆盖 401/403 两条路径 |",
      "| 补 middleware 单测 | normal | 覆盖 401/403 两条路径 |\n| d | trivial | 关掉开关后旧路径还在 |\n| e | trivial | 配置项能从 env 读出 |",
    )
    .replace(
      "- 老 client 带 legacy header，加了兼容分支",
      "- 老 client 带 legacy header，加了兼容分支\n- 开关默认值改了",
    );
  const r12 = validateDraftCard(twelve);
  expect(r12.ok).toBe(true);
  if (r12.ok) expect(r12.lines).toBe(12);

  const r = validateDraftCard(`${twelve}\n\nArchitect 觉得 S2 该合进 S1`);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("max 12");
});

/**
 * Every way a well-formed card can still be refused. These cases differ only in
 * the edit made to `good` and the reason the boss is shown, so they are one rule
 * with a table rather than eight bodies of the same four lines.
 *
 * The reason is asserted, never just the refusal: `ok === false` alone passes
 * when the card is rejected for something else entirely, and two of these cases
 * used to assert exactly that.
 */
const rejections: [name: string, from: string, to: string, reason: string][] = [
  ["a missing section", "## non-goals\n不动 legacy client 的鉴权协议\n\n", "", "missing sections: non-goals"],
  [
    "a slice without a difficulty, which picks the model",
    "| token 校验挪到 middleware | normal |",
    "| token 校验挪到 middleware |  |",
    "difficulty",
  ],
  // The rejected value is echoed back, or the writer cannot see which row it meant.
  ["an unknown difficulty", "| trivial |", "| easy |", "easy"],
  ["a slice with no acceptance method", "| normal | mw.test.ts 绿 |", "| normal |  |", "how it is accepted"],
  ["the wrong acceptance-criteria count", "\n- 单请求只查 DB 一次（加断言）", "", "2-3 executable criteria"],
  [
    "an empty objection — the Architect must object or say there is none",
    "## objection\n无",
    "## objection",
    "objection is empty",
  ],
  [
    "two slices accepted by the same thing",
    "| legacy header 兼容 | trivial | 老 client 的 e2e 用例绿 |",
    "| legacy header 兼容 | trivial | mw.test.ts 绿 |",
    "one deliverable",
  ],
  [
    "nested acceptance criteria, where one slice finishes the other",
    "| 补 middleware 单测 | normal | 覆盖 401/403 两条路径 |",
    "| 再加一点 | normal | mw.test.ts 绿并且覆盖 401 |",
    "nested acceptance",
  ],
];

test.each(rejections)("%s is rejected, and the error names what to fix", (_name, from, to, reason) => {
  const r = validateDraftCard(good.replace(from, to));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain(reason);
});

test("more than five slices is rejected", () => {
  // Exactly 12 content lines, so the length cap cannot be what rejects it.
  const six = `## goal
x

## non-goals
y

## accept
- a 绿
- b 通过

## slices
| slice | difficulty | accept |
| --- | --- | --- |
| s1 | trivial | a1 |
| s2 | trivial | a2 |
| s3 | trivial | a3 |
| s4 | trivial | a4 |
| s5 | trivial | a5 |
| s6 | trivial | a6 |

## risk
无

## objection
无`;
  const r = validateDraftCard(six);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("1-5");
});

test("heading depth and a trailing colon do not change the card", () => {
  // Markdown readers treat `#`/`###` the same way a human does, and an agent
  // that types `## goal:` out of habit wrote a valid card.
  const loose = good.replace(/^## /gm, "### ").replace("### goal", "# goal:");
  expect(validateDraftCard(loose)).toEqual(validateDraftCard(good));
});

test("a tests-only slice is refused — tests belong with their change", () => {
  // The exact shape a real run produced: 加参数 / 实现分支 / 补充测试用例.
  for (const title of ["补充测试用例", "添加单元测试", "add tests", "测试"]) {
    const card = good.replace(
      "| 补 middleware 单测 | normal | 覆盖 401/403 两条路径 |",
      `| ${title} | trivial | 覆盖两条路径 |`,
    );
    const r = validateDraftCard(card);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Tests belong with");
  }
});

test("a slice that adds a test suite for something specific is still allowed", () => {
  // The guard is narrow on purpose: only bare "tests" is refused, because a named
  // test target can genuinely be its own deliverable.
  const card = good.replace("| 补 middleware 单测 | normal |", "| legacy client 回归测试套件 | normal |");
  expect(validateDraftCard(card).ok).toBe(true);
});

test("a one-slice card is accepted — padding to a floor invents scope", () => {
  // Measured: with a floor of three, the Dispatcher filed "切片 2、3 是为满足最少
  // 切片数补的相邻能力" as a risk on its own card, and one of those padded slices
  // would have changed what existing callers get. A small ask is one slice.
  const one = `## goal
greet 支持 zh

## non-goals
不引入 i18n 库

## accept
- greet("x","zh") === "你好 x"
- greet("x") 不变

## slices
| slice | difficulty | accept |
| --- | --- | --- |
| 加可选 lang 参数并支持 zh | trivial | 上两条验收通过 |

## risk
无

## objection
无`;
  expect(validateDraftCard(one).ok).toBe(true);
});

test("a lone slice is never blamed for a bad split", () => {
  const one = `## goal
x

## non-goals
y

## accept
- a 绿
- b 绿

## slices
| slice | difficulty | accept |
| --- | --- | --- |
| 测试 | trivial | 全绿 |

## risk
无

## objection
无`;
  // The tests-only rule needs a sibling to fold into; alone, it is the whole job.
  expect(validateDraftCard(one).ok).toBe(true);
});

test("two slices may both require the suite to pass", () => {
  // A false positive here blocks a correct card, and "the tests pass" is true of
  // every slice — so it is never evidence that two slices overlap.
  const card = `## goal
x

## non-goals
y

## accept
- bun test 全绿
- 无回归

## slices
| slice | difficulty | accept |
| --- | --- | --- |
| zh 支持 | normal | bun test 全绿 |
| locale 自动探测 | normal | bun test 全绿且能从 env 读出 zh |
| 文档 | trivial | README 写明用法 |

## risk
无

## objection
无`;
  expect(validateDraftCard(card).ok).toBe(true);
});

test("a genuinely nested criterion is still caught", () => {
  const card = `## goal
x

## non-goals
y

## accept
- a
- b

## slices
| slice | difficulty | accept |
| --- | --- | --- |
| 加 lang 参数 | normal | greet("x","zh") 返回你好 x |
| 顺便再做点 | normal | greet("x","zh") 返回你好 x 并且 greet("x") 不变 |
| 文档 | trivial | README 写明用法 |

## risk
无

## objection
无`;
  const r = validateDraftCard(card);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("nested acceptance");
});

test("a soft-wrapped paragraph is still two lines to the reader", () => {
  // Otherwise the cap is escapable by not pressing enter: Markdown folds a wrapped
  // paragraph into one node, and a reader still has to read every line of it.
  const wrapped = good.replace(
    "## risk\n- 老 client 带 legacy header，加了兼容分支",
    "## risk\n- 老 client 带 legacy header\n  加了兼容分支",
  );
  const r = validateDraftCard(wrapped);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.lines).toBe(10);
});

test("an acceptance line listing several things asks for several verdicts", () => {
  // Only `；;` and newlines, never the comma: Chinese prose uses `，` as ordinary
  // punctuation, so counting those would demand five verdicts for one criterion
  // and teach the writer to pad.
  expect(criteriaIn("bun test 绿")).toBe(1);
  expect(criteriaIn("浏览器点附件进项目目录，多选两文件一目录")).toBe(1);
  expect(criteriaIn("bun test 绿；worktree git status 有改动")).toBe(2);
  expect({
    "one verdict for two criteria": validateSelfReview("pass: bun test 绿 — 见 a.test.ts:12", 2).ok,
    "two verdicts for two criteria": validateSelfReview("pass: 一 — x\npass: 二 — y", 2).ok,
  }).toEqual({ "one verdict for two criteria": false, "two verdicts for two criteria": true });
});

/**
 * Cards live in `note.body` and are re-validated when the boss approves, so one
 * filed before the keys became ASCII must still parse — otherwise the boss meets
 * `missing sections` on a card that is plainly complete and cannot approve it.
 * Retire with `draftLegacy` in 0.2.0.
 */
test("a card whose headings are the old Chinese keys still parses", () => {
  const zh = good
    .replace("## goal", "## 目标")
    .replace("## non-goals", "## 不做")
    .replace("## accept", "## 验收")
    .replace("## slices", "## 切片")
    .replace("## risk", "## 风险")
    .replace("## objection", "## 反对");
  const r = validateDraftCard(zh);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.goal).toBe("token 校验挪到 middleware");
});

/**
 * Markdown headings are conventionally capitalised, and Chinese had no case to
 * fold — so the exact match that was safe for `目标` is a coin flip for `goal`.
 * A model writing `## Goal` is not making a mistake worth a rejected card.
 */
test("headings are matched without regard to case", () => {
  const caps = good
    .replace("## goal", "## Goal")
    .replace("## non-goals", "## Non-Goals")
    .replace("## accept", "## ACCEPT");
  expect(validateDraftCard(caps).ok).toBe(true);
});
