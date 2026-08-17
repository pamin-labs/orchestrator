import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { emptyState, type Group, type PanelFrame, type Slice, type State } from "../../web/src/lib/api.ts";
import { TipRoot } from "../../web/src/ui/tooltip.tsx";
import { Requirement } from "../../web/src/views/requirement.tsx";

const group = (status: Group["status"], over: Partial<Group> = {}): Group => ({
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
  ...over,
});

const slice = (over: Partial<Slice> = {}): Slice => ({
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
  ...over,
});

const frame = (over: Partial<PanelFrame> & { id: string }): PanelFrame => ({
  cls: "tool",
  grpId: 7,
  projectId: 1,
  at: 1_000,
  author: "orchestrator",
  text: "",
  agentId: null,
  ...over,
});

const render = (state: State, current: Group, tab: string | null = null, frames: PanelFrame[] = []) =>
  renderToStaticMarkup(
    <TipRoot>
      <Requirement st={state} g={current} frames={frames} refresh={() => {}} open tab={tab} />
    </TipRoot>,
  );

/** A group with one running slice, which is what most of these states hang off. */
function running(over: Partial<Group> = {}) {
  const st = emptyState();
  const g = group("RUNNING", over);
  st.groups.push(g);
  return { st, g };
}

test("Requirement renders missing, draft, slice review and blocking-question states", () => {
  const draft = emptyState();
  const draftGroup = group("DRAFT");
  draft.groups.push(draftGroup);
  expect(render(draft, draftGroup)).toContain("Dispatcher 正在写计划卡");
  draft.draftCards.push({ grpId: 7, body: "## Plan\nShip the slice", at: 1 });
  const filed = render(draft, draftGroup);
  expect(filed).toContain("计划卡");
  expect(filed).toContain("批准开工");

  const { st: active, g: activeGroup } = running();
  expect(render(active, activeGroup, "slice")).toContain("正在拆解");
  active.slices.push(slice());
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

test("the header shows the control that fits the group's state", () => {
  const live = running();
  const head = render(live.st, live.g, "slice");
  expect(head).toContain("ship it");
  expect(head).toContain("feature/ship");
  expect(head).toContain("在跑");
  expect(head).toContain("暂停");
  expect(head).toContain("更多");

  const paused = running({ status: "PAUSED", pr_number: 4 });
  const stopped = render(paused.st, paused.g, "slice");
  expect(stopped).toContain("已暂停");
  expect(stopped).toContain("继续");
  // A closed PR needs a way to file a second one; a branch that was force-pushed
  // cannot be reopened on GitHub at all.
  expect(stopped).toContain("开新 PR");

  const parked = running({ status: "PARKED" });
  const asleep = render(parked.st, parked.g, "slice");
  expect(asleep).toContain("已封存");
  expect(asleep).toContain("唤醒");
  expect(asleep).not.toContain("暂停");

  const open = running({ status: "PR_OPEN", pr_number: 9 });
  expect(render(open.st, open.g, "slice")).toContain("排队中");

  const queued = running({ status: "PR_OPEN", pr_number: 9 });
  queued.st.projects.push({
    id: 1,
    name: "orchestrator",
    repo_path: "/tmp/orchestrator",
    remote: "git@github.com:acme/orchestrator.git",
    base_branch: "main",
  });
  queued.st.mergeQueue.push({ projectId: 1, grpId: 7, name: "ship it", branch: "feature/ship", seq: 1, place: null });
  const merging = render(queued.st, queued.g, "slice");
  expect(merging).toContain("去合并 PR");
  expect(merging).toContain("https://github.com/acme/orchestrator/pull/9");
  expect(merging).not.toContain("排队中");
});

test("a group that has spent its budget gets the wall instead of a working 继续", () => {
  const { st, g } = running({ status: "PAUSED", budget_tokens: 1000, spent_tokens: 1000 });
  const wall = render(st, g, "slice");
  expect(wall).toContain("预算用尽，全组挂起");
  expect(wall).toContain("翻倍到");
  expect(wall).toContain("取消上限");
  // 继续 would be a button that changes nothing: the scheduler refuses to admit it.
  expect(wall).not.toContain(">继续<");

  const capped = running({ budget_tokens: null });
  expect(render(capped.st, capped.g, "slice")).toContain("无预算上限");
});

test("the rebuild pane reports both steps while it runs and stays up when it fails", () => {
  const { st, g } = running();
  const started = [
    frame({ id: "e1", cls: "state", text: "沙盒是新的", at: 1_000 }),
    frame({ id: "e2", text: "$ bun install --frozen-lockfile", at: 2_000 }),
    frame({ id: "e3", text: "resolved 400 packages", at: 3_000 }),
  ];
  const live = render(st, g, "slice", started);
  expect(live).toContain("克隆");
  expect(live).toContain("装依赖");
  expect(live).toContain("bun install --frozen-lockfile");
  expect(live).toContain("resolved 400 packages");
  expect(live).toContain("收起");

  const broken = render(st, g, "slice", [...started, frame({ id: "e4", cls: "state", text: "装失败了", at: 4_000 })]);
  expect(broken).toContain("装失败了");
  expect(broken).toContain("交给 bootstrap 重试");

  const done = render(st, g, "slice", [...started, frame({ id: "e5", cls: "state", text: "装好了", at: 4_000 })]);
  expect(done).not.toContain("装依赖");
  // Nothing at all before a rebuild has been asked for.
  expect(render(st, g, "slice")).not.toContain("克隆");
});

test("each slice row says where it is in its own words", () => {
  const { st, g } = running();
  st.slices.push(
    slice({ id: 1, seq: 1, title: "First", status: "accepted", gates_json: '{"qa":"pass"}', awaiting_at: null }),
    slice({ id: 2, seq: 2, title: "Second", status: "rejected", gates_json: '{"gate":"fail"}', awaiting_at: null }),
    slice({ id: 3, seq: 3, title: "Third", status: "running", gates_json: "{}", awaiting_at: null }),
    slice({ id: 4, seq: 4, title: "Fourth", status: "pending", gates_json: "{}", awaiting_at: null }),
  );
  st.agents.push({
    id: 5,
    grp_id: 7,
    role: "engineer",
    model: "opus",
    state: "running",
    activity: "command_execution: bun test",
    session_tokens: 10,
    total_tokens: 10,
    turns: 1,
    slice_id: 3,
  });
  const rows = render(st, g, "slice");
  expect(rows).toContain("等前序切片");
  expect(rows).toContain("已退回，等它修");
  expect(rows).toContain("engineer ▸ 跑测试 ");
  // Gate names come from the shared stop list, and 查收 is the boss's own column.
  expect(rows).toContain("自评");
  expect(rows).toContain("对账");
  expect(rows).toContain("测试");
  expect(rows).toContain("查收");
  expect(rows).toContain("S4");

  st.slices[2]!.status = "awaiting_boss";
  st.slices[2]!.awaiting_at = null;
  expect(render(st, g, "slice")).toContain("待你查收");

  // A slice with no agent on it falls back to what it promised.
  st.agents.length = 0;
  st.slices[2]!.status = "running";
  expect(render(st, g, "slice")).toContain("Visible behavior is preserved");
});

test("the open slice shows its tasks over the evidence the verdict answers", () => {
  const { st, g } = running();
  st.slices.push(slice({ id: 3, title: "Ship the panel" }));
  st.tasks.push(
    { id: 1, grp_id: 7, slice_id: 3, title: "Write the model", status: "done" },
    { id: 2, grp_id: 7, slice_id: 3, title: "Render it", status: "pending" },
  );
  const waiting = render(st, g, "slice");
  expect(waiting).toContain("Write the model");
  expect(waiting).toContain("Render it");
  // The two verdict buttons are handed to the evidence panel, which is still
  // fetching the diff they are a verdict on.
  expect(waiting).toContain("读改动…");

  // Nothing has produced anything yet: every row stays shut rather than opening
  // an empty panel in front of the boss.
  st.slices[0]!.status = "pending";
  st.slices[0]!.awaiting_at = null;
  const shut = render(st, g, "slice");
  expect(shut).toContain("等前序切片");
  expect(shut).not.toContain("Write the model");
});

test("the draft card carries every objection raised against it", () => {
  const st = emptyState();
  const g = group("DRAFT");
  st.groups.push(g);
  st.ideas.push({ grpId: 7, body: "Split the settings view" });
  st.draftCards.push({ grpId: 7, body: "目标: ship it", at: 1, unknownPaths: '["web/src/gone.tsx"]' });
  st.lateObjections.push({ grpId: 7, author: "architect", body: "The boundary is wrong" });
  const card = render(st, g);
  expect(card).toContain("Split the settings view");
  expect(card).toContain("architect 后补反对");
  expect(card).toContain("The boundary is wrong");
  expect(card).toContain("卡里这些路径仓库里没有");
  expect(card).toContain("web/src/gone.tsx");
  expect(card).toContain("批准开工");
  expect(card).toContain("退回重拆");

  st.dropProposals.push({ grpId: 7, body: "Already done in #12\nsee the merged PR" });
  const drop = render(st, g);
  expect(drop).toContain("规划岗建议作废");
  expect(drop).toContain("Already done in #12");
  expect(drop).toContain("确认作废");
  expect(drop).toContain("不，接着做");
});

test("an approved draft says what is holding it instead of asking to approve again", () => {
  const st = emptyState();
  const g = group("DRAFT", { approved_at: 5 });
  st.groups.push(g);
  st.draftCards.push({ grpId: 7, body: "目标: ship it", at: 1 });
  const held = render(st, g);
  expect(held).toContain("已批·等边界");
  expect(held).toContain("已批准，边界挡着");
  expect(held).toContain("等 Architect 切边界");
  expect(held).not.toContain("批准开工");

  st.approvedBlocked.push({ grpId: 7, reason: "settings.tsx is owned by 组 3" });
  expect(render(st, g)).toContain("settings.tsx is owned by 组 3");
});

test("the question lanes separate what is yours from what the chain is holding", () => {
  const { st, g } = running();
  st.slices.push(slice());
  expect(render(st, g, "ask")).toContain("没有开着的问题");

  st.escalations.push({
    id: 30,
    grp_id: 7,
    severity: "normal",
    question: "git ls-tree -r main --name-only",
    chain_state: "architect",
    brief: null,
    kind: "boundary",
    answered_by: null,
    answer: null,
    created_at: Date.now() - 30_000,
    asker: "pm",
    asker_project: 1,
  });
  const held = render(st, g, "ask");
  expect(held).toContain("别人在处理 1");
  expect(held).toContain("Architect 处理中");
  expect(held).toContain("git ls-tree -r main --name-only");
  expect(held).not.toContain("待你决策");

  st.answered.push({
    id: 31,
    grp_id: 7,
    question: "Which base branch?",
    answer: "main",
    answered_by: "cos",
    ref_note_id: null,
  });
  const delegated = render(st, g, "ask");
  expect(delegated).toContain("替你答过 1");

  // With one on the boss, that lane is the default and the others stay counted.
  st.escalations.push({
    id: 32,
    grp_id: 7,
    severity: "normal",
    question: "Accept the smaller scope?",
    chain_state: "boss",
    brief: null,
    kind: "spec",
    answered_by: null,
    answer: null,
    created_at: Date.now() - 10_000,
    asker: "pm",
    asker_project: 1,
  });
  const mine = render(st, g, "ask");
  expect(mine).toContain("待你决策 1");
  expect(mine).toContain("别人在处理 1");
  expect(mine).toContain("替你答过 1");
  expect(mine).toContain("Accept the smaller scope?");
  expect(mine).toContain("让 AI 拟一份");
  expect(mine).toContain("转 Architect");
  expect(mine).toContain("开成需求");
  // The pinned dock is gone while a decision carries its own answer box.
  expect(mine).not.toContain("跟这个组说话…");
});

test("the dock and the tab counts follow what the requirement holds", () => {
  const { st, g } = running();
  st.slices.push(slice({ id: 1, seq: 1 }), slice({ id: 2, seq: 2, status: "running", awaiting_at: null }));
  const tabs = render(st, g, "slice");
  expect(tabs).toContain("切片");
  expect(tabs).toContain("记录");
  expect(tabs).toContain("工作区");
  expect(tabs).toContain("问题");
  expect(tabs).toContain("跟这个组说话…");
});
