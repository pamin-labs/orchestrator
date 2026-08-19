import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { HttpResponse, http } from "msw";
import { waitFor } from "../support/render.tsx";
import { inFlight, mockHttp, server } from "../support/http.ts";
import { emptyState } from "../../web/src/shared/api.ts";

/**
 * The bundle the browser is actually served, booted.
 *
 * Every other web test imports `web/src/**` directly, so none runs the artefact.
 * That gap let tree-shaking remove a `scalePoint` implementation while its export
 * getter survived, and 耗时 died on mount with `ij0 is not defined` — the source
 * correct, the bundle not, and 1,300 passing tests silent (`096cb8b`).
 */
/**
 * It **builds its own bundle** rather than reading `web/dist/main.js`. Asserting
 * on the checked-out artefact made the suite depend on `build:web` having run,
 * which `test-main` does not — so in CI the file was absent, and because this
 * file installs process-global fakes its failure took eighteen tests in the same
 * worker with it. A test that needs a bundle should produce one, and a test that
 * reaches for a global owes it back.
 */

/** The same entry point `build:web` uses; anything else boots a different bundle. */
const ENTRY = "web/src/app/main.tsx";

let workdir = "";

/**
 * A viewport, because happy-dom measures every element as 0x0.
 *
 * Load-bearing rather than cosmetic: `ResponsiveContainer` draws nothing at all
 * at zero width, so without this the charts never lay out — and a scale that is
 * never resolved cannot fail to resolve. The first version of this test passed
 * against a bundle already known to be broken, for exactly that reason.
 */
const realRect = HTMLElement.prototype.getBoundingClientRect.bind(HTMLElement.prototype);
const SIZE = { width: 900, height: 500 };

/**
 * The panel's event stream, which happy-dom has no implementation of.
 *
 * A gap in the document simulation rather than in the product: `useOrch` opens
 * one on mount, so without this the boot throws `EventSource is not defined`
 * before it reaches anything worth asserting.
 */
class QuietSource extends EventTarget {
  close() {}
}

beforeEach(() => {
  HTMLElement.prototype.getBoundingClientRect = function rect(this: void): DOMRect {
    return { ...SIZE, top: 0, left: 0, right: SIZE.width, bottom: SIZE.height, x: 0, y: 0, toJSON: () => ({}) };
  };
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: SIZE.width });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: SIZE.height });
});

afterEach(() => {
  // Every one of these is process-global and shared with the other files in this
  // worker, so the teardown is not tidiness: leaving the fake viewport installed
  // is what turned one failure here into eighteen elsewhere.
  document.body.innerHTML = "";
  location.hash = "";
  HTMLElement.prototype.getBoundingClientRect = realRect;
  Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth");
  Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
  Reflect.deleteProperty(globalThis, "EventSource");
  if (workdir) rmSync(workdir, { recursive: true, force: true });
  workdir = "";
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

/** Anything the booted panel reads beyond the three routes below stays in flight;
 *  the assertion is that the bundle mounts, not that every pane fills. */
mockHttp(inFlight());

const T0 = 1_700_000_000_000;

const TELEMETRY = {
  scope: "project",
  windowMs: 3_600_000,
  window: { from: T0 - 3_600_000, to: T0 },
  // The extent the store actually holds, which is what a zoom clamps against.
  dataWindow: { from: T0 - 3_600_000, to: T0 },
  stages: [{ name: "turn", count: 2, totalMs: 20, p50: 10, p95: 10, errors: 0 }],
  traces: [],
  trend: [
    { at: T0 - 3_600_000, count: 1, p50: 10, p95: 20 },
    { at: T0, count: 1, p50: 12, p95: 25 },
  ],
  flame: [{ path: "turn", totalMs: 20, count: 2 }],
  slices: [],
  trace: null,
};

test("the built bundle mounts 耗时 without throwing", async () => {
  workdir = mkdtempSync(join(tmpdir(), "orch-boot-"));
  const built = await Bun.build({ entrypoints: [ENTRY], target: "browser", minify: true, outdir: workdir });
  expect(built.success).toBe(true);

  (globalThis as { EventSource?: unknown }).EventSource = QuietSource;
  server.use(
    http.get("/api/v1/telemetry", () => HttpResponse.json(TELEMETRY)),
    http.get("/api/v1/state", () => HttpResponse.json(STATE)),
    http.get("/api/v1/cost", () => HttpResponse.json({ rows: [] })),
  );
  location.hash = "#p=1&v=time";
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);

  const failures: unknown[] = [];
  const onError = (event: ErrorEvent) => failures.push(event.error ?? event.message);
  window.addEventListener("error", onError);
  try {
    await import(pathToFileURL(join(workdir, "main.js")).href);
    // Polled, not slept. A fixed delay was long enough when this file ran alone
    // and not when sixteen workers were competing for the machine, so it failed
    // only under `--parallel` — the shape of flake that gets re-run rather than
    // read. `waitFor` ends as soon as the mount lands, and the same condition
    // is what the assertions below check.
    // The condition is the *settled* state, not "something rendered". Waiting
    // for a non-empty body ends on the first paint, which is the panel's
    // first-project screen while the snapshot is still in flight — so the
    // assertions below ran against a page that had not finished routing, and
    // did so only when the machine was busy enough for that gap to be visible.
    await waitFor(() => expect(document.body.textContent ?? "").toMatch(/耗时|这个视图崩了/));
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
