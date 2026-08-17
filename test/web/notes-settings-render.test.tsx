import { afterEach, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  isDisabled,
  render as mount,
  restoreFetch,
  stubFetch,
  valueOf,
} from "../support/render.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { PanelNote } from "../../src/contracts/panel.ts";
import { matchSkills, skillTally } from "../../web/src/features/skills/model.ts";
import { Combobox, committed } from "../../web/src/ui/combobox.tsx";
import { switchRow } from "../../web/src/ui/switcher.tsx";
import { isThemeHotkey, ThemeChoice } from "../../web/src/ui/theme.tsx";
import type { Skill } from "../../web/src/ui/composer.tsx";
import { TipRoot } from "../../web/src/ui/tooltip.tsx";
import { NotesBoard } from "../../web/src/views/notes.tsx";
import { SandboxServerSettings, visibleSection } from "../../web/src/views/settings.tsx";
import { CredPane } from "../../web/src/views/settings/credentials.tsx";
import { Skills } from "../../web/src/views/skills.tsx";

/**
 * The panes the boss configures, and the blackboard they read memory from.
 *
 * None of them had a render test, so a note whose gate verdict rendered as the
 * raw word `fail`, an account row that stopped saying which mode is stored, a
 * skills header that counted a repository skill as staged, and a base-branch box
 * that accepted a branch nobody has, all looked exactly like working code. The
 * controls those panes are built from — the combobox, the theme segments, the
 * switcher's rows — are here for the same reason.
 */

const render = (node: ReactNode) => mount(<TipRoot>{node}</TipRoot>);

/**
 * testing-library's own `afterEach(cleanup)` is registered when its module is
 * evaluated, and `bun test` scopes the lifecycle globals per file — so that hook
 * belongs to whichever file imported it first, and every later file kept the
 * previous one's nodes in `document.body`. Each file registers its own.
 */
afterEach(() => {
  cleanup();
  restoreFetch();
});

const note = (over: Partial<PanelNote> = {}): PanelNote => ({
  id: 1,
  grpId: 7,
  kind: "journal",
  body: "改完了导出路径",
  at: 1_700_000_000_000,
  exportPath: null,
  frontmatter: null,
  group: null,
  ...over,
});

test("a blackboard with no read behind it says so, and an empty one says why", () => {
  const reading = render(<NotesBoard notes={null} />);
  expect(reading.getByText("读记录…")).toBeTruthy();
  reading.unmount();

  const empty = render(<NotesBoard notes={[]} />);
  expect(empty.getByText(/还没有记录/)).toBeTruthy();
  expect(empty.getByText(/retro 归纳成教训注入后续组/)).toBeTruthy();
});

test("inside one requirement the kinds are badges on a single list, not tabs", () => {
  const { getByText, queryAllByRole } = render(
    <NotesBoard compact notes={[note({ kind: "journal" }), note({ id: 2, kind: "retro", body: "这组的复盘" })]} />,
  );
  expect(getByText("日志")).toBeTruthy();
  expect(getByText("复盘")).toBeTruthy();
  expect(getByText("这组的复盘")).toBeTruthy();
  // A compact list has no tab strip: four tabs with one row each is worse than none.
  expect(queryAllByRole("tablist")).toHaveLength(0);
});

test("the board tabs only the kinds that exist, and counts each one", () => {
  const { getAllByRole, getByRole, queryAllByRole } = render(
    <NotesBoard
      notes={[
        note({ id: 1, kind: "journal" }),
        note({ id: 2, kind: "journal", body: "第二条日志" }),
        note({ id: 3, kind: "lesson", body: "别再并行改同一个文件" }),
      ]}
    />,
  );
  expect(getByRole("tablist")).toBeTruthy();
  // Two tabs, each carrying its own count — and the one that is open says so,
  // which no string of markup could.
  expect(getAllByRole("tab").map((t) => t.textContent)).toEqual(["日志2", "教训1"]);
  expect(getByRole("tab", { selected: true }).textContent).toBe("日志2");
  // Kinds nobody wrote get no tab at all.
  expect(queryAllByRole("tab", { name: /入职包/ })).toHaveLength(0);
  expect(queryAllByRole("tab", { name: /老板说的/ })).toHaveLength(0);
});

