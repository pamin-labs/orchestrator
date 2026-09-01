import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, isDisabled, render as mount, valueOf, waitFor } from "../support/render.tsx";
import { HttpResponse, http } from "msw";
import { inFlight, mockHttp } from "../support/http.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { PanelNote } from "../../src/contracts/notes.ts";
import { searchSkills, skillTally } from "../../web/src/features/skills/model.ts";
import { Combobox, committed } from "../../web/src/ui/combobox.tsx";
import { switchRow } from "../../web/src/features/navigation/switcher.tsx";
import { isThemeHotkey, ThemeChoice } from "../../web/src/ui/theme.tsx";
import type { Skill } from "../../web/src/features/composer/view.tsx";
import { TipRoot } from "../../web/src/ui/tooltip.tsx";
import { WithQueries } from "./queries.tsx";
import { NotesBoard } from "../../web/src/features/notes/view.tsx";
import { SandboxServerSettings, visibleSection } from "../../web/src/features/settings/view.tsx";
import { CredPane, httpsOnly } from "../../web/src/features/settings/credentials.tsx";
import { Skills } from "../../web/src/features/skills/view.tsx";

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

const render = (node: ReactNode) =>
  mount(
    <WithQueries>
      <TipRoot>{node}</TipRoot>
    </WithQueries>,
  );

/**
 * testing-library's own `afterEach(cleanup)` is registered when its module is
 * evaluated, and `bun test` scopes the lifecycle globals per file — so that hook
 * belongs to whichever file imported it first, and every later file kept the
 * previous one's nodes in `document.body`. Each file registers its own.
 */
afterEach(cleanup);

/** Each of these panes reads on mount and is asserted in the state before that
 *  read lands, so every request stays in flight. */
/** The one request this file answers, and only it: the login link, plus a flag
 *  the popup-ordering test reads to say whether the reply had landed yet. */
const login = { replied: false, link: "https://claude.com/cai/oauth/authorize?code=true&client_id=x" };
mockHttp(
  http.post("*/api/v1/auth/claude/login", () => {
    login.replied = true;
    return HttpResponse.json({ url: login.link, expiresAt: Date.now() + 600_000 });
  }),
  inFlight(),
);

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
  reading.getByText("读记录…");
  reading.unmount();

  const empty = render(<NotesBoard notes={[]} />);
  empty.getByText(/还没有记录/);
  empty.getByText(/retro 归纳成教训注入后续组/);
});

test("inside one requirement the kinds are badges on a single list, not tabs", () => {
  const { getByText, queryAllByRole } = render(
    <NotesBoard compact notes={[note({ kind: "journal" }), note({ id: 2, kind: "retro", body: "这组的复盘" })]} />,
  );
  getByText("工作日志");
  getByText("复盘");
  getByText("这组的复盘");
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
  getByRole("tablist");
  // Two tabs, each carrying its own count — and the one that is open says so,
  // which no string of markup could.
  expect(getAllByRole("tab").map((t) => t.textContent)).toEqual(["工作日志2", "教训1"]);
  expect(getByRole("tab", { selected: true }).textContent).toBe("工作日志2");
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
  getByText(/闸门 过/);
  getByText("src/mech/notes.ts");
  getByText("web/src/views/notes.tsx");
  // The export path is a hover, not sixty characters of header.
  getByText("md");
  getByText("把导出路径挪走");
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
  other.getByText(/闸门 skipped/);
});

test("a note with nothing to check against renders no anchor row at all", () => {
  const { queryAllByText } = render(
    <NotesBoard compact notes={[note({ frontmatter: JSON.stringify({ files: [] }) })]} />,
  );
  expect(queryAllByText(/闸门/)).toHaveLength(0);
  expect(queryAllByText("md")).toHaveLength(0);
});

/**
 * happy-dom lays nothing out, so `scrollHeight` and `clientHeight` are both 0
 * and a component that *measures* its clamp can never see one.
 *
 * The disclosure used to guess from `text.length`, which a test could satisfy by
 * passing a long string — and which was wrong for the reader this product mostly
 * has: at `line-clamp-4` a CJK glyph is about two columns, so a note between
 * ~145 and 320 characters was clamped with no way to open it. It asks the
 * browser now, so the test has to supply the answer a browser would.
 */
const overflowing = (yes: boolean) => {
  const of = (h: number) => ({ configurable: true, get: () => h });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", of(100));
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", of(yes ? 400 : 100));
};

afterEach(() => {
  for (const p of ["clientHeight", "scrollHeight"]) Reflect.deleteProperty(HTMLElement.prototype, p);
});

