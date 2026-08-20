import { afterEach, beforeEach, expect, test } from "bun:test";
import { HttpResponse, http } from "msw";
import { cleanup, fireEvent, render as mount, waitFor } from "../support/render.tsx";
import { mockHttp, server } from "../support/http.ts";
import { WithQueries } from "./queries.tsx";
import { emptyState, useOrch } from "../../web/src/shared/api.ts";

/**
 * The stream this hook opens on mount, with a handle on it.
 *
 * happy-dom has no `EventSource`, and a real one would be a second source of state
 * changes in a test about the first. Keeping the instance is what lets a test deliver
 * frames the way the server would, which is the only way to reach the debounce.
 */
class QuietSource extends EventTarget {
  static last: QuietSource | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    super();
    QuietSource.last = this;
  }
  close() {}
}

beforeEach(() => {
  (globalThis as { EventSource?: unknown }).EventSource = QuietSource;
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(globalThis, "EventSource");
});

mockHttp(
  http.get("*/api/v1/state", () => HttpResponse.json(emptyState())),
  // The whole contract, because `useOrch` parses the reply: a partial object fails
  // the schema and the query errors instead of resolving, which reads in a test as
  // the read never having happened.
  http.get("*/api/v1/cost", ({ request }) => {
    const project = new URL(request.url).searchParams.get("project");
    return HttpResponse.json({
      delivered: { count: 0, tokens: 0 },
      byGroup: [],
      agents: [],
      byRole: [],
      byDifficulty: [],
      byRuntime: [],
      byHour: [],
      total: { label: `project ${project ?? "all"}`, tokens: 1 },
      cacheRatio: null,
      rotations: { turns: 0, byReason: {} },
    });
  }),
);

/**
 * The two reads the whole panel is built on, and the scope that is *in* one of them.
 *
 * `cost` used to be read against a `lastProject` ref because every stream frame
 * called `refresh()` with no argument, which swapped 成本 from this project to every
 * project while the heading still said 这个项目累计. The project is part of the query
 * key now, so a reply for one cannot be filed under another — but only a test that
 * switches scope can say the key is really doing that rather than a ref having come
 * back under another name.
 */
function Probe({ onCost }: { onCost: (label: string | null) => void }) {
  const { cost, refresh } = useOrch();
  onCost(cost?.total.label ?? null);
  return (
    <button type="button" onClick={() => refresh(7)}>
      switch
    </button>
  );
}

test("the cost read is scoped to the project it was asked for", async () => {
  const seen: (string | null)[] = [];
  const view = mount(
    <WithQueries>
      <Probe onCost={(label) => seen.push(label)} />
    </WithQueries>,
  );

  await waitFor(() => expect(seen).toContain("project all"));
  fireEvent.click(view.getAllByRole("button", { name: "switch" })[0]!);
  await waitFor(() => expect(seen).toContain("project 7"));
});

/**
 * A burst of frames costs one re-read, not one per frame.
 *
 * Ten groups moving at once is ten `state_change` frames inside a second, each
 * arriving after the last request already came back — the case a cache cannot
 * collapse, because nothing is in flight to collapse with. Trailing rather than
 * leading, so the state shown is the one after the burst rather than before it.
 */
test("a burst of frames costs one re-read", async () => {
  let reads = 0;
  server.use(
    http.get("*/api/v1/state", () => {
      reads++;
      return HttpResponse.json(emptyState());
    }),
  );
  mount(
    <WithQueries>
      <Probe onCost={() => {}} />
    </WithQueries>,
  );
  await waitFor(() => expect(reads).toBe(1));

  const stream = QuietSource.last!;
  // `type` is the discriminant, and without it `readWire` answers null and the
  // frame is dropped — silently, which is what this test would then be asserting.
  const frame = (seq: number) =>
    JSON.stringify({ type: "event", seq, at: seq, author: "orchestrator", kind: "state_change", body: "moved" });
  for (let i = 1; i <= 10; i++) stream.onmessage?.({ data: frame(i) });

  // One more read for the ten, not ten. `waitFor` outlasts the 250ms window.
  await waitFor(() => expect(reads).toBe(2), { timeout: 2000 });
  expect(reads).toBe(2);
});
