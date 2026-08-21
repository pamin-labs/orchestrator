import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "../support/render.tsx";
import { i18n, startLocale } from "../../web/src/i18n.ts";
import { Timeline } from "../../web/src/features/timeline/view.tsx";
import { emptyState } from "../../web/src/shared/api.ts";
import { translations } from "../../scripts/lingui-catalogs.ts";
import * as OpenCC from "opencc-js/core";
import * as Locale from "opencc-js/preset";
import { MAINLAND, OVERCONVERTED, preset } from "../../scripts/i18n-hant.ts";

/**
 * `zh-Hant` is Traditional, and stays Traditional.
 *
 * `catalogs-render` already proves every catalog reaches the screen, and it
 * covers this one for free — but it would go on passing if `zh-Hant.po` were a
 * byte-for-byte copy of `zh.po`, which is exactly the failure this locale can
 * have and no other one can. The catalog is machine-generated, so "it exists and
 * it renders" is not the claim anybody cares about.
 */

/**
 * Every Simplified character `zh.po` contains — derived, not recalled.
 *
 * Read off the Simplified catalog and filtered to the characters that have a
 * *different* Traditional form, so this is a property of the writing system
 * rather than a list of words. Frequency-ordered: `个` alone occurs 187 times in
 * `zh.po`, so a single reverted sentence is overwhelmingly likely to trip on the
 * front of this string.
 */
/**
 * Three characters a naive derivation includes are deliberately out — `准`, `里`
 * and `游` are ordinary Traditional characters as well as Simplified ones
 * (批准, 里 as a unit of distance, 游 as in swimming), and banning them would
 * fail a correct translation.
 *
 * A hand-written literal rather than a call into `opencc-js`: computing the
 * answer with the library that produced the file is not a check on the file.
 */
const SIMPLIFIED =
  "个这没会时开还着组读过后条数动录写发进来库连项仓问话装码务复机认据记设轮么账远检号给计门划选启挂对径页台调说边间并级单闸长题凭为从图线关点报换队丢两浏览别们删钟几试内断镜续阅测无让于缓环网语败东输赖暂经钥预则变统询办满占贴实决审现档规标随带缀废归处额编译评论层树约拟构难继旧见错显节够刚签订优应验闲补儿许权访弹尽张确头当坏贵离谁达状运况请压销络产频词与雇顺须干误钱响舰栏烧静转墙拦链滤画仅载结钮阶价绝独积帧态宽滚训键岗备视种样该吗证观挡术攒择领弃鉴脱筛挤适车盖买浅际纳职绿红织议顶释拥叠扫将资盘风险费驱类紧冲驻储触净义笔夹历敛邻块纯伤强唤终云佣区";

/** A class rather than a scan over code points: these are all BMP characters, so
 *  the regex engine is both the shorter way to ask and the correct one. */
const SIMPLIFIED_RE = new RegExp(`[${SIMPLIFIED}]`, "g");

const simplifiedIn = (text: string): string[] => text.match(SIMPLIFIED_RE) ?? [];

afterEach(() => {
  cleanup();
  localStorage.clear();
  i18n.activate("zh");
});

/** The pane the sibling catalog test renders, for the same reason: it is the one
 *  that draws without a fixture. */
const timeline = () => <Timeline st={emptyState()} frames={[]} grpId={null} projectId={null} />;

async function textUnder(locale: string): Promise<string> {
  localStorage.setItem("orch.locale", locale);
  await startLocale();
  expect(i18n.locale).toBe(locale);
  const { container } = render(timeline());
  return container.textContent ?? "";
}

/**
 * Both halves in one test on purpose. The Simplified assertion is what proves
 * the Traditional one can fail: without it, a pane whose every string happened
 * to be script-neutral — `事件流` is the same in both — would pass this file
 * while rendering nothing that distinguishes the two catalogs at all.
 */
test("the Traditional pane renders no Simplified character, on a pane where the Simplified one does", async () => {
  const hant = await textUnder("zh-Hant");
  expect(simplifiedIn(hant)).toEqual([]);

  cleanup();
  const hans = await textUnder("zh");
  expect(simplifiedIn(hans).length).toBeGreaterThan(0);
});

/**
 * The pane above is one screen. This is the other 800 strings, and it is the
 * assertion that goes red when somebody hand-edits `zh-Hant.po` or pastes a
 * Simplified string into it — which is the only way this catalog can regress,
 * since nobody translates it by hand.
 */
test("no message in the Traditional catalog is Simplified", async () => {
  const { messages } = await translations("zh-Hant");
  const offenders = Object.entries(messages)
    .filter(([, text]) => typeof text === "string" && simplifiedIn(text).length > 0)
    .map(([id, text]) => `${id}: ${String(text).slice(0, 40)}`);
  expect(offenders).toEqual([]);
  // Not vacuous: the same walk over the Simplified catalog finds plenty.
  expect(Object.keys(messages).length).toBeGreaterThan(700);
});

/**
 * The places OpenCC's own phrase dictionary is wrong, asserted against the
 * shipped file and driven by the rules themselves.
 *
 * These are the corrections a person wrote in `scripts/i18n-hant.ts`, and they
 * are the part of this catalogue a dependency upgrade can silently undo — `映象`
 * and `閘道器` are long-standing OpenCC output, so a future `opencc-js` that
 * "fixes" something nearby can put them back while every other check here stays
 * green.
 */
/**
 * The wrong form is computed, not written down: it is what `s2twp` produces for
 * that word **without** this project's two dictionaries. So the judgement comes
 * from the rule rather than from a count taken on some particular day — the
 * previous version asserted `映像: 15, 閘道: 3, 行程: 4 …` and went red twice for
 * new copy, both times with nothing wrong.
 */
test("every correction to OpenCC survives into the shipped catalogue", async () => {
  const zh = await Bun.file("locales/zh.po").text();
  const hant = await Bun.file("locales/zh-Hant.po").text();
  const naive = OpenCC.ConverterFactory(preset(Locale.from, "cn"), preset(Locale.to, "twp"));

  const wrong: string[] = [];
  const missing: string[] = [];
  for (const [simplified, ours] of MAINLAND) {
    const machine = naive(simplified);
    if (machine !== ours && hant.includes(machine)) wrong.push(`${simplified}: ${machine} is still in the catalogue`);
    // Only for a rule the Simplified catalogue still triggers: copy that drops
    // the last use of a word is not this test's business.
    if (zh.includes(simplified) && !hant.includes(ours)) missing.push(`${simplified}: no ${ours} in the catalogue`);
  }
  // `OVERCONVERTED` is written the other way round — it repairs the machine's
  // output, so its left-hand side *is* the wrong form.
  for (const [machine, ours] of OVERCONVERTED) {
    if (hant.includes(machine)) wrong.push(`${machine}: repaired to ${ours}, and still in the catalogue`);
  }
  expect({ wrong, missing }).toEqual({ wrong: [], missing: [] });

  // Not vacuous: some rule has to actually disagree with the machine, or the
  // loop above is comparing every word with itself.
  expect(MAINLAND.filter(([simplified, ours]) => naive(simplified) !== ours).length).toBeGreaterThan(0);
});
