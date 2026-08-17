import { afterEach, expect, test } from "bun:test";
import { cleanup, render as mount } from "../support/render.tsx";
import { projectRow } from "../../web/src/features/home/model.ts";
import { ringArc, ringTip, ringView, staleMark, until } from "../../web/src/features/usage/model.ts";
import { emptyState, type State } from "../../web/src/shared/api.ts";
import { TipRoot } from "../../web/src/ui/tooltip.tsx";
import { UsageBar } from "../../web/src/features/usage/view.tsx";
import { Home } from "../../web/src/features/home/view.tsx";

/**
 * testing-library's own `afterEach(cleanup)` is registered when its module is
 * evaluated, and `bun test` scopes the lifecycle globals per file — so that hook
 * belongs to whichever file imported it first, and every later file kept the
 * previous one's nodes in `document.body`. Each file registers its own.
 */
afterEach(cleanup);

/**
 * The two surfaces the boss reads before deciding what to start: which project
 * wants something, and whether an account has the budget to finish it.
 *
 * Both were assembled inline, so the rules that decide what a row says — which
 * counts are worth printing, which window is out of fuel — had no way to be
 * asserted apart from the markup they ended up in.
 */

const project = (id: number, name: string) => ({
  id,
  name,
  repo_path: `pamin-labs/${name}`,
  remote: null,
  base_branch: "main",
});

const group = (id: number, projectId: number, over: Partial<State["groups"][number]> = {}) => ({
  id,
  project_id: projectId,
  name: `需求${id}`,
  branch: null,
  status: "PARKED" as const,
  owns_json: "[]",
  budget_tokens: null,
  spent_tokens: 0,
  pr_number: null,
  approved_at: null,
  ...over,
});

const home = (st: State) => {
  cleanup();
  return mount(
    <TipRoot>
      <Home st={st} onEnter={() => {}} onOpen={() => {}} onNew={() => {}} onAdd={() => {}} refresh={() => {}} />
    </TipRoot>,
  );
};

/** These sit inside longer lines, so the match is a substring of the rendered text. */
const shown = (r: ReturnType<typeof home>, text: string) =>
  expect(r.getAllByText(text, { exact: false }).length).toBeGreaterThan(0);
const gone = (r: ReturnType<typeof home>, text: string) =>
  expect(r.queryAllByText(text, { exact: false })).toHaveLength(0);

test("a project row prints only the counts that are facts", () => {
  const st = emptyState();
  st.projects.push(project(1, "alpha"));
  st.groups.push(group(1, 1, { spent_tokens: 1200 }), group(2, 1, { status: "RUNNING", name: "在跑的" }));
  const page = home(st);

  // 2 需求 and 1.2k tokens are the row's right edge, and both exist here.
  shown(page, "2 个需求");
  shown(page, "1.2k tokens");
  // A running requirement names itself, so the boss knows what is spending.
  shown(page, "在跑：在跑的");
  shown(page, "1 个在跑");
});

test("a project with nothing spent prints neither a zero count nor a zero spend", () => {
  const st = emptyState();
  st.projects.push(project(1, "alpha"));
  const page = home(st);

  // 0 个需求 next to 空着 is the same absence twice.
  gone(page, "0 个需求");
  gone(page, "0 tokens");
  // A project nothing was ever asked of carries its own action instead of a state.
  page.getByRole("button", { name: "＋ 新需求" });
  gone(page, "空着");
});

test("waiting work replaces the project's state line and lists what is waiting", () => {
  const st = emptyState();
  st.projects.push(project(1, "alpha"));
  st.groups.push(group(1, 1, { status: "DRAFT" }));
  st.draftCards.push({ grpId: 1, body: "目标: 做完它", at: 1000, unknownPaths: null });
  st.escalations.push({
    id: 7,
    grp_id: 1,
    severity: "normal",
    question: "选哪个",
    chain_state: "boss",
    brief: "选哪个",
    kind: "spec",
    answered_by: null,
    answer: null,
    created_at: 1000,
    asker: "dev",
    asker_project: 1,
  });
  const page = home(st);

  shown(page, "1 张卡待批");
  shown(page, "1 个提问");
  // The counts that are zero stay off the line entirely.
  gone(page, "片待查收");
  gone(page, "个待合入");
});

