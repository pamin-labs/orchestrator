import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "../support/render.tsx";
import { i18n, startLocale } from "../../web/src/i18n.ts";
import { Timeline } from "../../web/src/features/timeline/view.tsx";
import { emptyState } from "../../web/src/shared/api.ts";
import { translations } from "../../scripts/lingui-catalogs.ts";

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
 * The six places OpenCC's own phrase dictionary is wrong, asserted against the
 * shipped file.
 *
 * These are the rules a person wrote in `scripts/i18n-hant.ts`, and they are the
 * part of this catalog that a dependency upgrade can silently undo — `映象` and
 * `閘道器` are long-standing OpenCC output, so a future `opencc-js` that "fixes"
 * something nearby can put them back and every other check here stays green.
 */
/** Counts, not presence: `9` is how many times `镜像` appears in `zh.po`, so a
 *  rule that half-applies is caught too. */
test("the corrections to OpenCC survive into the shipped catalog", async () => {
  const po = await Bun.file("web/src/locales/zh-Hant.po").text();
  const times = (word: string): number => po.split(word).length - 1;
  expect({
    映像: times("映像"),
    映象: times("映象"),
    閘道: times("閘道") - times("閘道器"),
    閘道器: times("閘道器"),
    行程: times("行程"),
    程序: times("程序"),
    全域: times("全域") - times("全域性"),
    全域性: times("全域性"),
    前綴: times("前綴"),
    字首: times("字首"),
    發布: times("發布"),
    釋出: times("釋出"),
  }).toEqual({
    映像: 9,
    映象: 0,
    閘道: 3,
    閘道器: 0,
    行程: 2,
    程序: 0,
    全域: 2,
    全域性: 0,
    前綴: 5,
    字首: 0,
    發布: 1,
    釋出: 0,
  });
});
