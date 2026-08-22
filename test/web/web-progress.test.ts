import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { cleanup, render as mount } from "../support/render.tsx";
import { emptyState } from "../../web/src/shared/api.ts";
import { TipRoot } from "../../web/src/ui/tooltip.tsx";
import { Progress } from "../../web/src/features/progress/view.tsx";

/**
 * testing-library's own `afterEach(cleanup)` is registered when its module is
 * evaluated, and `bun test` scopes the lifecycle globals per file — so that hook
 * belongs to whichever file imported it first, and every later file kept the
 * previous one's nodes in `document.body`. Each file registers its own.
 */
afterEach(cleanup);

/** One board at a time: the last test renders two tabs and they share the page. */
const render = (state = emptyState(), tab: string | null = null) => {
  cleanup();
  return mount(
    createElement(
      TipRoot,
      null,
      createElement(Progress, {
        st: state,
        projectId: 1,
        maxGroups: 1,
        tab,
        onTab: () => {},
        onOpen: () => {},
        queue: createElement("span", null, "老板队列"),
      }),
    ),
  );
};

const shown = (r: ReturnType<typeof render>, text: string) =>
  expect(r.getAllByText(text, { exact: false }).length).toBeGreaterThan(0);

test("an empty project still teaches the interface", () => {
  // This used to return one sentence in place of the whole view. The sentence
  // was right and the early return was not, so the onboarding line now comes
  // from `emptyOf("live")` inside the bucket that is actually empty — which is
  // where PRODUCT.md wants it: the empty screen still teaches the interface.
  //
  // `Time` is no longer asserted here because it is no longer a tab. It sits in
  // the top nav beside `Requirement`, a rank up: a project's spans are mostly routes and
  // container operations belonging to no requirement, so "where did this
  // project's time go" is a sibling of "which requirements are running" rather
  // than a detail inside it.
  const view = render();
  shown(view, "右上角 ＋ 新需求");
  expect(view.getAllByRole("tab").map((tab) => tab.textContent)).not.toContain("耗时");
});

test("progress exposes live work, slice evidence and the concurrency limit", () => {
  const state = emptyState();
  state.groups.push({
    id: 2,
    project_id: 1,
    name: "发布链路",
    branch: "orch/release",
    status: "RUNNING",
    owns_json: [],
    budget_tokens: 100,
    spent_tokens: 20,
    pr_number: null,
    approved_at: null,
  });
  state.slices.push({
    id: 3,
    grp_id: 2,
    seq: 1,
    title: "构建归档",
    accept_spec: "archive smoke passes",
    difficulty: "normal",
    status: "accepted",
    gates_json: '{"gate":"pass"}',
    spent_tokens: 10,
    awaiting_at: null,
  });

  const board = render(state, "live");
  shown(board, "发布链路");
  shown(board, "构建归档");
  shown(board, "并行 1/1");
  shown(board, "已查收 1/1");
});

test("the boss queue is rendered only by the boss-owned tab", () => {
  const state = emptyState();
  state.archived.push({
    id: 4,
    project_id: 1,
    name: "旧需求",
    branch: null,
    pr_number: 9,
    spent_tokens: 1,
    slices: 2,
    at: 1,
  });
  const mine = render(state, "mine");
  shown(mine, "老板队列");
  // The queue belongs to that tab: the archive tab renders the archive instead.
  expect(mine.queryAllByText("旧需求", { exact: false })).toHaveLength(0);

  const done = render(state, "done");
  shown(done, "旧需求");
  expect(done.queryAllByText("老板队列", { exact: false })).toHaveLength(0);
});
