import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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

const render = (node: ReactNode) => renderToStaticMarkup(<TipRoot>{node}</TipRoot>);

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
  expect(render(<NotesBoard notes={null} />)).toContain("读记录…");
  const empty = render(<NotesBoard notes={[]} />);
  expect(empty).toContain("还没有记录");
  expect(empty).toContain("retro 归纳成教训注入后续组");
});

test("inside one requirement the kinds are badges on a single list, not tabs", () => {
  const html = render(
    <NotesBoard compact notes={[note({ kind: "journal" }), note({ id: 2, kind: "retro", body: "这组的复盘" })]} />,
  );
  expect(html).toContain("日志");
  expect(html).toContain("复盘");
  expect(html).toContain("这组的复盘");
  // A compact list has no tab strip: four tabs with one row each is worse than none.
  expect(html).not.toContain('role="tablist"');
});

test("the board tabs only the kinds that exist, and counts each one", () => {
  const html = render(
    <NotesBoard
      notes={[
        note({ id: 1, kind: "journal" }),
        note({ id: 2, kind: "journal", body: "第二条日志" }),
        note({ id: 3, kind: "lesson", body: "别再并行改同一个文件" }),
      ]}
    />,
  );
  expect(html).toContain('role="tablist"');
  expect(html).toContain("日志");
  expect(html).toContain("教训");
  expect(html).toContain("2");
  // Kinds nobody wrote get no tab at all.
  expect(html).not.toContain("入职包");
  expect(html).not.toContain("老板说的");
});

test("a note's deterministic anchors are rendered beside the prose they check", () => {
  const html = render(
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
  expect(html).toContain("闸门 过");
  expect(html).toContain("src/mech/notes.ts");
  expect(html).toContain("web/src/views/notes.tsx");
  // The export path is a hover, not sixty characters of header.
  expect(html).toContain("md");
  expect(html).toContain("把导出路径挪走");
});

test("a failed gate is named in the boss's words, an unknown one in the server's", () => {
  const fail = render(<NotesBoard compact notes={[note({ frontmatter: JSON.stringify({ gate: "fail" }) })]} />);
  expect(fail).toContain("闸门 没过");
  expect(fail).toContain("text-bad");

  // A verdict this panel has no word for is passed through rather than swallowed.
  const other = render(<NotesBoard compact notes={[note({ frontmatter: JSON.stringify({ gate: "skipped" }) })]} />);
  expect(other).toContain("闸门 skipped");
});

test("a note with nothing to check against renders no anchor row at all", () => {
  const html = render(<NotesBoard compact notes={[note({ frontmatter: JSON.stringify({ files: [] }) })]} />);
  expect(html).not.toContain("闸门");
  expect(html).not.toContain(">md<");
});

test("a long note is clamped with a way to open it; a short one is not", () => {
  const long = render(<NotesBoard compact notes={[note({ body: "一".repeat(400) })]} />);
  expect(long).toContain("展开");
  expect(long).toContain("line-clamp-4");

  expect(render(<NotesBoard compact notes={[note({ body: "两行\n就两行" })]} />)).not.toContain("展开");
});

test("a list longer than the page says how much is left rather than dropping it", () => {
  const many = Array.from({ length: 15 }, (_, i) => note({ id: i + 1, body: `第 ${i + 1} 条` }));
  const html = render(<NotesBoard notes={many} />);
  expect(html).toContain("还有 3 条（共 15）");
  expect(html).toContain("第 12 条");
  expect(html).not.toContain("第 13 条");
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
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client()}>
      <TipRoot>
        <SandboxServerSettings open section="server" rows={[]} checks={[]} onSaved={() => {}} />
      </TipRoot>
    </QueryClientProvider>,
  );
  expect(html).toContain("沙盒服务器");
  expect(html).toContain("开容器的那个服务");
  expect(html).toContain("读取中…");
});

test("an account with nothing stored says so and offers both ways to fill it", () => {
  const html = render(<CredPane rows={[]} onSaved={() => {}} onWaitForLogin={() => {}} />);
  expect(html).toContain("模型账号");
  expect(html).toContain("真令牌不进沙盒");
  // Both runtimes, both unconfigured, each with its own way in.
  expect(html).toContain("Claude");
  expect(html).toContain("Codex");
  expect(html.match(/没配/g)).toHaveLength(2);
  expect(html).toContain("登录");
  expect(html).toContain("粘贴进来，存下之后看不到");
  expect(html).toContain("API 地址");
});

test("a stored credential shows its tail and stops re-explaining how to get one", () => {
  const html = render(
    <CredPane
      rows={[{ runtime: "claude", mode: "oauth_token", hint: "…7f21", updatedAt: 1_700_000_000_000 }]}
      prefs={{ claudeCoauthor: true }}
      onSaved={() => {}}
      onWaitForLogin={() => {}}
    />,
  );
  expect(html).toContain("已存 …7f21，粘新的就换掉");
  expect(html).toContain("清掉");
  // Instructions for a decision already made are gone for the configured row.
  expect(html).not.toContain("容器里跑 claude setup-token");
  // Codex is still unconfigured, so its instructions stay.
  expect(html).toContain("在容器里登录，本机不用装 codex");
  // Only Claude's CLI has a commit trailer to switch.
  expect(html.match(/Co-author/g)).toHaveLength(1);
});

test("a login in flight disables the button that started it", () => {
  const html = render(<CredPane rows={[]} waiting="claude" onSaved={() => {}} onWaitForLogin={() => {}} />);
  expect(html).toContain("等你在浏览器里批准…");
  expect(html.match(/等你在浏览器里批准…/g)).toHaveLength(1);
});

test("the skills pane says nothing about counts until the read lands", () => {
  const html = render(<Skills projectId={1} />);
  expect(html).toContain("技能");
  expect(html).toContain("读取中…");
  expect(html).toContain("重新扫描");
  expect(html).toContain("搜技能");
  // No "0/0 个进沙盒" before anything is known.
  expect(html).not.toContain("进沙盒");
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

test("the base-branch field is a text box that already carries its value", () => {
  const html = render(
    <Combobox value="main" options={["main", "release/1"]} placeholder="选分支" onCommit={() => {}} />,
  );
  expect(html).toContain('value="main"');
  expect(html).toContain('placeholder="选分支"');
  expect(html).toContain('role="combobox"');
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
  const html = render(<ThemeChoice />);
  expect(html).toContain("跟随系统");
  expect(html).toContain("浅色");
  expect(html).toContain("深色");
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
