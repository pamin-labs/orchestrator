import { expect, test } from "bun:test";
import { activityOf } from "../web/src/lib/activity.ts";

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
