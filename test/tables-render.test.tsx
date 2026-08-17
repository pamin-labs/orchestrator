import { expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { emptyState } from "../web/src/lib/api.ts";
import { TipRoot } from "../web/src/ui/tooltip.tsx";
import { CostView, Desk, Owns } from "../web/src/views/tables.tsx";

const render = (node: ReactNode) => renderToStaticMarkup(<TipRoot>{node}</TipRoot>);

test("Desk, ownership and cost surfaces render observable empty and populated states", () => {
  const empty = emptyState();
  expect(render(<Desk st={empty} frames={[]} projectId={1} />)).toContain("还没有人上工");
  expect(render(<Owns st={empty} projectId={1} />)).toContain("还没有划过边界");
  expect(render(<CostView cost={null} />)).toContain("还没花 token");

  const state = emptyState();
  state.projects.push({ id: 1, name: "repo", repo_path: "me/repo", remote: null, base_branch: "main" });
  state.groups.push({
    id: 7,
    project_id: 1,
    name: "ship it",
    branch: "feature/ship",
    status: "RUNNING",
    owns_json: '["src/**"]',
    budget_tokens: 1000,
    spent_tokens: 120,
    pr_number: null,
    approved_at: null,
  });
  state.agents.push({
    id: 9,
    grp_id: 7,
    role: "engineer",
    model: "claude-sonnet-5",
    state: "running",
    activity: "editing tables",
    session_tokens: 40,
    total_tokens: 120,
    turns: 2,
    slice_id: null,
  });
  expect(render(<Desk st={state} frames={[]} projectId={1} />)).toContain("engineer");
  expect(render(<Owns st={state} projectId={1} />)).toContain("src/**");

  const cost = {
    delivered: { count: 1, tokens: 500 },
    byGroup: [{ grpId: 7, label: "ship it", tokens: 500 }],
    agents: [{ id: 9, grpId: 7, role: "engineer", model: "sonnet", runtime: "claude", label: "engineer", tokens: 500 }],
    byRole: [{ label: "engineer", tokens: 500 }],
    byDifficulty: [{ label: "hard", tokens: 500 }],
    byRuntime: [{ label: "claude", tokens: 500 }],
    byHour: [{ hour: "12:00", claude: 500, codex: 0 }],
    total: { label: "total", tokens: 500 },
    cacheRatio: 0.75,
    rotations: { turns: 4, byReason: { hash: 1 } },
  };
  const rendered = render(<CostView cost={cost} />);
  expect(rendered).toContain("500");
  expect(rendered).toContain("按需求");
  expect(rendered).toContain("cache 命中");
});