test("the project wanting the boss most is read first", () => {
  const st = emptyState();
  st.projects.push(project(1, "quiet"), project(2, "loud"));
  st.groups.push(group(1, 2, { status: "DRAFT" }));
  st.draftCards.push({ grpId: 1, body: "目标: 做完它", at: 1000, unknownPaths: null });
  const page = home(st);

  // Document order, not string offsets: the row that wants something comes first.
  const repos = page.getAllByText(/pamin-labs\//).map((el) => el.textContent);
  expect(repos).toEqual(["pamin-labs/loud", "pamin-labs/quiet"]);
});

const usage = (rows: State["usage"]) => {
  cleanup();
  return mount(
    <TipRoot>
      <UsageBar usage={rows} />
    </TipRoot>,
  );
};

test("a window past the warning line is the only thing on the bar in warn tone", () => {
  const bar = usage([{ runtime: "claude", at: Date.now(), fiveHourPercent: 81, weeklyPercent: 79 }]);
  // 81 is over, 79 is not, so exactly one of the two labels carries the warning.
  // The warning is a colour on that label, so it is counted on the labels.
  expect(bar.container.querySelectorAll(".text-warn").length).toBe(1);
  expect(bar.getByText("5h").className).toContain("text-warn");
  expect(bar.getByText("周").className).not.toContain("text-warn");
});

test("a window the plan does not have holds its column open and says nothing", () => {
  const bar = usage([{ runtime: "claude", at: Date.now(), fiveHourPercent: 42 }]);
  // The weekly cell is present but empty: an empty ring plus a dash would claim
  // the read failed, when the truth is the window does not exist on that plan.
  bar.getByText("5h");
  expect(bar.queryAllByText("周")).toHaveLength(0);
  expect(bar.queryAllByText("?")).toHaveLength(0);
  // Present, and hidden from a screen reader rather than announced as an empty
  // cell: the grid still needs its third column.
  expect(bar.container.querySelectorAll("[aria-hidden]").length).toBe(1);
});

test("a failed read stays quiet until it is old enough to be wrong", () => {
  const fresh = usage([{ runtime: "codex", at: Date.now(), error: "unreachable" }]);
  expect(fresh.queryAllByText("?")).toHaveLength(0);

  const old = usage([{ runtime: "codex", at: Date.now() - 2 * 60 * 60_000, error: "unreachable" }]);
  expect(old.getAllByText("?").length).toBeGreaterThan(0);
});

test("an account with no window and no failure gets no bar at all", () => {
  expect(usage([{ runtime: "claude", at: Date.now() }]).container.innerHTML).toBe("");
});

test("the tooltip carries the digits the ring cannot, and the reason when there are none", () => {
  const now = Date.now();
  // Rounded percentage, the reset, and the age only once the age is the news.
  expect(ringTip({ v: 12.4, at: Math.round(now / 1000) + 3 * 3600 + 12 * 60 + 30, read: now, stale: false })).toBe(
    "12% · 3h12m后重置",
  );
  expect(ringTip({ v: 66, read: now - 20 * 60_000, stale: false })).toBe("66% · 20m 前");
  // A reset three days out is not worth a minute count.
  expect(until(Math.round(now / 1000) + 2 * 86_400 + 4 * 3600 + 30)).toBe("2天4h");
  expect(until(Math.round(now / 1000) - 60)).toBe("即将重置");
  expect(until()).toBe("");

  // A failure names itself; an unknown code still says something.
  expect(ringTip({ why: "rate_limited", stale: true })).toBe("读用量被限流了，过一会自己恢复");
  expect(ringTip({ why: "boom", stale: true })).toBe("读不到");
  expect(ringTip({ stale: true })).toBe("读不到");
});

test("the arc never collapses to nothing and never overruns the circle", () => {
  const full = ringArc(100);
  // A 0% window still shows a mark: an arc of zero length reads as a failed draw.
  expect(ringArc(0)).toBe(ringArc(2));
  expect(ringArc(150)).toBe(full);
  expect(ringArc(undefined)).toBeNull();

  // Only a reading past the line is hot, and a missing one is never hot.
  expect(ringView({ v: 80, stale: false })?.hot).toBe(true);
  expect(ringView({ v: 79.9, stale: false })?.hot).toBe(false);
  expect(ringView({ stale: true })?.hot).toBe(false);
  expect(ringView({ stale: false })).toBeNull();
});

test("a read only counts as stale once it is an hour old, and only when it failed", () => {
  const at = Date.now() - 2 * 60 * 60_000;
  expect(staleMark({ runtime: "claude", at, error: "unreachable" })).toBe(true);
  // An old reading that succeeded is just an old reading.
  expect(staleMark({ runtime: "claude", at })).toBe(false);
  expect(staleMark({ runtime: "claude", at: Date.now(), error: "unreachable" })).toBe(false);
});

test("a project's row data is decided before anything is drawn", () => {
  const st = emptyState();
  st.projects.push(project(1, "alpha"));
  st.groups.push(
    group(1, 1, { spent_tokens: 1200, status: "PLANNING", name: "在想" }),
    group(2, 1, { status: "PAUSED", name: "停了" }),
  );
  const row = projectRow(st, 1);
  // PLANNING counts as running on this line; PAUSED does not.
  expect(row.live).toEqual(["在想"]);
  expect(row.meta).toEqual(["2 个需求", "1.2k tokens"]);
  expect(row.bits).toEqual([]);
  expect(row.n).toBe(0);

  // A project with no group at all has neither a count nor a spend to print.
  st.projects.push(project(2, "beta"));
  expect(projectRow(st, 2).meta).toEqual([]);
});