test("a note that overflows its clamp offers the way in; one that fits does not", () => {
  const body = "一".repeat(400);
  overflowing(true);
  const long = render(<NotesBoard compact notes={[note({ body })]} />);
  const clamped = () => long.container.querySelectorAll(".line-clamp-4").length;
  long.getByText(body);
  expect(clamped()).toBe(1);
  // Pressing it is now something a test can do: the clamp comes off and the
  // control turns into its own way back.
  fireEvent.click(long.getByRole("button", { name: "展开" }));
  expect(clamped()).toBe(0);
  long.getByRole("button", { name: "收起" });
  long.unmount();

  overflowing(false);
  const short = render(<NotesBoard compact notes={[note({ body: "两行\n就两行" })]} />);
  expect(short.queryAllByRole("button", { name: "展开" })).toHaveLength(0);
});

test("a list longer than the page says how much is left rather than dropping it", () => {
  const many = Array.from({ length: 15 }, (_, i) => note({ id: i + 1, body: `第 ${i + 1} 条` }));
  const { getByRole, getByText, queryAllByText } = render(<NotesBoard notes={many} />);
  const more = getByRole("button", { name: "还有 3 条（共 15）" });
  getByText("第 12 条");
  expect(queryAllByText("第 13 条")).toHaveLength(0);
  // And the rest is one press away rather than gone.
  fireEvent.click(more);
  getByText("第 15 条");
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
  const { getAllByText, getByText } = mount(
    <QueryClientProvider client={client()}>
      <TipRoot>
        <SandboxServerSettings open section="server" rows={[]} checks={[]} onSaved={() => {}} />
      </TipRoot>
    </QueryClientProvider>,
  );
  getByText("沙箱服务器");
  getByText(/开容器的那个服务/);
  expect(getAllByText("读取中…").length).toBeGreaterThan(0);
});

test("an account with nothing stored says so and offers both ways to fill it", () => {
  const { getAllByText, getByPlaceholderText, getByText } = render(
    <CredPane rows={[]} onSaved={() => {}} onWaitForLogin={() => {}} />,
  );
  getByText("模型账号");
  getByText(/真令牌不进沙箱/);
  // Both runtimes, both unconfigured, each with its own way in.
  getByText("Claude");
  getByText("Codex");
  expect(getAllByText("没配")).toHaveLength(2);
  expect(getAllByText(/登录/).length).toBeGreaterThan(0);
  getByPlaceholderText("粘贴进来，存下之后看不到");
  expect(getAllByText(/API 地址/).length).toBeGreaterThan(0);
});

test("a stored credential shows its tail and stops re-explaining how to get one", () => {
  const { getAllByText, getByPlaceholderText, getByText, queryAllByText } = render(
    <CredPane
      rows={[{ runtime: "claude", mode: "oauth_token", hint: "…7f21", updatedAt: 1_700_000_000_000 }]}
      prefs={{ claudeCoauthor: true }}
      onSaved={() => {}}
      onWaitForLogin={() => {}}
    />,
  );
  getByPlaceholderText("已存 …7f21，粘新的就换掉");
  getByText("清掉");
  // Instructions for a decision already made are gone for the configured row.
  expect(queryAllByText(/容器里跑 claude setup-token/)).toHaveLength(0);
  // Codex is still unconfigured, so its instructions stay.
  getByText(/在容器里登录，本机不用装 codex/);
  // Only Claude's CLI has a commit trailer to switch.
  expect(getAllByText(/Co-author/)).toHaveLength(1);
});

test("a login in flight disables the button that started it", () => {
  const { getAllByText, getByRole } = render(
    <CredPane rows={[]} waiting="claude" onSaved={() => {}} onWaitForLogin={() => {}} />,
  );
  expect(getAllByText("等你在浏览器里批准…")).toHaveLength(1);
  // The one waiting refuses to be pressed again; the other runtime's is still live.
  expect(isDisabled(getByRole("button", { name: "等你在浏览器里批准…" }))).toBe(true);
});

