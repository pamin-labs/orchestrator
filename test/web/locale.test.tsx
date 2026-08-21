import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "../support/render.tsx";
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

/**
 * Every language names itself: "Chinese" is no help to somebody who cannot read
 * the pane it is on. A menu rather than a combobox, because a combobox is an
 * `<input>` — it carries a caret and invites typing, and these are nine fixed
 * values none of which the reader is meant to invent.
 */
test("the picker names each language in that language, and stores what is picked", async () => {
  const { getByRole, findByRole } = render(<LocaleChoice />);
  // What is *live*, not what `localStorage` asked for: the suite activates `zh`,
  // and until a catalog is actually active the two are allowed to disagree.
  expect(getByRole("button").textContent).toContain(endonymOf("zh"));

  // Radix opens on pointerdown, not click — the same way telemetry-render drives its menu.
  fireEvent.pointerDown(getByRole("button"), { button: 0, ctrlKey: false });
  fireEvent.click(await findByRole("menuitem", { name: "日本語" }));

  // Stored at once, so a reload lands on it either way.
  expect(preference()).toBe("ja");
  // Shown once the chunk is in. This is the trade the control makes: a tick that
  // waits for the catalog is a tick that never names a language the panel is not
  // actually reading in.
  await waitFor(() => expect(getByRole("button").textContent).toContain("日本語"));
});
