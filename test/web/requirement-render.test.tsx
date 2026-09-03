import { afterEach, expect, test } from "bun:test";
import { cleanup, gone, render as mount, shown, valueOf } from "../support/render.tsx";
import { inFlight, mockHttp } from "../support/http.ts";
import { emptyState, type Group, type Slice, type State } from "../../web/src/shared/api.ts";
import type { PanelFrame } from "../../web/src/shared/stream.ts";
import { BOOTSTRAP_FAILED, BOOTSTRAP_OK, BOOTSTRAP_START } from "../../src/contracts/events.ts";
import { TipRoot } from "../../web/src/ui/tooltip.tsx";
import { WithQueries } from "./queries.tsx";
import { Requirement } from "../../web/src/features/requirement/view.tsx";

const group = (status: Group["status"], over: Partial<Group> = {}): Group => ({
  id: 7,
  project_id: 1,
  name: "ship it",
  title: null,
  branch: "feature/ship",
  status,
  owns_json: ["src/**"],
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
  body: "",
  agentId: null,
  ...over,
});

/**
 * One requirement pane, replacing whatever the last call put on the page.
 *
 * These tests walk a requirement through its states by rendering it again with
 * a changed store, and every render shares one `document.body` — so without the
 * `cleanup` the "this is not shown" half of each test would be reading the
 * previous pane.
 */
const render = (state: State, current: Group, tab: string | null = null, frames: PanelFrame[] = []) => {
  cleanup();
  return mount(
    <WithQueries>
      <TipRoot>
        <Requirement st={state} g={current} frames={frames} refresh={() => {}} open tab={tab} />
      </TipRoot>
    </WithQueries>,
  );
};

/** Anything this pane fetches — the evidence diff — stays in flight. */
mockHttp(inFlight());

/**
 * testing-library's own `afterEach(cleanup)` is registered when its module is
 * evaluated, and `bun test` scopes the lifecycle globals per file — so that hook
 * belongs to whichever file imported it first, and every later file kept the
 * previous one's nodes in `document.body`. Each file registers its own.
 */
afterEach(cleanup);

/** Most of these sentences sit inside a longer line, so the match is a substring —
 *  of rendered text, which is what a reader has, rather than of the markup. */

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
  shown(render(draft, draftGroup), "Dispatcher 正在写计划卡");
  draft.draftCards.push({ grpId: 7, body: "## Plan\nShip the slice", at: 1 });
  const filed = render(draft, draftGroup);
  // The card is an editable box that names itself, not a heading over one.
  expect(valueOf(filed.getByLabelText("计划卡"))).toContain("Ship the slice");
  filed.getByRole("button", { name: "批准开工" });
  // And it is rendered beside the source, because a card is a table of slices and
  // a list of acceptance criteria — read as a document while it is amended as
  // text. `## Plan` is a heading in the preview and four characters in the box.
  expect(filed.container.querySelector("h2")?.textContent).toBe("Plan");

  const { st: active, g: activeGroup } = running();
  shown(render(active, activeGroup, "slice"), "正在拆解");
  active.slices.push(slice());
  const review = render(active, activeGroup, "slice");
  shown(review, "Implement review");
  shown(review, "待你查收");

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
  shown(question, "Which compatibility behavior should remain?");
  shown(question, "全组停着");
});

test("the header shows the control that fits the group's state", () => {
  const live = running();
  const head = render(live.st, live.g, "slice");
  shown(head, "ship it");
  shown(head, "feature/ship");
  shown(head, "在跑");
  // The controls are buttons, named — `Pause` as text could have been a caption.
  head.getByRole("button", { name: "暂停" });
  head.getByRole("button", { name: "更多" });

  const paused = running({ status: "PAUSED", pr_number: 4 });
  const stopped = render(paused.st, paused.g, "slice");
  shown(stopped, "已暂停");
  stopped.getByRole("button", { name: "继续" });
  // A closed PR needs a way to file a second one; a branch that was force-pushed
  // cannot be reopened on GitHub at all.
  stopped.getByRole("button", { name: "开新 PR" });

  const parked = running({ status: "PARKED" });
  const asleep = render(parked.st, parked.g, "slice");
  shown(asleep, "已封存");
  asleep.getByRole("button", { name: "唤醒" });
  expect(asleep.queryAllByRole("button", { name: "暂停" })).toHaveLength(0);

  const open = running({ status: "PR_OPEN", pr_number: 9 });
  shown(render(open.st, open.g, "slice"), "排队中");

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
  // A link, not a button: it leaves the panel, and it goes to that PR.
  const link = merging.getByRole("link", { name: /去合并 PR/ });
  expect(link.getAttribute("href")).toBe("https://github.com/acme/orchestrator/pull/9");
  gone(merging, "排队中");
});

