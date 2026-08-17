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

const owning = (id: number, name: string, owns: string[]) => ({
  id,
  project_id: 1,
  name,
  branch: null,
  status: "PARKED" as const,
  owns_json: JSON.stringify(owns),
  budget_tokens: null,
  spent_tokens: 0,
  pr_number: null,
  approved_at: null,
});

test("two requirements reaching the same files are named as the pair that cannot run together", () => {
  // A glob and a path under it are the same claim: `src/mech/**` and
  // `src/mech/notes.ts` are two groups about to write the same file.
  const st = emptyState();
  st.groups.push(owning(1, "改闸门", ["src/mech/**"]), owning(2, "改记录", ["src/mech/notes.ts"]));
  const html = render(<Owns st={st} projectId={1} />);

  expect(html).toContain("2 个需求想改同一批文件，不能一起跑");
  // Each side names the other, on its own row.
  expect(html).toContain("压着 改记录");
  expect(html).toContain("压着 改闸门");
  expect(html).not.toContain("可以一起跑");
});

test("requirements with disjoint boundaries are cleared to run at once, and the unbounded are counted", () => {
  const st = emptyState();
  st.groups.push(owning(1, "改闸门", ["src/mech/**"]), owning(2, "改面板", ["web/src/**"]), owning(3, "没划", []));
  const html = render(<Owns st={st} projectId={1} />);

  expect(html).toContain("2 个需求各改各的，可以一起跑");
  expect(html).toContain("还有 1 个没分");
  expect(html).not.toContain("压着");
});