test("the skills pane says nothing about counts until the read lands", () => {
  const { getByPlaceholderText, getByRole, getByText, queryAllByText } = render(<Skills projectId={1} />);
  getByText("技能");
  getByText("读取中…");
  getByRole("button", { name: "重新扫描" });
  getByPlaceholderText("搜技能");
  // No "0/0 个进沙箱" before anything is known.
  expect(queryAllByText(/进沙箱/)).toHaveLength(0);
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
  expect(searchSkills(rows, "conventional").map((r) => r.name)).toEqual(["commit"]);
  expect(searchSkills(rows, "DEPLOY").map((r) => r.name)).toEqual(["deploy"]);
  // An empty box is not a filter that matches nothing.
  expect(searchSkills(rows, "   ")).toHaveLength(2);
  expect(searchSkills(rows, "没有这个")).toHaveLength(0);
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
  // `Follow the system` at all, and which one is chosen is `aria-checked`, not a class.
  expect(getAllByRole("radio").map((r) => r.textContent)).toEqual(["跟随系统", "浅色", "深色"]);
  expect(getAllByRole("radio", { checked: true })).toHaveLength(1);
});

describe("only ⌘⇧L cycles the theme", () => {
  const chord = { metaKey: false, ctrlKey: false, shiftKey: true, key: "L" };
  test.each([
    ["⌘⇧L", { ...chord, metaKey: true }, true],
    ["⌃⇧L", { ...chord, ctrlKey: true }, true],
    // Lower case arrives when shift is reported separately by the platform.
    ["⌘⇧l, shift reported separately", { ...chord, metaKey: true, key: "l" }, true],
    // Every near miss is a miss: this shortcut sits next to ⌘L and ⇧L.
    ["⇧L with no modifier", chord, false],
    ["⌘L without shift", { ...chord, metaKey: true, shiftKey: false }, false],
    ["⌘⇧K", { ...chord, metaKey: true, key: "k" }, false],
  ])("%s", (_case, event, cycles) => {
    expect(isThemeHotkey(event)).toBe(cycles);
  });
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

/**
 * The panel opens the login page, because nothing else can.
 *
 * The comment here used to say the CLI opens the browser itself and a second tab
 * would split the flow. That was true while the login ran on the host and false
 * from the day it moved into the container, which has no browser — the CLI's own
 * output says `Browser didn't open? Use the url below to sign in`. So the boss
 * got a link and had to notice it.
 */
/**
 * The window is opened on the click and its location set afterwards. `window.open`
 * needs a user gesture and the link takes seconds to arrive, so opening it after
 * the await is a popup the browser blocks. That ordering is the whole test:
 * asserting only that the URL is reached would pass against the blocked version.
 */
test("signing in to claude opens the tab on the click, then points it at the link", async () => {
  login.replied = false;
  const opened: { at: "before" | "after" | null } = { at: null };
  const tab = { location: { href: "" }, close: () => {} };
  const opener = window.open;
  (window as { open: unknown }).open = () => {
    opened.at = login.replied ? "after" : "before";
    return tab;
  };

  try {
    const { getAllByRole } = render(<CredPane rows={[]} onSaved={() => {}} onWaitForLogin={() => {}} />);
    // Claude and Codex each have one, and Claude's is first — the pane renders
    // them in `RUNTIMES` order and only Claude takes this path.
    fireEvent.click(getAllByRole("button", { name: "登录" })[0]!);
    await waitFor(() => expect(tab.location.href).toBe(login.link));
    // Opened while the request was still in flight — a gesture that has not been
    // spent yet. `after` is the version every browser blocks.
    expect(opened.at).toBe("before");
  } finally {
    (window as { open: unknown }).open = opener;
  }
});

/**
 * What the panel is willing to navigate a tab to.
 *
 * The link arrives as a string in a JSON body — the schema says it is a string
 * and cannot say what kind — and assigning `javascript:…` to `location.href`
 * runs it in this origin. Parsed rather than prefix-matched, because
 * `javascript:https://x` passes a `startsWith` and is not a URL to claude.
 */
test("only a real https link is navigated to", () => {
  expect(httpsOnly("https://claude.com/cai/oauth/authorize?code=true")).toBe(
    "https://claude.com/cai/oauth/authorize?code=true",
  );
  expect(httpsOnly("javascript:alert(1)")).toBeNull();
  expect(httpsOnly("javascript:https://claude.com")).toBeNull();
  expect(httpsOnly("http://claude.com")).toBeNull();
  expect(httpsOnly("data:text/html,<script>x</script>")).toBeNull();
  expect(httpsOnly("not a url")).toBeNull();
  // A host, not a suffix. `endsWith("claude.com")` says yes to this one.
  expect(httpsOnly("https://evilclaude.com/cai/oauth")).toBeNull();
  expect(httpsOnly("https://console.anthropic.com/x")).toBe("https://console.anthropic.com/x");
  expect(httpsOnly("https://example.com/")).toBeNull();
});
