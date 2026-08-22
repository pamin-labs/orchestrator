import { afterEach, expect, test } from "bun:test";
import { HttpResponse, http } from "msw";
import { act, cleanup, render, waitFor } from "../support/render.tsx";
import { inFlight, mockHttp, server } from "../support/http.ts";
import { FirstProject } from "../../web/src/features/picker/view.tsx";
import { Timeline } from "../../web/src/features/timeline/view.tsx";
import { appendFrame } from "../../web/src/shared/stream.ts";
import { emptyState } from "../../web/src/shared/api.ts";
import { i18n } from "../../web/src/i18n.ts";
import { messages as en } from "../../locales/en.po";

/**
 * A refusal the server named is shown in the language the reader is reading
 * *now*, not the one they were reading when the request went out.
 *
 * `readJson` turned the `Said` into text as the response landed and `Repos` put
 * that string in `useState`. A locale change re-renders every `useLingui`
 * consumer, but a string in state consumes nothing — so the boss switched to
 * Chinese and one line stayed Portuguese, under a Chinese heading.
 */
/**
 * `FirstProject` rather than a unit of `readJson`, because the bug is the round
 * trip: the descriptor has to survive the fetch, the state and the re-render.
 * Asserting on `readJson`'s return value would have passed the whole time.
 */

/** The one `bad()` on this route, and the two renderings the catalogues hold. */
const REFUSAL = {
  id: "8AwZlC",
  message: "GitHub is not connected — connect it in Settings first",
} as const;
const IN_CHINESE = "GitHub 还没连上";
const IN_ENGLISH = "GitHub is not connected";

/** The `merged into main` descriptor, as `bus.emit` stores it in `meta.say`. */
const MERGED = { id: "MflVvA", message: "merged into main" };

/** What `bad()` puts on the wire: the English beside the descriptor that names it. */
const refused = () =>
  HttpResponse.json(
    { error: REFUSAL.message, code: "operation_refused", request_id: "test", said: REFUSAL },
    { status: 422 },
  );

afterEach(() => {
  cleanup();
  i18n.activate("zh");
});

mockHttp(inFlight());

test("a stored refusal follows the reader, not the request", async () => {
  server.use(http.get("/api/v1/github/repos", refused));
  i18n.load("en", en);

  render(<FirstProject onAdded={() => {}} onSettings={() => {}} />);
  // Read in Chinese, which is what `setup.ts` activates: the refusal arrives and
  // is drawn from the reader's own catalogue.
  await waitFor(() => expect(document.body.textContent ?? "").toContain(IN_CHINESE));

  // Nothing is re-fetched: the same refusal, already in state, is re-read.
  act(() => {
    i18n.activate("en");
  });

  expect(document.body.textContent ?? "").toContain(IN_ENGLISH);
  expect(document.body.textContent ?? "").not.toContain(IN_CHINESE);
});

/**
 * The same defect on the surface with the most rows.
 *
 * `appendFrame` rendered `meta.say` at ingest, and frames are appended to
 * `useState` and never rebuilt — so every timeline row was frozen in whichever
 * language its SSE frame arrived in. The frame carries the descriptor now and
 * `Timeline` renders it, which is also what lets `TimelineRow` stay a `memo`:
 * the text is a prop, so it changes when the locale does.
 */
test("the timeline redraws in the language being read, not the one it arrived in", () => {
  i18n.load("en", en);
  i18n.activate("en");
  const frames = appendFrame(
    [],
    { type: "event", seq: 1, kind: "state_change", author: "boss", body: "已合入 main", meta: { say: MERGED }, at: 1 },
    { current: 0 },
  );
  const view = render(<Timeline st={emptyState()} frames={frames} grpId={null} projectId={null} />);
  expect(view.container.textContent).toContain("merged into main");

  act(() => {
    i18n.activate("zh");
  });
  expect(view.container.textContent).toContain("已合入 main");
  expect(view.container.textContent).not.toContain("merged into main");
});
