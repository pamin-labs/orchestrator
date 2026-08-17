import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { emptyState } from "../web/src/lib/api.ts";
import { TipRoot } from "../web/src/ui/tooltip.tsx";
import { Progress } from "../web/src/views/progress.tsx";

const render = (state = emptyState(), tab: string | null = null) =>
  renderToStaticMarkup(
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

test("progress explains an empty project instead of rendering an empty board", () => {
  expect(render()).toContain("这个项目还没有需求");
});

test("progress exposes live work, slice evidence and the concurrency limit", () => {
  const state = emptyState();
  state.groups.push({
    id: 2,
    project_id: 1,
    name: "发布链路",
    branch: "orch/release",
    status: "RUNNING",
    owns_json: "[]",
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

  const html = render(state, "live");
  expect(html).toContain("发布链路");
  expect(html).toContain("构建归档");
  expect(html).toContain("并行 1/1");
  expect(html).toContain("已查收 1/1");
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
  expect(render(state, "mine")).toContain("老板队列");
  expect(render(state, "done")).toContain("旧需求");
});
