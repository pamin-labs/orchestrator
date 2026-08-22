import { afterEach, expect, test } from "bun:test";
import { HttpResponse, http } from "msw";
import { mockHttp } from "../support/http.ts";
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

/**
 * The picker tells the server as well as this browser: `output.language`
 * defaults to following the panel, so the server has to be able to answer what
 * the reader is reading (ADR 043). Captured rather than merely allowed, because
 * the write is the behaviour.
 */
const written: unknown[] = [];
mockHttp(
  http.post("*/api/v1/settings", async ({ request }) => {
    written.push(await request.json());
    return HttpResponse.json({ ok: true });
  }),
);

afterEach(() => {
  written.length = 0;
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

/**
 * Which of the two Chinese catalogs a tag asks for is CLDR's `likelySubtags`,
 * read out of `Intl.Locale` rather than out of a column.
 *
 * The table it replaced held seven tags somebody had written down, in an order
 * that was load-bearing — `zh`'s `[中汉漢華华]` matched `繁體中文`, so Traditional
 * had to come first. These four are the ones no row covered: a script subtag
 * against a region that disagrees with it, and two macrolanguage codes.
 */
test("a tag nobody wrote a row for still lands on the right Chinese", () => {
  expect(["zh-Hans-MO", "zh-SG", "zh-CN"].map(localeOf)).toEqual(["zh", "zh", "zh"]);
  expect(["cmn-Hant", "yue-Hant", "yue", "zh-MO"].map(localeOf)).toEqual(["zh-Hant", "zh-Hant", "zh-Hant", "zh-Hant"]);
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
 * `<input>` — it carries a caret and invites typing, and these are ten fixed
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
  // And told to the server, which is what lets `output.language` follow it.
  await waitFor(() => expect(written).toEqual([{ path: "panelLanguage", value: "ja" }]));
  // Shown once the chunk is in. This is the trade the control makes: a tick that
  // waits for the catalog is a tick that never names a language the panel is not
  // actually reading in.
  await waitFor(() => expect(getByRole("button").textContent).toContain("日本語"));
});

/**
 * Storage that throws is a browser setting, not a broken panel.
 *
 * Chrome's "block all cookies", Firefox's `dom.storage.enabled=false` and a few
 * enterprise policies make the *getter* throw rather than return null. This went
 * through `@lingui/detect-locale` on the strength of a comment saying it owned
 * that; its `detectFromStorage` is a bare `globalThis.localStorage.getItem`, and
 * the call was evaluated outside `applyLocale`'s `try` besides. `startLocale()`
 * is awaited before `createRoot().render()`, so the whole panel was blank.
 */
test("a browser that refuses storage still gets a language", async () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
  const denied = () => {
    throw new Error("The operation is insecure.");
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get: () => ({ getItem: denied, setItem: denied, removeItem: denied, clear: denied }),
  });
  try {
    expect(preference()).toBe(localeOf(navigator.language));
    // And picking one still takes effect: this used to write, swallow the
    // refusal, then re-read the store — so the old value came back and choosing
    // a language did nothing at all.
    setPreference("ja");
    await waitFor(() => expect(i18n.locale).toBe("ja"));
  } finally {
    Object.defineProperty(globalThis, "localStorage", real);
  }
});
