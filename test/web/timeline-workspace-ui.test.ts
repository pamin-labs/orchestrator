import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { emptyState, type PanelFrame } from "../../web/src/lib/api.ts";
import { Timeline } from "../../web/src/views/timeline.tsx";
import { Workspace } from "../../web/src/views/workspace.tsx";

const frame = (id: string, text: string, grpId: number | null, projectId = 1): PanelFrame => ({
  id,
  cls: "say",
  grpId,
  projectId,
  at: Number(id.slice(1)) || 1,
  author: "agent",
  text,
});

test("timeline renders an empty state and filters to the selected requirement", () => {
  const st = emptyState();
  st.groups.push({
    id: 1,
    project_id: 1,
    name: "Release",
    branch: null,
    status: "RUNNING",
    owns_json: "[]",
    budget_tokens: null,
    spent_tokens: 0,
    pr_number: null,
    approved_at: null,
  });
  expect(renderToStaticMarkup(createElement(Timeline, { st, frames: [], grpId: 1, projectId: 1 }))).toContain("无事件");

  const html = renderToStaticMarkup(
    createElement(Timeline, {
      st,
      frames: [frame("e1", "selected", 1), frame("e2", "other", 2), frame("e3", "standing", null)],
      grpId: 1,
      projectId: 1,
    }),
  );
  expect(html).toContain("Release");
  expect(html).toContain("selected");
  expect(html).toContain("standing");
  expect(html).not.toContain("other");
});

test("workspace renders its empty state plus live path and diff output", () => {
  expect(renderToStaticMarkup(createElement(Workspace, { frames: [], grpId: 1 }))).toContain("容器还没说话");
  const lines = ["$ pwd", "/workspace", "$ git diff", "+changed"].map(
    (text, index): PanelFrame => ({
      id: `e${index}`,
      cls: "tool",
      grpId: 1,
      projectId: 1,
      at: index,
      author: "orchestrator",
      agentId: null,
      text,
    }),
  );
  const html = renderToStaticMarkup(createElement(Workspace, { frames: lines, grpId: 1 }));
  expect(html).toContain("$ pwd");
  expect(html).toContain("/workspace");
  expect(html).toContain("$ git diff");
  expect(html).toContain("+changed");
});
