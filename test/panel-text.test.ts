import { expect, test } from "bun:test";
import { activityOf } from "../web/src/lib/activity.ts";
import { splitAttachments } from "../web/src/lib/attach.ts";
import { imagePaths, withAttachments } from "../src/api.ts";

const of = (activity: string) => activityOf({ activity } as never);

test("the wall says what a command is for, and keeps what it was for", () => {
  // Verbatim off the live wall. Every row was shell, so scanning it meant reading
  // every command in full to find the one agent that was not making progress.
  expect(of('command_execution: orch ctx query "S1 通用文件目录选择器"')).toEqual([
    "查索引",
    '"S1 通用文件目录选择器"',
  ]);
  expect(of("command_execution: bun test test/api.test.ts")).toEqual(["跑测试", "test/api.test.ts"]);
  expect(of("file_change: web/src/app.tsx")).toEqual(["改文件", "web/src/app.tsx"]);
  expect(of("Bash: git diff main...HEAD")).toEqual(["看改动", "main...HEAD"]);
});

test("an unrecognised command keeps its own words rather than being filed as 其他", () => {
  // A wrong category is worse than none: the boss would stop trusting the ones
  // that are right.
  expect(of("command_execution: ./scripts/deploy.sh --dry-run")).toEqual([
    "",
    "./scripts/deploy.sh --dry-run",
  ]);
});

test("a message hands its attachments back as things the panel can open", () => {
  // Exactly what withAttachments() writes. The boss's screenshot used to render
  // as this line, under the question it was evidence for.
  const { text, files } = splitAttachments(
    "按 [图1] 改\n\n附件（路径如下）：\n- [图1] data/attachments/1755-0-Screenshot.png (image)\n- [附件2] data/attachments/1755-1-spec.pdf",
  );
  expect(text).toBe("按 [图1] 改");
  expect(files.map((f) => f.image)).toEqual([true, false]);
  expect(files.map((f) => f.label)).toEqual(["图1", "附件2"]);
  expect(files[0]!.url).toBe("/api/attach/1755-0-Screenshot.png");
});

test("a message that merely mentions attachments keeps its own body", () => {
  const body = "附件（路径如下）：\n还没传呢";
  expect(splitAttachments(body).text).toBe(body);
  expect(splitAttachments("没有附件").files).toEqual([]);
});

test("labelled image paths still reach codex as -i flags", () => {
  // The label is written into the same line the image tag is on, and imagePaths
  // is how those files leave for a CLI with no tool that opens an image.
  const prompt = withAttachments("按 [图1] 改", [
    { name: "a.png", path: "/data/a.png", type: "image/png", label: "图1" },
    { name: "s.pdf", path: "/data/s.pdf", type: "application/pdf", label: "附件2" },
  ]);
  expect(prompt).toContain("- [图1] /data/a.png (image)");
  expect(imagePaths(prompt)).toEqual(["/data/a.png"]);
});
