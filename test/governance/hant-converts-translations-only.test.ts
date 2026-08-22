import { expect, test } from "bun:test";
import { hant } from "../../scripts/i18n-hant.ts";

/**
 * The generator converts translations and nothing else.
 *
 * `zh-Hant.po` is derived from `zh.po`, so a converted key retires the message
 * it was supposed to translate. This used to guard a line-at-a-time state
 * machine — which `"…"` line is still a `msgstr` — and Lingui's own formatter
 * owns that now. What is left to guard is the choice this file still makes:
 * which field of a parsed message the converter is pointed at.
 */
const po = (body: string) => `msgid ""\nmsgstr ""\n"Language: zh\\n"\n\n${body}\n`;

test("a translation converts, and the key beside it does not", async () => {
  // Simplified on purpose: `网关` is the msgid Lingui hashed, and converting it
  // matches no message at all.
  const out = await hant(po('msgid "网关"\nmsgstr "网关"'));
  expect(out).toContain('msgid "网关"');
  expect(out).toContain('msgstr "閘道"');
});

test("a translation that runs over several lines converts past the first", async () => {
  // The formatter folds and unfolds this, but the converter still has to see one
  // string rather than the lines it was written across.
  const out = await hant(po('msgid "held"\nmsgstr "进程挂起了，\\n"\n"仓库还在克隆"'));
  expect(out).toContain("行程擱置了，");
  expect(out).toContain("儲存庫還在複製");
  expect(out).not.toContain("进程");
});

/**
 * The one header field that is about this file rather than about `zh.po`.
 * Missing it leaves a catalogue that declares itself Simplified, which the
 * runtime believes.
 */
test("the header names the generated locale, from the catalogue being replaced", async () => {
  const existing = 'msgid ""\nmsgstr ""\n"Language: zh-Hant\\n"\n';
  expect(await hant(po('msgid "x"\nmsgstr "网关"'), existing)).toContain('"Language: zh-Hant\\n"');
  // And the shipped one says so, which is the assertion that covers the path
  // `import.meta.main` takes.
  expect(await Bun.file("locales/zh-Hant.po").text()).toContain('"Language: zh-Hant\\n"');
});

/**
 * The one rule in `MAINLAND` that is right about a sense rather than a word.
 *
 * `周` → `週` is the week. In `周圍`, `周到` and their friends the character
 * stays, and OpenCC leaves them alone — this project's own rule is what breaks
 * them. The table said "both of this catalog's 周 are the time sense", counted
 * by hand once and never again: `zh.po` holds none at all today, so the next
 * `周围` would ship as `週圍` with every check green, the generator being
 * deterministic and the diff clean.
 */
const NOT_A_WEEK = ["周围", "周边", "周到", "周全", "四周", "周密", "周折", "周旋", "周年"];

test("nothing in the Simplified catalogue asks 周 to stay 周", async () => {
  const zh = await Bun.file("locales/zh.po").text();
  expect(NOT_A_WEEK.filter((word) => zh.includes(word))).toEqual([]);
});

test("and the rule still converts the week it is there for", async () => {
  expect(await hant(po('msgid "x"\nmsgstr "每周一次"'))).toContain("每週一次");
});
