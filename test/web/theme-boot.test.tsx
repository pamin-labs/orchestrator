import { afterEach, beforeEach, expect, test } from "bun:test";
import { startTheme } from "../../web/src/ui/theme.tsx";

/**
 * The page comes up in the right theme, and stays right without a reload.
 *
 * `ThemeChoice` — the control — is reached by the settings render tests. What
 * `startTheme` does is the half that runs when nobody opens settings, and each of
 * its jobs fails silently: an unread preference is a page in the wrong theme, and an
 * unheard OS change is a page that goes light at sunset and stays light until reload.
 */
/**
 * `data-theme` is always resolved to a concrete light or dark — "system" is the
 * stored preference, never the attribute — which is the property the stylesheet's
 * single dark block depends on.
 */
const theme = () => document.documentElement.dataset.theme;
/**
 * The markdown editor reads its own attribute rather than `data-theme`, and left
 * alone it follows `prefers-color-scheme` — the one answer that is wrong exactly
 * when the boss has overridden the theme. So it is written here, beside the other
 * one, and asserted here too: two attributes that must agree have one writer.
 */
const colorMode = () => document.documentElement.dataset.colorMode;

let dark = false;
const listeners: Array<() => void> = [];

const realMatchMedia = (globalThis as { matchMedia?: unknown }).matchMedia;

beforeEach(() => {
  dark = false;
  listeners.length = 0;
  localStorage.clear();
  // A driveable one, because the point is what happens when the OS flips under a
  // running page — not that happy-dom lacks it. It has one, which is why this is
  // put back rather than deleted below.
  (globalThis as { matchMedia?: unknown }).matchMedia = (query: string) => ({
    matches: query.includes("dark") && dark,
    addEventListener: (_: string, fn: () => void) => void listeners.push(fn),
    removeEventListener: () => {},
  });
});

afterEach(() => {
  // Restored, not deleted. `delete` took happy-dom's own out of a global these
  // files share with every other file in the worker, and the next one to boot the
  // real bundle died on `matchMedia is not defined` — in CI only, since this
  // file's neighbour has to be a test that builds a bundle.
  (globalThis as { matchMedia?: unknown }).matchMedia = realMatchMedia;
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.colorMode;
});

const osChangesTo = (isDark: boolean) => {
  dark = isDark;
  for (const fn of listeners) fn();
};

test("a stored preference is applied at boot, and beats what the OS says", () => {
  localStorage.setItem("orch.theme", "light");
  dark = true;
  startTheme();
  expect(theme()).toBe("light");
  // The markdown editor's attribute, written by the same line and asserted with
  // it: on its own it would follow the OS and render a dark card in a light page.
  expect(colorMode()).toBe("light");
});

test("with no preference stored the OS decides, and the attribute is never 'system'", () => {
  dark = true;
  startTheme();
  expect(theme()).toBe("dark");
});

test("on 'system' the page follows the OS changing under it", () => {
  startTheme();
  expect(theme()).toBe("light");
  osChangesTo(true);
  expect(theme()).toBe("dark");
});

test("a pinned preference ignores the OS changing under it", () => {
  localStorage.setItem("orch.theme", "light");
  startTheme();
  osChangesTo(true);
  expect(theme()).toBe("light");
  expect(colorMode()).toBe("light");
});

test("the editor's colour mode follows the page rather than the OS", () => {
  // Both directions, because the failure is one-sided: an attribute that never
  // moves passes half of this.
  startTheme();
  expect([theme(), colorMode()]).toEqual(["light", "light"]);
  osChangesTo(true);
  expect([theme(), colorMode()]).toEqual(["dark", "dark"]);
});
