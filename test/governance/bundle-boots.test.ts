import { afterEach, beforeEach, expect, test } from "bun:test";
import { pathToFileURL } from "node:url";
import { restoreFetch, stubFetch } from "../support/render.tsx";
import { emptyState } from "../../web/src/shared/api.ts";

/**
 * The bundle the browser is actually served, booted.
 *
 * Every other web test imports `web/src/**` directly, which means none of them
 * runs the artefact. That gap is not theoretical: `recharts` resolves a scale by
 * building `"scale" + type` and looking it up on its `d3-scale` namespace, and a
 * lookup like that is invisible to a bundler — so tree-shaking removed
 * `scalePoint`'s implementation while its export getter survived, and 耗时 died
 * on mount with `ij0 is not defined`. The source was correct. The bundle was
 * not, and 1,300 passing tests said nothing about it.
 *
 * So this one boots the real file: the entry point evaluates, React mounts, and
 * the view the crash was in renders. It is slow by the standards of this suite
 * and it is the only test that can see this class of defect at all.
 *
 * The document comes from `test/support/dom.ts` at preload, the same one every
 * render test uses.
 */

/** Where `build:web` writes, so the test and the script cannot disagree. */
const BUNDLE = "web/dist/main.js";

/**
 * A viewport, because happy-dom measures every element as 0x0.
 *
 * Load-bearing rather than cosmetic: `ResponsiveContainer` draws nothing at all
 * at zero width, so without this the charts never lay out — and a scale that is
 * never resolved cannot fail to resolve. The first version of this test passed
 * against a bundle that was known broken, for exactly that reason.
 */
const realRect = HTMLElement.prototype.getBoundingClientRect.bind(HTMLElement.prototype);
const SIZE = { width: 900, height: 500 };

beforeEach(() => {
  HTMLElement.prototype.getBoundingClientRect = function rect(this: void): DOMRect {
    return { ...SIZE, top: 0, left: 0, right: SIZE.width, bottom: SIZE.height, x: 0, y: 0, toJSON: () => ({}) };
  };
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: SIZE.width });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: SIZE.height });
});

afterEach(() => {
  restoreFetch();
  document.body.innerHTML = "";
  HTMLElement.prototype.getBoundingClientRect = realRect;
});

/**
 * A snapshot the panel will route on, built from the contract's own empty value.
 *
 * Hand-writing one is how this test spent its first run on the first-project
 * screen: `SnapshotSchema` rejects a partial object and `useOrch` falls back to
 * `EMPTY` without saying so, which looks exactly like a project that does not
 * exist. Starting from `emptyState()` means the shape can only drift with the
 * contract.
 */
const STATE = {
  ...emptyState(),
  projects: [{ id: 1, name: "p", repo_path: "/tmp/p", remote: null, base_branch: "main" }],
};

/**
 * The panel's event stream, which happy-dom has no implementation of.
 *
 * A gap in the document simulation rather than in the product: `useOrch` opens
 * one on mount, so without this the boot throws `EventSource is not defined`
 * before it reaches anything worth asserting. Closing and listening are the
 * whole of the surface used here.
 */
class QuietSource extends EventTarget {
  close() {}
}

const TELEMETRY = {
  scope: "project",
  windowMs: 3_600_000,
  window: { from: 1_700_000_000_000 - 3_600_000, to: 1_700_000_000_000 },
  stages: [{ name: "turn", count: 2, totalMs: 20, p50: 10, p95: 10, errors: 0 }],
  traces: [],
  trend: [
    { at: 1_700_000_000_000 - 3_600_000, count: 1, p50: 10, p95: 20 },
    { at: 1_700_000_000_000, count: 1, p50: 12, p95: 25 },
  ],
  flame: [{ path: "turn", totalMs: 20, count: 2 }],
  slices: [],
  trace: null,
};

test("the built bundle mounts 耗时 without throwing", async () => {
  const file = Bun.file(BUNDLE);
  // A missing bundle is a skipped assertion wearing a pass, so say so instead.
  expect(await file.exists()).toBe(true);

  (globalThis as { EventSource?: unknown }).EventSource = QuietSource;
  stubFetch({ "/api/v1/telemetry": TELEMETRY, "/api/v1/state": STATE, "/api/v1/cost": { rows: [] } });
  location.hash = "#p=1&v=time";
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);

  const failures: unknown[] = [];
  const onError = (event: ErrorEvent) => failures.push(event.error ?? event.message);
  window.addEventListener("error", onError);
  try {
    // Cache-busted, because a second test in the same process would otherwise
    // get the module registry's copy and never evaluate the fresh build.
    await import(`${pathToFileURL(BUNDLE).href}?boot=${STATE.projects[0]!.id}`);
    // The mount is inside an effect; one microtask turn is enough for React to
    // commit, and any throw from it reaches the listener above.
    // Two turns: one for the mount, one for the query that the view reads.
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  } finally {
    window.removeEventListener("error", onError);
  }

  // Named rather than counted: a `ReferenceError` from a tree-shaken binding
  // carries a minified identifier, and printing it is the whole difference
  // between "the bundle is broken" and "`ij0` was shaken out".
  expect(failures.map(String)).toEqual([]);
  // And it rendered rather than merely not throwing: the error boundary catches,
  // so a silent crash looks exactly like a quiet success from the outside.
  expect(document.body.textContent).not.toContain("这个视图崩了");
  expect(document.body.textContent).toContain("耗时");
});