test("a note's deterministic anchors are rendered beside the prose they check", () => {
  const { getByText } = render(
    <NotesBoard
      compact
      notes={[
        note({
          group: "把导出路径挪走",
          exportPath: "docs/journal/把导出路径挪走/020-journal.md",
          frontmatter: JSON.stringify({ gate: "pass", files: ["src/mech/notes.ts", "web/src/views/notes.tsx"] }),
        }),
      ]}
    />,
  );
  expect(getByText(/闸门 过/)).toBeTruthy();
  expect(getByText("src/mech/notes.ts")).toBeTruthy();
  expect(getByText("web/src/views/notes.tsx")).toBeTruthy();
  // The export path is a hover, not sixty characters of header.
  expect(getByText("md")).toBeTruthy();
  expect(getByText("把导出路径挪走")).toBeTruthy();
});

test("a failed gate is named in the boss's words, an unknown one in the server's", () => {
  const fail = render(<NotesBoard compact notes={[note({ frontmatter: JSON.stringify({ gate: "fail" }) })]} />);
  const verdict = fail.getByText(/闸门 没过/);
  // The failure is carried by colour on that word, so the check is on that
  // element rather than on the document holding the class anywhere.
  expect(verdict.className).toContain("text-bad");
  fail.unmount();

  // A verdict this panel has no word for is passed through rather than swallowed.
  const other = render(<NotesBoard compact notes={[note({ frontmatter: JSON.stringify({ gate: "skipped" }) })]} />);
  expect(other.getByText(/闸门 skipped/)).toBeTruthy();
});

test("a note with nothing to check against renders no anchor row at all", () => {
  const { queryAllByText } = render(
    <NotesBoard compact notes={[note({ frontmatter: JSON.stringify({ files: [] }) })]} />,
  );
  expect(queryAllByText(/闸门/)).toHaveLength(0);
  expect(queryAllByText("md")).toHaveLength(0);
});

test("a long note is clamped until the reader opens it; a short one is never clamped", () => {
  const body = "一".repeat(400);
  const long = render(<NotesBoard compact notes={[note({ body })]} />);
  const clamped = () => long.container.querySelectorAll(".line-clamp-4").length;
  expect(long.getByText(body)).toBeTruthy();
  expect(clamped()).toBe(1);
  // Pressing it is now something a test can do: the clamp comes off and the
  // control turns into its own way back.
  fireEvent.click(long.getByRole("button", { name: "展开" }));
  expect(clamped()).toBe(0);
  expect(long.getByRole("button", { name: "收起" })).toBeTruthy();
  long.unmount();

  const short = render(<NotesBoard compact notes={[note({ body: "两行\n就两行" })]} />);
  expect(short.queryAllByRole("button", { name: "展开" })).toHaveLength(0);
});

test("a list longer than the page says how much is left rather than dropping it", () => {
  const many = Array.from({ length: 15 }, (_, i) => note({ id: i + 1, body: `第 ${i + 1} 条` }));
  const { getByRole, getByText, queryAllByText } = render(<NotesBoard notes={many} />);
  const more = getByRole("button", { name: "还有 3 条（共 15）" });
  expect(getByText("第 12 条")).toBeTruthy();
  expect(queryAllByText("第 13 条")).toHaveLength(0);
  // And the rest is one press away rather than gone.
  fireEvent.click(more);
  expect(getByText("第 15 条")).toBeTruthy();
});

test("a section only a project has falls back to an account pane when there is no project", () => {
  // The hash keeps asking for the section it was written with, so a link to a
  // project pane opened without a project must land somewhere real.
  expect(visibleSection("remove", null)).toBe("cred");
  expect(visibleSection("gates", null)).toBe("cred");
  expect(visibleSection("sandbox", null)).toBe("cred");
  // With a project, and for every server-wide section, the ask is honoured.
  expect(visibleSection("remove", 3)).toBe("remove");
  expect(visibleSection("server", null)).toBe("server");
});

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

test("the sandbox server pane comes up reading rather than claiming a state", () => {
  stubFetch();
  const { getAllByText, getByText } = mount(
    <QueryClientProvider client={client()}>
      <TipRoot>
        <SandboxServerSettings open section="server" rows={[]} checks={[]} onSaved={() => {}} />
      </TipRoot>
    </QueryClientProvider>,
  );
  expect(getByText("沙盒服务器")).toBeTruthy();
  expect(getByText(/开容器的那个服务/)).toBeTruthy();
  expect(getAllByText("读取中…").length).toBeGreaterThan(0);
});

