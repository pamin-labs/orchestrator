import * as OpenCC from "opencc-js/core";
import * as Locale from "opencc-js/preset";

/**
 * `zh-Hant.po`, generated from `zh.po`.
 *
 * Traditional Chinese is not a font of Simplified: 軟體/软件, 快取/缓存,
 * 程式碼/代码 are different words, not different glyphs for the same one. So
 * this runs OpenCC's `s2twp` — Simplified → Traditional (Taiwan) *with phrase
 * conversion* — which owns the ~42 word substitutions this catalog needs and
 * every one of the thousands of character mappings underneath them.
 */
/**
 * Generated rather than translated by hand, and checked in rather than built.
 *
 * 677 of the 823 lines of `msgstr` change. Doing that by hand is not 809
 * decisions, it is 809 chances to typo a character nobody proofreading English
 * source will catch. What is left for a person is the 22 rules below — the
 * places where the machine is wrong or silent — and those are the whole point
 * of this file.
 */
/**
 * Checked in because `build:web`, every `bun test` worker and `preflight` all
 * load catalogs, and `opencc-js`'s dictionary is 1.1MB — twenty times the
 * catalog it would be generating. `--check` keeps it honest.
 */

/**
 * Words `s2twp` gets wrong or leaves in Mainland form, fixed on the Simplified
 * side before conversion.
 *
 * The first block is OpenCC's own misfires, and they are famous ones: `镜像` →
 * 映**象** and `网关` → 閘道**器** are long-standing TWPhrases bugs, `全局的` →
 * 全域**性**的 mangles a word that was already right, and `进程` → `程序` is
 * actively wrong in Taiwan, where 程序 means *program*. The second is vocabulary
 * the phrase dictionary does not carry — git and containers, mostly.
 */
/**
 * Counted against `zh.po` before being written down, so every rule here earns
 * its place: `库` looked like it needed 函式庫 until the scan showed all 26 of
 * its hits are inside `仓库` and `数据库`, and a rule for it would have been a
 * dead one. `配置` is deliberately absent — mapping it to 設定 would collide
 * with `设置` and throw away a distinction the Chinese draws.
 */
const MAINLAND: readonly (readonly [string, string])[] = [
  // OpenCC s2twp converts these, and converts them wrong.
  ["镜像", "映像"], // s2twp: 映象 — the 像→象 over-conversion
  ["网关", "閘道"], // s2twp: 閘道器 — the spurious 器 suffix
  ["全局", "全域"], // s2twp: 全域性 — "槽位是全局的" became "全域性的"
  ["进程", "行程"], // s2twp: 程序, which is Taiwanese for *program*
  ["发布", "發布"], // s2twp: 釋出; 發布 is what Taiwan's own style guides use
  // OpenCC s2twp leaves these in Mainland form.
  ["仓库", "儲存庫"], // git repository, as GitHub's own zh-TW UI names it
  ["凭据", "憑證"],
  ["并发", "並行"], // 併發 in Taiwan is a medical word: 併發症
  ["本地", "本機"],
  ["挂起", "擱置"], // not 暫停 — `暂停` is already its own string in this catalog
  ["会话", "工作階段"],
  ["克隆", "複製"], // git clone
  ["构建", "建置"],
  ["令牌", "權杖"],
  ["超时", "逾時"],
  ["回滚", "復原"],
  ["重写", "覆寫"],
  ["评审", "審查"],
  ["语义", "語意"],
  ["云机器", "雲端機器"],
];

/**
 * Repairs applied to `s2twp`'s output, for phrases it over-converts.
 *
 * This has to run *after* conversion rather than beside `MAINLAND`: mapping
 * `前缀` → `前綴` on the Simplified side does not help, because the phrase
 * dictionary then matches `前綴` and rewrites it to `字首` anyway. Measured, not
 * assumed. `字首` is a word about the first character of a word; what this
 * catalog means is the prompt prefix and the cache prefix.
 */
const OVERCONVERTED: readonly (readonly [string, string])[] = [["字首", "前綴"]];

/**
 * The documented low-level entry point — `ConverterFactory` over
 * `opencc-js/core` plus `opencc-js/preset`, which is what the package's own
 * "Bundle optimization" section prescribes over `Converter({from, to})`. It is
 * also the only form that takes extra dictionaries, and the order of the
 * arguments *is* the conversion chain.
 */
/** The presets are `Record<string, …>`, so a typo in a locale name is a missing
 *  dictionary and a converter that quietly returns its input. Said out loud. */
function preset(dicts: Record<string, readonly OpenCC.DictGroup[]>, name: string): readonly OpenCC.DictGroup[] {
  const found = dicts[name];
  if (!found) throw new Error(`opencc-js: no '${name}' dictionary in this preset`);
  return found;
}

const convert = OpenCC.ConverterFactory([MAINLAND], preset(Locale.from, "cn"), preset(Locale.to, "twp"), [
  OVERCONVERTED,
]);

/**
 * Only `msgstr` is converted, and `msgid` is copied through untouched.
 *
 * The ids are the English source and the keys the compiled catalog is looked up
 * by — converting one would retire the message rather than translate it. A
 * `msgstr` runs across continuation lines, so this tracks which block it is in
 * rather than matching a line at a time.
 */
/**
 * Line-based on purpose. Lingui owns reading `.po` and this file does not
 * reimplement that — it rewrites a subset of the lines and leaves the rest
 * byte-for-byte, which is what makes the diff between the two catalogs readable
 * as a translation rather than as a reformat.
 */
function hant(po: string): string {
  let inside = false;
  return po
    .split("\n")
    .map((line) => {
      if (line.startsWith("msgstr")) inside = true;
      else if (!line.startsWith('"')) inside = false;
      // The header is a `msgstr` too, and its `Language:` is the one field in it
      // that is about this file rather than about `zh.po`.
      if (line === '"Language: zh\\n"') return '"Language: zh-Hant\\n"';
      return inside ? convert(line) : line;
    })
    .join("\n");
}

const SOURCE = "web/src/locales/zh.po";
const TARGET = "web/src/locales/zh-Hant.po";

const next = hant(await Bun.file(SOURCE).text());
const current = await Bun.file(TARGET)
  .text()
  .catch(() => "");

if (process.argv.includes("--check")) {
  if (next === current) {
    console.log(`${TARGET}: up to date`);
    process.exit(0);
  }
  console.error(`${TARGET} does not match ${SOURCE} — run \`bun run i18n:hant\``);
  process.exit(1);
}

if (next === current) {
  console.log(`${TARGET}: unchanged`);
} else {
  await Bun.write(TARGET, next);
  console.log(`${TARGET}: written`);
}
