import { afterEach, beforeEach, expect, test } from "bun:test";
import { startTheme } from "../../web/src/ui/theme.tsx";

/**
 * ⌘⇧L, in its own file because `startTheme` is a boot-once function.
 *
 * It registers a `keydown` listener and never removes one — correct for something
 * called once at boot, and it means a second call in the same process leaves two
 * listeners, so one press cycles the theme twice. Split rather than worked around:
 * a test that compensated for the count would pass while quietly asserting the
 * accumulation instead of the cycle.
 */
const theme = () => document.documentElement.dataset.theme;

// Dispatched on `window` itself, which is where the listener is: testing-library's
// `fireEvent` targets an element, and the shortcut is deliberately global.
// `cancelable`, as a browser's keydown is: the handler claims the chord with
// `preventDefault`, and a non-cancelable event cannot be claimed.
const chord = (init: KeyboardEventInit) =>
  window.dispatchEvent(new KeyboardEvent("keydown", { cancelable: true, ...init }));

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
});

test("the hotkey cycles system → light → dark → system and stores each step", () => {
  startTheme();
  const press = () => chord({ key: "L", metaKey: true, shiftKey: true });

  press();
  expect(localStorage.getItem("orch.theme")).toBe("light");
  expect(theme()).toBe("light");
  press();
  expect(localStorage.getItem("orch.theme")).toBe("dark");
  expect(theme()).toBe("dark");
  press();
  expect(localStorage.getItem("orch.theme")).toBe("system");
  expect(theme()).toBe("light");
});

test("a chord another listener already claimed is not stepped again", () => {
  // A second copy of the module on the same window — the built bundle booted
  // beside the source — is one press walking two steps. The first handler to
  // run takes the event; whoever runs after it sees that and stands down.
  startTheme();
  const claimed = new KeyboardEvent("keydown", { key: "L", metaKey: true, shiftKey: true, cancelable: true });
  claimed.preventDefault();
  window.dispatchEvent(claimed);
  expect(localStorage.getItem("orch.theme")).toBeNull();
});

test("a chord that is not the hotkey changes nothing", () => {
  startTheme();
  chord({ key: "L", metaKey: true });
  chord({ key: "K", metaKey: true, shiftKey: true });
  expect(localStorage.getItem("orch.theme")).toBeNull();
});