test("an account with nothing stored says so and offers both ways to fill it", () => {
  stubFetch();
  const { getAllByText, getByPlaceholderText, getByText } = render(
    <CredPane rows={[]} onSaved={() => {}} onWaitForLogin={() => {}} />,
  );
  expect(getByText("模型账号")).toBeTruthy();
  expect(getByText(/真令牌不进沙盒/)).toBeTruthy();
  // Both runtimes, both unconfigured, each with its own way in.
  expect(getByText("Claude")).toBeTruthy();
  expect(getByText("Codex")).toBeTruthy();
  expect(getAllByText("没配")).toHaveLength(2);
  expect(getAllByText(/登录/).length).toBeGreaterThan(0);
  expect(getByPlaceholderText("粘贴进来，存下之后看不到")).toBeTruthy();
  expect(getAllByText(/API 地址/).length).toBeGreaterThan(0);
});

test("a stored credential shows its tail and stops re-explaining how to get one", () => {
  stubFetch();
  const { getAllByText, getByPlaceholderText, getByText, queryAllByText } = render(
    <CredPane
      rows={[{ runtime: "claude", mode: "oauth_token", hint: "…7f21", updatedAt: 1_700_000_000_000 }]}
      prefs={{ claudeCoauthor: true }}
      onSaved={() => {}}
      onWaitForLogin={() => {}}
    />,
  );
  expect(getByPlaceholderText("已存 …7f21，粘新的就换掉")).toBeTruthy();
  expect(getByText("清掉")).toBeTruthy();
  // Instructions for a decision already made are gone for the configured row.
  expect(queryAllByText(/容器里跑 claude setup-token/)).toHaveLength(0);
  // Codex is still unconfigured, so its instructions stay.
  expect(getByText(/在容器里登录，本机不用装 codex/)).toBeTruthy();
  // Only Claude's CLI has a commit trailer to switch.
  expect(getAllByText(/Co-author/)).toHaveLength(1);
});

test("a login in flight disables the button that started it", () => {
  stubFetch();
  const { getAllByText, getByRole } = render(
    <CredPane rows={[]} waiting="claude" onSaved={() => {}} onWaitForLogin={() => {}} />,
  );
  expect(getAllByText("等你在浏览器里批准…")).toHaveLength(1);
  // The one waiting refuses to be pressed again; the other runtime's is still live.
  expect(isDisabled(getByRole("button", { name: "等你在浏览器里批准…" }))).toBe(true);
});

test("the skills pane says nothing about counts until the read lands", () => {
  stubFetch();
  const { getByPlaceholderText, getByRole, getByText, queryAllByText } = render(<Skills projectId={1} />);
  expect(getByText("技能")).toBeTruthy();
  expect(getByText("读取中…")).toBeTruthy();
  expect(getByRole("button", { name: "重新扫描" })).toBeTruthy();
  expect(getByPlaceholderText("搜技能")).toBeTruthy();
  // No "0/0 个进沙盒" before anything is known.
  expect(queryAllByText(/进沙盒/)).toHaveLength(0);
});

const skill = (name: string, over: Partial<Skill> = {}): Skill => ({
  name,
  description: `${name} 干的事`,
  path: `/skills/${name}`,
  scope: "user",
  on: false,
  ...over,
});

test("a repository skill is never counted as staged, but is still counted as prefix", () => {
  const tally = skillTally([
    skill("a", { on: true }),
    skill("b"),
    // Project skills have no tick box: they live in the checkout the CLI runs in.
    skill("c", { scope: "project", on: true }),
  ]);
  expect(tally.staged).toBe(1);
  expect(tally.user).toBe(2);
  expect(tally.repo).toBe(1);
});

test("the token estimate counts the repository's skills too, and only the ticked ones", () => {
  const description = "描".repeat(400);
  const ticked = { on: true, description };
  const both = skillTally([skill("a", ticked), skill("c", { ...ticked, scope: "project" })]);
  const userOnly = skillTally([skill("a", ticked)]);
  // Both kinds land in the cached prefix of every turn, so both are in the estimate.
  expect(userOnly.k).toBeGreaterThan(0);
  expect(both.k).toBeGreaterThan(userOnly.k);
  // Unticked skills are not mounted, so they cost nothing.
  expect(skillTally([skill("a", { description }), skill("b", { description })]).k).toBe(0);
});

