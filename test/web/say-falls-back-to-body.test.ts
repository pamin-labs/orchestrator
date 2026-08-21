import { expect, test } from "bun:test";
import { i18n } from "../../web/src/i18n.ts";
import { appendFrame, type PanelFrame } from "../../web/src/shared/stream.ts";

/**
 * The whole of the migration's safety, stated as one test.
 *
 * `event.meta_json` gained a key beside a body it did not replace: no DDL, no
 * backfill, and `state_change` — the largest kind by emitters — is trimmed at
 * seven days rather than rewritten. So a row stored before this shipped has to
 * keep rendering the sentence the server rendered into it.
 */
const one = (f: Parameters<typeof appendFrame>[1]): PanelFrame => appendFrame([], f, { current: 0 })[0]!;

test("a row stored before meta.say existed renders the body it was written with", () => {
  const row = one({ type: "event", seq: 1, kind: "state_change", author: "boss", body: "已合入 main", at: 1 });
  expect(row.text).toBe("已合入 main");
});

test("a row carrying meta.say renders the panel's catalogue, not the stored body", () => {
  i18n.activate("en");
  const row = one({
    type: "event",
    seq: 2,
    kind: "state_change",
    author: "boss",
    // What the server wrote for the webhook and for `/readyz`, in output.language.
    body: "已合入 main",
    meta: { say: { id: "ev.group.merged" } },
    at: 2,
  });
  expect(row.text).toBe("merged into main");
  i18n.activate("zh");
  expect(
    one({
      type: "event",
      seq: 3,
      kind: "say",
      author: "boss",
      body: "x",
      meta: { say: { id: "ev.group.merged" } },
      at: 3,
    }).text,
  ).toBe("已合入 main");
});

test("arguments are filled in by the panel, from values the server sent", () => {
  i18n.activate("en");
  const row = one({
    type: "event",
    seq: 4,
    kind: "escalation",
    author: "watchdog",
    body: "PR #7 已开",
    meta: { rule: "pr", say: { id: "ev.pr.opened", values: { n: 7 } } },
    at: 4,
  });
  expect(row.text).toBe("PR #7 opened");
});

test("a key this build has no descriptor for falls back to the stored body", () => {
  const row = one({
    type: "event",
    seq: 5,
    kind: "say",
    author: "orchestrator",
    body: "something a newer server said",
    meta: { say: { id: "not.a.key.here" } },
    at: 5,
  });
  expect(row.text).toBe("something a newer server said");
});
