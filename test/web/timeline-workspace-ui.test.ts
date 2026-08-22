import { afterEach, test } from "bun:test";
import { createElement } from "react";
import { cleanup, gone, render as mount, shown } from "../support/render.tsx";
import { inFlight, mockHttp } from "../support/http.ts";
import { emptyState } from "../../web/src/shared/api.ts";
import type { PanelFrame } from "../../web/src/shared/stream.ts";
import { Timeline } from "../../web/src/features/timeline/view.tsx";
import { Workspace } from "../../web/src/features/workspace/view.tsx";
import { WithQueries } from "./queries.tsx";

/**
 * testing-library's own `afterEach(cleanup)` is registered when its module is
 * evaluated, and `bun test` scopes the lifecycle globals per file — so that hook
 * belongs to whichever file imported it first, and every later file kept the
 * previous one's nodes in `document.body`. Each file registers its own.
 */
afterEach(cleanup);

/** The workspace reads its own tail on mount. Left in flight: what these tests
 *  assert is the frames they were handed, not the read. */
mockHttp(inFlight());

/** One view at a time: both halves of each test share the page. The workspace
 *  reads through the query cache, so every render needs one behind it. */
const render = (node: ReturnType<typeof createElement>) => {
  cleanup();
  return mount(createElement(WithQueries, null, node));
};

const frame = (id: string, body: string, grpId: number | null, projectId = 1): PanelFrame => ({
  id,
  cls: "say",
  grpId,
  projectId,
  at: Number(id.slice(1)) || 1,
  author: "agent",
  body,
});

test("timeline renders an empty state and filters to the selected requirement", () => {
  const st = emptyState();
  st.groups.push({
    id: 1,
    project_id: 1,
    name: "Release",
    branch: null,
    status: "RUNNING",
    owns_json: [],
    budget_tokens: null,
    spent_tokens: 0,
    pr_number: null,
    approved_at: null,
  });
  shown(render(createElement(Timeline, { st, frames: [], grpId: 1, projectId: 1 })), "无事件");

  const filtered = render(
    createElement(Timeline, {
      st,
      frames: [frame("e1", "selected", 1), frame("e2", "other", 2), frame("e3", "standing", null)],
      grpId: 1,
      projectId: 1,
    }),
  );
  shown(filtered, "Release");
  shown(filtered, "selected");
  shown(filtered, "standing");
  gone(filtered, "other");
});

test("workspace renders its empty state plus live path and diff output", () => {
  shown(render(createElement(Workspace, { frames: [], grpId: 1 })), "容器还没说话");
  const lines = ["$ pwd", "/workspace", "$ git diff", "+changed"].map(
    (body, index): PanelFrame => ({
      id: `e${index}`,
      cls: "tool",
      grpId: 1,
      projectId: 1,
      at: index,
      author: "orchestrator",
      agentId: null,
      body,
    }),
  );
  const live = render(createElement(Workspace, { frames: lines, grpId: 1 }));
  shown(live, "$ pwd");
  shown(live, "/workspace");
  shown(live, "$ git diff");
  shown(live, "+changed");
});
