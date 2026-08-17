import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AttachmentTiles, Composer, SkillMenu } from "../../web/src/ui/composer.tsx";
import {
  appendLine,
  attachmentLabel,
  attachmentMarks,
  boxHeight,
  keyAction,
  labelAttachments,
  matchSkills,
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

test("an empty composer offers attach, paste and a disabled send", () => {
  const html = renderToStaticMarkup(<Composer placeholder="说点什么" submit="发送" onSubmit={() => true} />);
  expect(html).toContain("说点什么");
  expect(html).toContain("附件");
  expect(html).toContain("粘贴");
  expect(html).toContain("发送");
  expect(html).toContain('disabled=""');
});

test("seed text arrives in the box and enables the primary action", () => {
  const html = renderToStaticMarkup(<Composer initial="这里不对" submit="发送" onSubmit={() => true} />);
  expect(html).toContain("这里不对");
  expect(html).not.toContain('disabled=""');
});

test("a composer with no submit label and no handler renders no primary action", () => {
  const html = renderToStaticMarkup(<Composer placeholder="说点什么" />);
  expect(html).not.toContain("发送");
  // The 插技能 button only appears once a project's skills have loaded.
  expect(html).not.toContain("插技能");
});

test("the skill picker names each skill, its scope, and whether it is ticked on", () => {
  const html = renderToStaticMarkup(<SkillMenu matches={skills} onPick={() => {}} />);
  expect(html).toContain("选中的技能，正文随这一个 turn 发给 agent，只花这一次钱");
  expect(html).toContain("commit");
  expect(html).toContain("项目");
  expect(html).toContain("写提交信息");
  expect(html).toContain("review");
  expect(html).toContain("全局");
  expect(html).toContain("未启用");
  expect(html).toContain("Tab");
  expect(html).toContain(">2<");
});

test("a picker with nothing to offer renders nothing at all", () => {
  expect(renderToStaticMarkup(<SkillMenu matches={[]} onPick={() => {}} />)).toBe("");
  expect(renderToStaticMarkup(<AttachmentTiles files={[]} onRemove={() => {}} />)).toBe("");
});

test("each attachment tile carries the marker the text refers to it by", () => {
  const html = renderToStaticMarkup(<AttachmentTiles files={files} onRemove={() => {}} />);
  expect(html).toContain("[图1]");
  expect(html).toContain("blob:preview");
  expect(html).toContain("[附件1]");
  expect(html).toContain("MD");
  expect(html).toContain("3k");
  expect(html).toContain("[目录1]");
  expect(html).toContain("DIR");
  expect(html).toContain("移除 shot.png");
  // A directory has no meaningful byte count, so it is not given one.
  expect(html).not.toContain("0k");
});

test("a slash opens the picker only at the start of a word, and only with skills to offer", () => {
  expect(slashAt("/com", 4, skills)).toEqual({ from: 0, q: "com" });
  expect(slashAt("改一下 /Com", 8, skills)).toEqual({ from: 4, q: "com" });
  expect(slashAt("a/b", 3, skills)).toBeNull();
  expect(slashAt("/com", 4, [])).toBeNull();
  expect(slashAt("/com", 4, null)).toBeNull();
});

test("a closed picker matches nothing; an open one matches name or path", () => {
  expect(matchSkills(skills, null)).toEqual([]);
  expect(matchSkills(skills, { from: 0, q: "" })).toHaveLength(2);
  expect(matchSkills(skills, { from: 0, q: "commit" })?.[0]?.name).toBe("commit");
  expect(matchSkills(skills, { from: 0, q: "/u/" })?.[0]?.name).toBe("review");
  expect(matchSkills(skills, { from: 0, q: "zzz" })).toEqual([]);
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
