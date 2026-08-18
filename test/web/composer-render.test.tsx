import { afterEach, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { cleanup, isDisabled, render as mount, valueOf, waitFor } from "../support/render.tsx";
import { inFlight, mockHttp, server } from "../support/http.ts";
import { HttpResponse, http } from "msw";
import { WithQueries } from "./queries.tsx";
import { AttachmentTiles, Composer, SkillMenu } from "../../web/src/features/composer/view.tsx";
import {
  appendLine,
  attachmentLabel,
  attachmentMarks,
  boxHeight,
  keyAction,
  labelAttachments,
  skillsForSlash,
  pastedName,
  replaceSlash,
  slashAt,
  tileBadge,
  toDraft,
  type Attached,
  type Skill,
} from "../../web/src/features/composer/model.ts";

const skills: Skill[] = [
  { name: "commit", path: "/p/.claude/skills/commit/SKILL.md", description: "写提交信息", scope: "project", on: true },
  { name: "review", path: "/u/.claude/skills/review/SKILL.md", description: "过一遍改动", scope: "user", on: false },
];

const files: Attached[] = [
  { name: "shot.png", path: "/a/shot.png", type: "image/png", size: 2048, url: "blob:preview", label: "图1" },
  { name: "notes.md", path: "/a/notes.md", type: "text/markdown", size: 3072, label: "附件1" },
  { name: "src", path: "/a/src", type: "inode/directory", size: 0, label: "目录1" },
];

/**
 * testing-library's own `afterEach(cleanup)` is registered when its module is
 * evaluated, and `bun test` scopes the lifecycle globals per file — so that hook
 * belongs to whichever file imported it first, and every later file kept the
 * previous one's nodes in `document.body`. Each file registers its own.
 */
afterEach(cleanup);

/** A composer with a project reads its skills on mount. Left in flight unless a
 *  test answers `/api/v1/skills` itself, which is the state it comes up in. */
mockHttp(inFlight());

/** The skills a project has, as the read comes back. */
const serveSkills = (list: Skill[]) =>
  server.use(http.get("/api/v1/skills", () => HttpResponse.json({ skills: list })));

/**
 * A composer, with its own cache behind it.
 *
 * The skills list used to be a `Map` at module scope, shared by every file in
 * this process for the life of the run — so this file needed a `forgetSkills()`
 * in `afterEach` and a distinct project id per test to keep one test's read out
 * of the next. A client per mount is what removes both: the cache now has the
 * lifetime of the thing being rendered.
 */
const render = (node: ReactNode) => mount(<WithQueries>{node}</WithQueries>);

test("an empty composer offers attach, paste and a send that refuses to send nothing", () => {
  const { getByPlaceholderText, getByRole } = render(
    <Composer placeholder="说点什么" submit="发送" onSubmit={() => true} />,
  );
  getByPlaceholderText("说点什么");
  getByRole("button", { name: "附件" });
  getByRole("button", { name: "粘贴" });
  // The disabled one is the send, named: `disabled=""` anywhere in the markup
  // was equally satisfied by a disabled 附件.
  expect(isDisabled(getByRole("button", { name: "发送" }))).toBe(true);
});

test("seed text arrives in the box and enables the primary action", () => {
  const { getByRole } = render(<Composer initial="这里不对" submit="发送" onSubmit={() => true} />);
  expect(valueOf(getByRole("textbox"))).toBe("这里不对");
  expect(isDisabled(getByRole("button", { name: "发送" }))).toBe(false);
});

test("a composer with no submit label and no handler renders no primary action", async () => {
  // Skills present and loaded, so the missing 插技能 is about this composer having
  // no project rather than about the read not having landed.
  serveSkills(skills);
  const { getByRole, queryAllByRole } = render(<Composer placeholder="说点什么" projectId={8801} />);
  await waitFor(() => getByRole("button", { name: /插技能/ }));
  expect(queryAllByRole("button", { name: "发送" })).toHaveLength(0);
});

test("the 插技能 button waits for the skills read rather than appearing empty", async () => {
  serveSkills([]);
  const { getByRole, queryAllByRole } = render(<Composer placeholder="说点什么" projectId={8802} submit="发送" />);
  // A project whose skills read came back empty has nothing to insert, so the
  // button never arrives — but the two beside it are up immediately.
  getByRole("button", { name: "附件" });
  await waitFor(() => expect(queryAllByRole("button", { name: /插技能/ })).toHaveLength(0));
});

test("the skill picker names each skill, its scope, and whether it is ticked on", () => {
  const { getByRole, getByText } = render(<SkillMenu matches={skills} onPick={() => {}} />);
  getByText("选中的技能，正文随这一个 turn 发给 agent，只花这一次钱");
  // Each row is a button, so each row is reachable by keyboard and nameable.
  const commit = getByRole("button", { name: /commit/ });
  expect(commit.textContent).toContain("项目");
  expect(commit.textContent).toContain("写提交信息");
  expect(commit.textContent).toContain("Tab");
  // Ticked on, so nothing warns about it.
  expect(commit.textContent).not.toContain("未启用");
  const review = getByRole("button", { name: /review/ });
  expect(review.textContent).toContain("全局");
  expect(review.textContent).toContain("未启用");
  // The count, so a skill sorting seventh is known to exist.
  getByText("2");
});

test("a picker with nothing to offer renders nothing at all", () => {
  expect(render(<SkillMenu matches={[]} onPick={() => {}} />).container.innerHTML).toBe("");
  expect(render(<AttachmentTiles files={[]} onRemove={() => {}} />).container.innerHTML).toBe("");
});

test("each attachment tile carries the marker the text refers to it by", () => {
  const { container, getByRole, getByText, queryAllByText } = render(
    <AttachmentTiles files={files} onRemove={() => {}} />,
  );
  getByText("[图1]");
  // An image tile previews the image; the other two wear a badge for their kind.
  // Queried by hand because the thumbnail carries `alt=""` and so is not in the
  // accessibility tree at all — see the note in the report.
  expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:preview");
  getByText("[附件1]");
  getByText("MD");
  getByText("3k");
  getByText("[目录1]");
  getByText("DIR");
  // Every tile has its own way off, named after the file it removes.
  getByRole("button", { name: "移除 shot.png" });
  getByRole("button", { name: "移除 notes.md" });
  getByRole("button", { name: "移除 src" });
  // A directory has no meaningful byte count, so it is not given one.
  expect(queryAllByText("0k")).toHaveLength(0);
});

test("a slash opens the picker only at the start of a word, and only with skills to offer", () => {
  expect(slashAt("/com", 4, skills)).toEqual({ from: 0, q: "com" });
  expect(slashAt("改一下 /Com", 8, skills)).toEqual({ from: 4, q: "com" });
  expect(slashAt("a/b", 3, skills)).toBeNull();
  expect(slashAt("/com", 4, [])).toBeNull();
  expect(slashAt("/com", 4, null)).toBeNull();
});

test("a closed picker matches nothing; an open one matches name or path", () => {
  expect(skillsForSlash(skills, null)).toEqual([]);
  expect(skillsForSlash(skills, { from: 0, q: "" })).toHaveLength(2);
  expect(skillsForSlash(skills, { from: 0, q: "commit" })?.[0]?.name).toBe("commit");
  expect(skillsForSlash(skills, { from: 0, q: "/u/" })?.[0]?.name).toBe("review");
  expect(skillsForSlash(skills, { from: 0, q: "zzz" })).toEqual([]);
});

test("taking a skill replaces the query that opened the picker, leaving the sentence", () => {
  const text = "按 /com 改";
  const slash = slashAt(text.slice(0, 6), 6, skills)!;
  expect(replaceSlash(text, slash, "/commit ")).toBe("按 /commit  改");
  expect(replaceSlash(text, slash, "")).toBe("按  改");
});

test("attachments are numbered per kind, against what is already there", () => {
  expect(attachmentLabel("image/png", [])).toBe("图1");
  expect(attachmentLabel("image/png", ["图1", "附件1"])).toBe("图2");
  expect(attachmentLabel("inode/directory", ["目录1"])).toBe("目录2");
  expect(attachmentLabel("text/plain", ["图1"])).toBe("附件1");

  const marked = labelAttachments(
    [
      { name: "b.png", path: "/b.png", type: "image/png", size: 1 },
      { name: "c.txt", path: "/c.txt", type: "text/plain", size: 1 },
    ],
    files,
    ["blob:b"],
  );
  expect(marked.map((f) => f.label)).toEqual(["图2", "附件2"]);
  expect(marked[0]?.url).toBe("blob:b");
  expect(marked[1]?.url).toBeUndefined();
  expect(attachmentMarks(marked)).toBe("[图2][附件2]");
});

test("the picker owns Escape and Tab; ⌘Enter always sends", () => {
  const key = (k: string, mod: Partial<{ metaKey: boolean; ctrlKey: boolean }> = {}) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    ...mod,
  });
  expect(keyAction(key("Tab"), true, true)).toBe("skill");
  expect(keyAction(key("Tab"), true, false)).toBe("close");
  expect(keyAction(key("Escape"), true, true)).toBe("close");
  expect(keyAction(key("Tab"), false, true)).toBeNull();
  expect(keyAction(key("Enter", { metaKey: true }), false, false)).toBe("send");
  expect(keyAction(key("Enter", { ctrlKey: true }), true, true)).toBe("send");
  expect(keyAction(key("Enter"), false, false)).toBeNull();
});

test("a draft trims its text and carries only the fields the prompt needs", () => {
  const draft = toDraft("  这里不对 [图1]  ", files.slice(0, 1));
  expect(draft.text).toBe("这里不对 [图1]");
  expect(draft.attachments).toEqual([{ name: "shot.png", path: "/a/shot.png", type: "image/png", label: "图1" }]);
});

test("small presentation decisions", () => {
  expect(tileBadge({ type: "inode/directory", name: "src" })).toBe("DIR");
  expect(tileBadge({ type: "text/plain", name: "readme.markdown" })).toBe("MARK");
  expect(tileBadge({ type: "text/plain", name: "LICENSE" })).toBe("LICE");
  expect(boxHeight(0)).toBeUndefined();
  expect(boxHeight(88)).toBe("88px");
  expect(pastedName(2, "image/webp")).toBe("pasted-2.webp");
  expect(pastedName(1, "image")).toBe("pasted-1.png");
  expect(appendLine("", "一")).toBe("一");
  expect(appendLine("一", "二")).toBe("一\n二");
});