test("a group that has spent its budget gets the wall instead of a working 继续", () => {
  const { st, g } = running({ status: "PAUSED", budget_tokens: 1000, spent_tokens: 1000 });
  const wall = render(st, g, "slice");
  shown(wall, "预算用尽，全组挂起");
  wall.getByRole("button", { name: /翻倍到/ });
  wall.getByRole("button", { name: "取消上限" });
  // `Resume` would be a button that changes nothing: the scheduler refuses to admit it.
  expect(wall.queryAllByRole("button", { name: "继续" })).toHaveLength(0);

  const capped = running({ budget_tokens: null });
  shown(render(capped.st, capped.g, "slice"), "无预算上限");
});

test("the rebuild pane reports both steps while it runs and stays up when it fails", () => {
  const { st, g } = running();
  const started = [
    frame({ id: "e1", cls: "state", step: BOOTSTRAP_START, body: "沙箱是新的", at: 1_000 }),
    frame({ id: "e2", body: "$ bun install --frozen-lockfile", at: 2_000 }),
    frame({ id: "e3", body: "resolved 400 packages", at: 3_000 }),
  ];
  const live = render(st, g, "slice", started);
  shown(live, "克隆");
  shown(live, "装依赖");
  shown(live, "bun install --frozen-lockfile");
  shown(live, "resolved 400 packages");
  live.getByRole("button", { name: "收起" });

  const broken = render(st, g, "slice", [
    ...started,
    frame({ id: "e4", cls: "state", step: BOOTSTRAP_FAILED, body: "装失败了", at: 4_000 }),
  ]);
  shown(broken, "装失败了");
  shown(broken, "交给 bootstrap 重试");

  const done = render(st, g, "slice", [
    ...started,
    frame({ id: "e5", cls: "state", step: BOOTSTRAP_OK, body: "装好了", at: 4_000 }),
  ]);
  gone(done, "装依赖");
  // Nothing at all before a rebuild has been asked for.
  gone(render(st, g, "slice"), "克隆");
});

