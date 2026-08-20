import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, valueOf } from "../support/render.tsx";
import { LocaleChoice } from "../../web/src/features/settings/locale-choice.tsx";
import { applyLocale, i18n, preference, resolve, setPreference } from "../../web/src/i18n.ts";

/**
 * Which language the panel speaks, from two inputs that disagree often: a
 * per-browser preference and `output.language`, which travels with the project.
 *
 * The panel used to have neither — every string was Chinese — and PR #9's first
 * answer was a second switch with its own storage, which meant a boss who set
 * 对外语言 to English still read a Chinese pane and had nowhere obvious to look.
 */

afterEach(() => {
  cleanup();
  localStorage.clear();
  setPreference("follow");
  i18n.activate("zh");
});

test("an explicit preference wins over whatever the fleet speaks", () => {
  expect(resolve("en", "中文")).toBe("en");
  expect(resolve("zh", "English")).toBe("zh");
});

test("follow reads the free-text language the way the server does", () => {
  // The knob suggests two dozen and accepts anything, so these are the spellings
  // a person actually types, not an enum.
  expect(["中文", "zh-CN", "简体中文"].map((l) => resolve("follow", l))).toEqual(["zh", "zh", "zh"]);
  expect(["日本語", "ja_JP", "Japanese"].map((l) => resolve("follow", l))).toEqual(["ja", "ja", "ja"]);
  // A language with no catalog reads in the source language rather than in
  // nothing, and a code that merely starts with one is not that language.
  expect(["Українська", "ไทย", "Estonian", "English"].map((l) => resolve("follow", l))).toEqual([
    "en",
    "en",
    "en",
    "en",
  ]);
});

/**
 * The first paint happens before `/state` answers, so "" is not a language: it
 * means the server has not said yet. Reading it as one would show every English
 * boss a frame of Chinese on every load rather than only on their first.
 */
test("an unanswered server keeps the language the last load resolved to", async () => {
  expect(resolve("follow", "")).toBe("zh");
  await applyLocale("English");
  expect(resolve("follow", "")).toBe("en");
});

test("changing the preference re-resolves without waiting for the next poll", async () => {
  await applyLocale("English");
  expect(i18n.locale).toBe("en");
  // Awaited, because a catalog is a chunk now and activating one fetches it.
  await applyLocale("中文");
  expect(i18n.locale).toBe("zh");
  setPreference("en");
  await applyLocale("");
  expect([i18n.locale, preference()]).toEqual(["en", "en"]);
});

/** The control is the only place the three states are visible at once, which is
 *  why it is segments rather than the cycling icon the theme control started as. */
/** Every language names itself, so the list is readable to whoever needs it —
 *  "Chinese" is no help to somebody who cannot read the pane it is on, and the
 *  one entry that is a sentence rather than a name is the one that is
 *  translated. */
test("the switch names each language in that language, and stores what is picked", async () => {
  const { getByRole, findByText } = render(<LocaleChoice />);
  const box = getByRole("combobox");
  expect(valueOf(box)).toBe("跟随对外语言");

  fireEvent.click(box);
  fireEvent.change(box, { target: { value: "日本" } });
  fireEvent.click(await findByText("日本語"));

  expect(preference()).toBe("ja");
});
