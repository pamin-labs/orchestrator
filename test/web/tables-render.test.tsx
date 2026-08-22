import { afterEach, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { cleanup, render as mount } from "../support/render.tsx";
import { emptyState } from "../../web/src/shared/api.ts";
import { TipRoot } from "../../web/src/ui/tooltip.tsx";
import { CostView, Desk, Owns } from "../../web/src/features/tables/view.tsx";

/**
 * testing-library's own `afterEach(cleanup)` is registered when its module is
 * evaluated, and `bun test` scopes the lifecycle globals per file — so that hook
 * belongs to whichever file imported it first, and every later file kept the
 * previous one's nodes in `document.body`. Each file registers its own.
 */
afterEach(cleanup);

/** One surface at a time: these all share the page, so each render replaces the last. */
const render = (node: ReactNode) => {
  cleanup();
  return mount(<TipRoot>{node}</TipRoot>);
};

/** These sentences sit inside longer lines, so the match is a substring of the text. */
const shown = (r: ReturnType<typeof render>, text: string) =>
  expect(r.getAllByText(text, { exact: false }).length).toBeGreaterThan(0);
const gone = (r: ReturnType<typeof render>, text: string) =>
  expect(r.queryAllByText(text, { exact: false })).toHaveLength(0);

test("Desk, ownership and cost surfaces render observable empty and populated states", () => {
  const empty = emptyState();
  shown(render(<Desk st={empty} frames={[]} projectId={1} />), "还没有人上工");
  shown(render(<Owns st={empty} projectId={1} />), "还没有划过边界");
  shown(render(<CostView cost={null} />), "还没花 token");

  const state = emptyState();
  state.projects.push({ id: 1, name: "repo", repo_path: "me/repo", remote: null, base_branch: "main" });
  state.groups.push({
    id: 7,
    project_id: 1,
    name: "ship it",
    branch: "feature/ship",
    status: "RUNNING",
    owns_json: ["src/**"],
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
  shown(render(<Desk st={state} frames={[]} projectId={1} />), "engineer");
  shown(render(<Owns st={state} projectId={1} />), "src/**");

  const cost = {
    delivered: { count: 1, tokens: 500 },
    byGroup: [{ grpId: 7, label: "ship it", tokens: 500 }],
    agents: [{ id: 9, grpId: 7, role: "engineer", model: "sonnet", runtime: "claude", label: "engineer", tokens: 500 }],
    byRole: [{ label: "engineer", tokens: 500 }],
    byDifficulty: [{ label: "hard", tokens: 500 }],
    byRuntime: [{ label: "claude", tokens: 500 }],
    byHour: [{ hour: "08-13 12", at: Date.UTC(2026, 7, 13, 12), claude: 500, codex: 0 }],
    total: { label: "total", tokens: 500 },
    cacheRatio: 0.75,
    rotations: { turns: 4, byReason: { hash: 1 } },
  };
  const rendered = render(<CostView cost={cost} />);
  shown(rendered, "500");
  shown(rendered, "按需求");
  shown(rendered, "缓存命中率");
});

const owning = (id: number, name: string, owns: string[]) => ({
  id,
  project_id: 1,
  name,
  branch: null,
  status: "PARKED" as const,
  owns_json: owns,
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
  const pane = render(<Owns st={st} projectId={1} />);

  shown(pane, "2 个需求想改同一批文件，不能一起跑");
  // Each side names the other, on its own row.
  shown(pane, "压着 改记录");
  shown(pane, "压着 改闸门");
  gone(pane, "可以一起跑");
});

test("requirements with disjoint boundaries are cleared to run at once, and the unbounded are counted", () => {
  const st = emptyState();
  st.groups.push(owning(1, "改闸门", ["src/mech/**"]), owning(2, "改面板", ["web/src/**"]), owning(3, "没划", []));
  const pane = render(<Owns st={st} projectId={1} />);

  shown(pane, "2 个需求各改各的，可以一起跑（还有 1 个没分）");
  gone(pane, "压着");
});
