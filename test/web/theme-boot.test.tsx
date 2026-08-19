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

let dark = false;
const listeners: Array<() => void> = [];

beforeEach(() => {
  dark = false;
  listeners.length = 0;
  localStorage.clear();
  // happy-dom has no `matchMedia`, and a real one could not be driven anyway:
  // the point is what happens when the OS flips underneath a running page.
  (globalThis as { matchMedia?: unknown }).matchMedia = (query: string) => ({
    matches: query.includes("dark") && dark,
    addEventListener: (_: string, fn: () => void) => void listeners.push(fn),
    removeEventListener: () => {},
  });
});

afterEach(() => {
  delete (globalThis as { matchMedia?: unknown }).matchMedia;
  delete document.documentElement.dataset.theme;
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
});
