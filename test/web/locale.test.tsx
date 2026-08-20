import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "../support/render.tsx";
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
  expect(["English", "en", "日本語"].map((l) => resolve("follow", l))).toEqual(["en", "en", "en"]);
});

/**
 * The first paint happens before `/state` answers, so "" is not a language: it
 * means the server has not said yet. Reading it as one would show every English
 * boss a frame of Chinese on every load rather than only on their first.
 */
test("an unanswered server keeps the language the last load resolved to", () => {
  expect(resolve("follow", "")).toBe("zh");
  applyLocale("English");
  expect(resolve("follow", "")).toBe("en");
});

test("changing the preference re-resolves without waiting for the next poll", () => {
  applyLocale("English");
  expect(i18n.locale).toBe("en");
  setPreference("zh");
  expect(i18n.locale).toBe("zh");
  setPreference("follow");
  expect([i18n.locale, preference()]).toEqual(["en", "follow"]);
});

/** The control is the only place the three states are visible at once, which is
 *  why it is segments rather than the cycling icon the theme control started as. */
test("the switch offers follow beside the two languages, and stores what is picked", () => {
  const { getByRole } = render(<LocaleChoice />);
  expect(
    ["跟随服务器", "中文", "English"].map((name) => getByRole("radio", { name }).getAttribute("data-state")),
  ).toEqual(["on", "off", "off"]);
  fireEvent.click(getByRole("radio", { name: "English" }));
  expect(preference()).toBe("en");
  expect(i18n.locale).toBe("en");
});
