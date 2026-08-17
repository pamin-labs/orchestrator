import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { emptyState, type Group, type State } from "../web/src/lib/api.ts";
import { TipRoot } from "../web/src/ui/tooltip.tsx";
import { Requirement } from "../web/src/views/requirement.tsx";

const group = (status: Group["status"]): Group => ({
  id: 7,
  project_id: 1,
  name: "ship it",
  branch: "feature/ship",
  status,
  owns_json: '["src/**"]',
  budget_tokens: 1000,
  spent_tokens: 120,
  pr_number: null,
  approved_at: null,
});

const render = (state: State, current: Group, tab: string | null = null) =>
  renderToStaticMarkup(
    <TipRoot>
      <Requirement st={state} g={current} frames={[]} refresh={() => {}} open tab={tab} />
    </TipRoot>,
  );

test("Requirement renders missing, draft, slice review and blocking-question states", () => {
  const draft = emptyState();
  const draftGroup = group("DRAFT");
  draft.groups.push(draftGroup);
  expect(render(draft, draftGroup)).toContain("Dispatcher 正在写计划卡");
  draft.draftCards.push({ grpId: 7, body: "## Plan\nShip the slice", at: 1 });
  const filed = render(draft, draftGroup);
  expect(filed).toContain("计划卡");
  expect(filed).toContain("批准开工");

  const active = emptyState();
  const activeGroup = group("RUNNING");
  active.groups.push(activeGroup);
  expect(render(active, activeGroup, "slice")).toContain("正在拆解");
  active.slices.push({
    id: 11,
    grp_id: 7,
    seq: 1,
    title: "Implement review",
    accept_spec: "Visible behavior is preserved",
    difficulty: "hard",
    status: "awaiting_boss",
    gates_json: '{"typecheck":"pass","qa":"pass"}',
    spent_tokens: 80,
    awaiting_at: Date.now() - 60_000,
  });
  const review = render(active, activeGroup, "slice");
  expect(review).toContain("Implement review");
  expect(review).toContain("待你查收");

  active.escalations.push({
    id: 21,
    grp_id: 7,
    severity: "blocker",
    question: "Which compatibility behavior should remain?",
    chain_state: "boss",
    brief: "compatibility",
    kind: "spec",
    answered_by: null,
    answer: null,
    created_at: Date.now() - 120_000,
    asker: "engineer",
    asker_project: 1,
  });
  const question = render(active, activeGroup, "ask");
  expect(question).toContain("Which compatibility behavior should remain?");
  expect(question).toContain("全组停着");
});
