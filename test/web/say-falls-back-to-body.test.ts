import { expect, test } from "bun:test";
import { i18n } from "../../web/src/i18n.ts";
import { said as say } from "../support/said.ts";
import { appendFrame, type PanelFrame } from "../../web/src/shared/stream.ts";
import { saidText } from "../../web/src/shared/said.ts";

/**
 * The whole of the migration's safety, stated as one test.
 *
 * `event.meta_json` gained a key beside a body it did not replace: no DDL, no
 * backfill, and `state_change` — the largest kind by emitters — is trimmed at
 * seven days rather than rewritten. So a row stored before this shipped has to
 * keep rendering the sentence the server rendered into it.
 */
const one = (f: Parameters<typeof appendFrame>[1]): PanelFrame => appendFrame([], f, { current: 0 })[0]!;

/**
 * What the row draws, which is not what the frame stores.
 *
 * The frame carries the descriptor and the stored body; rendering happens in
 * `TimelineRow`, under whichever catalogue is active *then*. Ingest used to
 * render, and the frames are appended to `useState` and never rebuilt — so the
 * whole timeline stayed in the language it arrived in.
 */
const drawn = (f: Parameters<typeof appendFrame>[1]): string => {
  const row = one(f);
  return saidText(row.said, row.text);
};

const MERGED = "merged into main";

test("a row stored before meta.say existed renders the body it was written with", () => {
  const row = one({ type: "event", seq: 1, kind: "state_change", author: "boss", body: "已合入 main", at: 1 });
  expect(row.said).toBeUndefined();
  expect(saidText(row.said, row.text)).toBe("已合入 main");
});

test("a row carrying meta.say renders the panel's catalogue, not the stored body", () => {
  const merged = {
    type: "event",
    seq: 2,
    kind: "state_change",
    author: "boss",
    // What the server wrote for the webhook and for `/readyz`, in output.language.
    body: "已合入 main",
    meta: { say: say(MERGED) },
    at: 2,
  } as const;

  i18n.activate("en");
  expect(drawn(merged)).toBe("merged into main");
  i18n.activate("zh");
  expect(drawn(merged)).toBe("已合入 main");
});

test("one frame, ingested once, follows the reader when the locale moves", () => {
  // The report this fixes: the frame is in `useState` and nothing rebuilds it, so
  // rendering at ingest froze every row in the language it arrived in.
  i18n.activate("en");
  const row = one({
    type: "event",
    seq: 9,
    kind: "state_change",
    author: "boss",
    body: "已合入 main",
    meta: { say: say(MERGED) },
    at: 9,
  });
  expect(saidText(row.said, row.text)).toBe("merged into main");
  i18n.activate("zh");
  expect(saidText(row.said, row.text)).toBe("已合入 main");
});

test("arguments are filled in by the panel, from values the server sent", () => {
  i18n.activate("en");
  expect(
    drawn({
      type: "event",
      seq: 4,
      kind: "escalation",
      author: "watchdog",
      body: "PR #7 已开",
      meta: { rule: "pr", say: say("PR #{n} opened", { n: 7 }) },
      at: 4,
    }),
  ).toBe("PR #7 opened");
});

/**
 * There is no "a newer server named an id this panel does not know": `release.yml`
 * puts `web/dist` and the binary in the same tarball, so the two ship together.
 * The test that asserted that state is gone with it.
 */
