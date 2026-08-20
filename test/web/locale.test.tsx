import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, valueOf } from "../support/render.tsx";
import { LocaleChoice } from "../../web/src/features/settings/locale-choice.tsx";
import { i18n, preference, setPreference } from "../../web/src/i18n.ts";
import { endonymOf, localeOf } from "../../src/contracts/config.ts";

/**
 * Which language the panel reads in — this browser's choice and nothing else.
 *
 * It followed `output.language` at first, and that conflated two things: the
 * knob tells the agents what to write and sits in the cache prefix, so changing
 * it rotates every session in the fleet. Reading a pane in another language is
 * not that and must not cost that.
 */

afterEach(() => {
  cleanup();
  localStorage.clear();
  i18n.activate("zh");
});

test("a free-text language maps to the catalog that can serve it", () => {
  // The knob suggests two dozen spellings and accepts anything, so these are
  // what a person actually types, not an enum.
  expect(["中文", "zh-CN", "简体中文"].map(localeOf)).toEqual(["zh", "zh", "zh"]);
  expect(["日本語", "ja_JP", "Japanese"].map(localeOf)).toEqual(["ja", "ja", "ja"]);
  // A language with no catalog reads in the source language rather than in
  // nothing, and a code that merely starts with one is not that language.
  expect(["Українська", "ไทย", "Estonian", "English"].map(localeOf)).toEqual(["en", "en", "en", "en"]);
});

/** Nothing stored means the browser's own language, which is the answer every
 *  other page this person opens already uses. */
test("an unset preference is the browser's language", () => {
  expect(preference()).toBe(localeOf(navigator.language));
  setPreference("ja");
  expect(preference()).toBe("ja");
});

/** Every language names itself: a menu that says "Chinese" is no help to
 *  somebody who cannot read the pane it is on. */
test("the picker names each language in that language, and stores what is picked", async () => {
  const { getByRole, findByText } = render(<LocaleChoice />);
  const box = getByRole("combobox");
  // Whatever the browser says, since nothing is stored yet.
  expect(valueOf(box)).toBe(endonymOf(localeOf(navigator.language)));

  fireEvent.click(box);
  fireEvent.change(box, { target: { value: "日本" } });
  fireEvent.click(await findByText("日本語"));

  expect(preference()).toBe("ja");
});