test("a skill is found by what it does, not only by what it is called", () => {
  const rows = [skill("deploy"), skill("commit", { description: "写 conventional commit 消息" })];
  expect(matchSkills(rows, "conventional").map((r) => r.name)).toEqual(["commit"]);
  expect(matchSkills(rows, "DEPLOY").map((r) => r.name)).toEqual(["deploy"]);
  // An empty box is not a filter that matches nothing.
  expect(matchSkills(rows, "   ")).toHaveLength(2);
  expect(matchSkills(rows, "没有这个")).toHaveLength(0);
});

test("the base-branch field is a text box that already carries its value", async () => {
  const { findAllByRole, getByRole, queryAllByRole } = render(
    <Combobox value="main" options={["main", "release/1"]} placeholder="选分支" onCommit={() => {}} />,
  );
  const box = getByRole("combobox");
  expect(valueOf(box)).toBe("main");
  expect(box.getAttribute("placeholder")).toBe("选分支");
  // The list is portalled, so on a server it was never rendered and never
  // asserted. It is shut until the box is reached for, and then it is the known
  // branches, in order.
  expect(queryAllByRole("listbox")).toHaveLength(0);
  fireEvent.focus(box);
  // Awaited, not read on the next line: Radix positions the popper over a
  // ResizeObserver and a frame, so the synchronous read saw the list before it
  // settled — passing on timing rather than on the list being right.
  const options = await findAllByRole("option");
  expect(options.map((o) => o.textContent)).toEqual(["main", "release/1"]);
});

test("a branch that does not exist is refused, and the field snaps back", () => {
  // The list is the authority: a base branch that is not there fails at clone
  // time four steps later, so it never becomes a stored value.
  expect(committed("nope", "main", ["main", "dev"])).toEqual({ draft: "main", commit: null });
  expect(committed(" dev ", "main", ["main", "dev"])).toEqual({ draft: "dev", commit: "dev" });
  // Re-committing what is already stored writes nothing.
  expect(committed("main", "main", ["main", "dev"])).toEqual({ draft: "main", commit: null });
});

test("with nothing to check against, or a free field, what was typed is kept", () => {
  // No GitHub credential, rate limited, API down: refusing everything would let
  // an unreachable API lock a settings field.
  expect(committed("feature/x", "main", [])).toEqual({ draft: "feature/x", commit: "feature/x" });
  // A model id only ever enters the config by being typed somewhere first.
  expect(committed("claude-opus-5", "claude-sonnet-5", ["claude-sonnet-5"], true)).toEqual({
    draft: "claude-opus-5",
    commit: "claude-opus-5",
  });
});

test("the theme control says all three states, including the one a toggle cannot", () => {
  const { getAllByRole } = render(<ThemeChoice />);
  // Three segments, and exactly one of them lit: a two-state toggle cannot hold
  // 跟随系统 at all, and which one is chosen is `aria-checked`, not a class.
  expect(getAllByRole("radio").map((r) => r.textContent)).toEqual(["跟随系统", "浅色", "深色"]);
  expect(getAllByRole("radio", { checked: true })).toHaveLength(1);
});

test("only ⌘⇧L cycles the theme", () => {
  const chord = { metaKey: false, ctrlKey: false, shiftKey: true, key: "L" };
  expect(isThemeHotkey({ ...chord, metaKey: true })).toBe(true);
  expect(isThemeHotkey({ ...chord, ctrlKey: true })).toBe(true);
  // Lower case arrives when shift is reported separately by the platform.
  expect(isThemeHotkey({ ...chord, metaKey: true, key: "l" })).toBe(true);
  // Every near miss is a miss: this shortcut sits next to ⌘L and ⇧L.
  expect(isThemeHotkey(chord)).toBe(false);
  expect(isThemeHotkey({ ...chord, metaKey: true, shiftKey: false })).toBe(false);
  expect(isThemeHotkey({ ...chord, metaKey: true, key: "k" })).toBe(false);
});

test("a switcher row is filterable by its second line, and fills only the cells it has", () => {
  // cmdk filters on `value`, so typing a repository path has to find the project.
  expect(switchRow({ id: 1, name: "阿尔法", meta: "pamin-labs/alpha", rtlMeta: true })).toEqual({
    value: "阿尔法 pamin-labs/alpha",
    meta: "pamin-labs/alpha",
    dir: "rtl",
    badge: null,
  });
  // No meta means no dimmed line and nothing to search but the name.
  expect(switchRow({ id: 2, name: "贝塔", badge: "2 个在跑" })).toEqual({
    value: "贝塔 ",
    meta: null,
    dir: undefined,
    badge: "2 个在跑",
  });
});
