import { expect, test } from "bun:test";
import { hant } from "../../scripts/i18n-hant.ts";

/**
 * The generator converts translations and nothing else.
 *
 * `zh-Hant.po` is derived from `zh.po`, so the only thing standing between a
 * correct catalogue and a corrupt one is which lines this function decides are
 * translation. Everything asserted here failed at least once while it was being
 * written.
 */
/**
 * A `msgstr` may continue over several `"…"` lines, and a `msgid` looks exactly
 * the same. The state has to survive the continuation and end at the first line
 * that is not a quoted string — converting a `msgid` retires the message.
 */
test("a msgstr converts, and the msgid beside it does not", () => {
  const po = ['msgid "Sandbox server"', 'msgstr "沙箱服务器"', "", 'msgid "网关"', 'msgstr "网关"'].join("\n");
  const out = hant(po).split("\n");
  expect(out[1]).toBe('msgstr "沙箱伺服器"');
  // The msgid is Simplified here on purpose: it is the key Lingui hashed, and a
  // converted one matches no message at all.
  expect(out[3]).toBe('msgid "网关"');
  expect(out[4]).toBe('msgstr "閘道"');
});

test("a msgstr continued over several lines converts past the first", () => {
  const po = ['msgstr ""', '"进程挂起了，"', '"仓库还在克隆"', "", 'msgid "进程"'].join("\n");
  const out = hant(po).split("\n");
  expect(out[1]).toBe('"行程擱置了，"');
  expect(out[2]).toBe('"儲存庫還在複製"');
  // The blank line ends the continuation, so what follows is a key again.
  expect(out[4]).toBe('msgid "进程"');
});

/**
 * The one header field that is about this file rather than about `zh.po`.
 * Missing it leaves a catalogue that declares itself Simplified, which the
 * runtime believes.
 */
test("the header's Language field names the generated locale", () => {
  expect(hant(['msgstr ""', '"Language: zh\\n"'].join("\n"))).toContain('"Language: zh-Hant\\n"');
});