test("each slice row says where it is in its own words", () => {
  const { st, g } = running();
  st.slices.push(
    slice({ id: 1, seq: 1, title: "First", status: "accepted", gates_json: '{"qa":"pass"}', awaiting_at: null }),
    slice({ id: 2, seq: 2, title: "Second", status: "rejected", gates_json: '{"gate":"fail"}', awaiting_at: null }),
    slice({ id: 3, seq: 3, title: "Third", status: "running", gates_json: {}, awaiting_at: null }),
    slice({ id: 4, seq: 4, title: "Fourth", status: "pending", gates_json: {}, awaiting_at: null }),
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
  shown(rows, "等前序切片");
  shown(rows, "已退回，等它修");
  shown(rows, "engineer ▸ 跑测试");
  // Gate names come from the shared stop list, and `Accept` is the boss's own column.
  shown(rows, "自评");
  shown(rows, "对账");
  shown(rows, "测试");
  shown(rows, "查收");
  shown(rows, "S4");

  st.slices[2]!.status = "awaiting_boss";
  st.slices[2]!.awaiting_at = null;
  shown(render(st, g, "slice"), "待你查收");

  // A slice with no agent on it falls back to what it promised.
  st.agents.length = 0;
  st.slices[2]!.status = "running";
  shown(render(st, g, "slice"), "Visible behavior is preserved");
});

test("the open slice shows its tasks over the evidence the verdict answers", () => {
  const { st, g } = running();
  st.slices.push(slice({ id: 3, title: "Ship the panel" }));
  st.tasks.push(
    { id: 1, grp_id: 7, slice_id: 3, title: "Write the model", status: "done" },
    { id: 2, grp_id: 7, slice_id: 3, title: "Render it", status: "pending" },
  );
  const waiting = render(st, g, "slice");
  shown(waiting, "Write the model");
  shown(waiting, "Render it");
  // The two verdict buttons are handed to the evidence panel, which is still
  // fetching the diff they are a verdict on.
  shown(waiting, "读改动…");

  // Nothing has produced anything yet: every row stays shut rather than opening
  // an empty panel in front of the boss.
  st.slices[0]!.status = "pending";
  st.slices[0]!.awaiting_at = null;
  const shut = render(st, g, "slice");
  shown(shut, "等前序切片");
  gone(shut, "Write the model");
});

test("the draft card carries every objection raised against it", () => {
  const st = emptyState();
  const g = group("DRAFT");
  st.groups.push(g);
  st.ideas.push({ grpId: 7, body: "Split the settings view" });
  st.draftCards.push({ grpId: 7, body: "## goal\nship it", at: 1, unknownPaths: '["web/src/gone.tsx"]' });
  st.lateObjections.push({ grpId: 7, author: "architect", body: "The boundary is wrong" });
  const card = render(st, g);
  shown(card, "Split the settings view");
  shown(card, "architect 后补反对");
  shown(card, "The boundary is wrong");
  shown(card, "卡里这些路径仓库里没有");
  shown(card, "web/src/gone.tsx");
  card.getByRole("button", { name: "批准开工" });
  card.getByRole("button", { name: "退回重拆" });

  st.dropProposals.push({ grpId: 7, body: "Already done in #12\nsee the merged PR" });
  const drop = render(st, g);
  shown(drop, "规划岗建议作废");
  shown(drop, "Already done in #12");
  drop.getByRole("button", { name: "确认作废" });
  drop.getByRole("button", { name: "不，接着做" });
});

test("an approved draft says what is holding it instead of asking to approve again", () => {
  const st = emptyState();
  const g = group("DRAFT", { approved_at: 5 });
  st.groups.push(g);
  st.draftCards.push({ grpId: 7, body: "## goal\nship it", at: 1 });
  const held = render(st, g);
  shown(held, "已批·等边界");
  shown(held, "已批准，边界挡着");
  shown(held, "等 Architect 切边界");
  expect(held.queryAllByRole("button", { name: "批准开工" })).toHaveLength(0);

  st.approvedBlocked.push({ grpId: 7, reason: "settings.tsx is owned by 组 3" });
  shown(render(st, g), "settings.tsx is owned by 组 3");
});

test("the question lanes separate what is yours from what the chain is holding", () => {
  const { st, g } = running();
  st.slices.push(slice());
  shown(render(st, g, "ask"), "没有开着的问题");

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
  shown(held, "别人在处理 1");
  shown(held, "Architect 处理中");
  shown(held, "git ls-tree -r main --name-only");
  gone(held, "待你决策");

  st.answered.push({
    id: 31,
    grp_id: 7,
    question: "Which base branch?",
    answer: "main",
    answered_by: "cos",
    ref_note_id: null,
  });
  const delegated = render(st, g, "ask");
  shown(delegated, "替你答过 1");

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
  shown(mine, "待你决策 1");
  shown(mine, "别人在处理 1");
  shown(mine, "替你答过 1");
  shown(mine, "Accept the smaller scope?");
  mine.getByRole("button", { name: /让 AI 拟一份/ });
  mine.getByRole("button", { name: /转 Architect/ });
  mine.getByRole("button", { name: /开成工单/ });
  // The pinned dock is gone while a decision carries its own answer box.
  expect(mine.queryAllByRole("button", { name: /跟这个组说话…/ })).toHaveLength(0);
});

test("the dock and the tab counts follow what the requirement holds", () => {
  const { st, g } = running();
  st.slices.push(slice({ id: 1, seq: 1 }), slice({ id: 2, seq: 2, status: "running", awaiting_at: null }));
  const tabs = render(st, g, "slice");
  // Five tabs, in order, with `Slice` the one that is open — none of which a
  // substring of the markup could distinguish from a heading. `Time` carries no
  // count on purpose: a span total is not a quantity anybody is waiting on.
  expect(tabs.getAllByRole("tab").map((t) => t.textContent)).toEqual(["切片2", "问题0", "记录", "工作区", "耗时"]);
  expect(tabs.getByRole("tab", { selected: true }).textContent).toBe("切片2");
  // At rest the dock is one line that says where the words go.
  tabs.getByRole("button", { name: "跟这个组说话… ⌘Enter 发给 PM" });
});

test("the heading is the written title, and the slug where nothing wrote one", () => {
  const { st, g } = running({ title: "登录表单加一个「记住我」勾选框" });
  shown(render(st, g), "登录表单加一个「记住我」勾选框");
  gone(render(st, g), "ship it");

  const untitled = running();
  shown(render(untitled.st, untitled.g), "ship it");
});
