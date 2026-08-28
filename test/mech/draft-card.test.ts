import { expect, test } from "bun:test";
import { citedPaths, criteriaIn, validateDraftCard, validateSelfReview } from "../../src/mech/util/validate.ts";

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
/**
 * The pre-Markdown shape ADR 016 replaced, kept as the witness for how it fails.
 * Nothing parses it any more; a card filed in this form is refused by name.
 */
const legacy = `goal : token 校验挪到 middleware
non-goals : 不动 legacy client 的鉴权协议
accept : bun test 全绿
accept : 单请求只查 DB 一次（加断言）
slices : token 校验挪到 middleware [normal] — mw.test.ts 绿
slices : legacy header 兼容 [trivial] — 老 client 的 e2e 用例绿
slices : 补 middleware 单测 [normal] — 覆盖 401/403 两条路径
risk : 老 client 带 legacy header，加了兼容分支
objection : 无`;

/**
 * The same card with the headings an agent typed on a CJK keyboard: fullwidth
 * colon after each one. NFKC folds it, so the file keeps no list of which
 * punctuation it has met — it used to match `[:：]` and nothing else.
 */
const fullwidth = good.replace(/^## (\w[\w-]*)$/gm, "## $1：");

test("a heading typed with a fullwidth colon names the same field", () => {
  expect(validateDraftCard(fullwidth).ok).toBe(true);
});

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

test("a slice that adds a test suite for something specific is allowed", () => {
  // Kept from the tests-only check ADR 046 removed: it passes trivially now and
  // still records that a named test target can be its own deliverable. There is
  // deliberately no test asserting that a bare "add tests" slice is *accepted* —
  // that would pin the gap as a feature rather than record it as one.
  const card = good.replace("| 补 middleware 单测 | normal |", "| legacy client 回归测试套件 | normal |");
  expect(validateDraftCard(card).ok).toBe(true);
});

test("a one-slice card is accepted — padding to a floor invents scope", () => {
  // Measured: with a floor of three, the Dispatcher filed "`Slice` 2、3 是为满足最少
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

// It cannot overlap with anything, which is now the whole of `checkSplit`.
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
 * The two shapes that used to parse, and *how* they now fail.
 *
 * Both were compatibility aliases, which `docs/project/plan.md` puts out of scope
 * before the first stable release. A card in either shape has to be refused by a
 * sentence naming the headings to write: the Dispatcher rewrites from the
 * rejection, so one it cannot act on is the same defect as a card that silently
 * reads empty.
 */
test("the two retired card shapes are refused by name", () => {
  const zh = good
    .replace("## goal", "## 目标")
    .replace("## non-goals", "## 不做")
    .replace("## accept", "## 验收")
    .replace("## slices", "## 切片")
    .replace("## risk", "## 风险")
    .replace("## objection", "## 反对");
  const headings = validateDraftCard(zh);
  expect(headings.ok).toBe(false);
  if (!headings.ok) expect(headings.error).toContain("missing sections");

  // No headings at all: the pre-Markdown card, which `draftMarkdown` returns
  // null for. It used to fall through to a second parser; now it is named.
  const inline = validateDraftCard(legacy);
  expect(inline.ok).toBe(false);
  if (!inline.ok) {
    expect(inline.error).toContain("no headings");
    expect(inline.error).toContain("## goal");
  }
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

/**
 * A card's verdict does not depend on which language it is written in.
 *
 * `GENERIC_GATE` was a pattern of English and Chinese words used to *suppress* a
 * hard rejection, so its miss cost a correct card refused rather than a missed
 * catch. Measured before ADR 046: a slice restating a card criterion was refused
 * as nested acceptance in German, French, Spanish, Portuguese and Russian, and
 * accepted in Korean and Japanese only because the normalised text fell under
 * the eight-character floor.
 */
const shipped = (accept: string, nested: string) => `## goal
ship it

## non-goals
nothing

## accept
- ${accept}
- the panel renders

## slices
| slice | difficulty | accept |
| --- | --- | --- |
| one | normal | ${accept} |
| two | normal | ${nested} |

## risk
- none

## objection
none`;

/** One row per shipped locale: the criterion, and the same criterion with a
 *  clause added so the pair is nested by construction. */
const SAYS_THE_SUITE_PASSES: [string, string, string][] = [
  ["en", "bun test passes", "bun test passes and it reads zh from env"],
  ["zh", "bun test 全绿", "bun test 全绿，并且从 env 读 zh"],
  ["de", "die Testsuite ist grün", "die Testsuite ist grün und liest zh aus env"],
  ["fr", "la suite de tests passe", "la suite de tests passe et lit zh depuis env"],
  ["es", "la suite de pruebas pasa", "la suite de pruebas pasa y lee zh de env"],
  ["pt", "a suite de testes passa", "a suite de testes passa e lê zh do env"],
  ["ru", "набор тестов проходит", "набор тестов проходит и читает zh из env"],
];

test.each(SAYS_THE_SUITE_PASSES)(
  "a %s slice restating a card criterion is not a nested acceptance",
  (_locale, accept, nested) => {
    expect(validateDraftCard(shipped(accept, nested)).ok).toBe(true);
  },
);

test.each(SAYS_THE_SUITE_PASSES)("a %s slice nested inside another is still caught", (_locale, accept, nested) => {
  // Same pair, with the card's own criteria naming something else — so the
  // suppressor has nothing to suppress and the rejection stands.
  const card = shipped(accept, nested).replace(
    `- ${accept}\n- the panel renders`,
    "- something else entirely\n- and this",
  );
  const r = validateDraftCard(card);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("nested acceptance criteria");
});

/**
 * The one length heuristic left, and its direction is the safe one.
 *
 * `short.length < 8` counts characters, and a dense script says more per
 * character — `테스트 통과` normalises to five. So Korean and Japanese pairs below
 * the floor are not examined. That is *lenient*: it declines to reject, which is
 * the direction a hard refusal should fail in, and it is why the two rows above
 * do not include them.
 */
test("the eight-character floor is lenient for dense scripts, and stays that way", () => {
  expect(validateDraftCard(shipped("테스트 통과", "테스트 통과하고 env 에서 zh 를 읽음")).ok).toBe(true);
  expect(validateDraftCard(shipped("テスト通過", "テスト通過し env から zh を読む")).ok).toBe(true);
});

/**
 * What a reviewer's note actually offers a machine.
 *
 * The prose is in whichever of ten languages the reviewer writes; the names it
 * drops are the one part that is checkable. This is measurement, not a gate — so
 * the cut is deliberately lenient on what counts as a name and strict about the
 * three things that look like one and are not.
 */
test("a note's citations are the names in it, not its version numbers", () => {
  expect(citedPaths("pass: 401 on expired token — mw.ts:31 returns before the handler")).toEqual(["mw.ts"]);
  expect(citedPaths("pass: 见 src/mech/gate.ts 与 test/a.test.ts；fail: 无")).toEqual([
    "src/mech/gate.ts",
    "test/a.test.ts",
  ]);
  // The browser lease writes these, and they are the evidence for a criterion no
  // gate can answer.
  expect(citedPaths("pass: the menu opens — menu.png")).toEqual(["menu.png"]);
  // Not names: a version, an abbreviation, a domain, a bare sentence.
  expect(citedPaths("orch 0.1.2 passes, e.g. see github.com — bun test 绿")).toEqual([]);
  // Cited twice is cited once.
  expect(citedPaths("pass: a.ts:1 — and a.ts:9")).toEqual(["a.ts"]);
});
