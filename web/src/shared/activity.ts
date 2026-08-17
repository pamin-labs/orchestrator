import type { Agent } from "./api";

/**
 * What the agent is doing, in the fewest words that are still true.
 *
 * The raw string is `command_execution: orch ctx query "…"`. Stripping the tool
 * name was the first pass and it was not enough: a wall of shell is a wall the
 * boss reads command by command, and the question being asked of this page is
 * "who is stuck", which needs one glance per row. So the command is classified
 * into what it is *for* — 查索引 / 跑测试 / 改文件 — and the arguments follow as
 * detail. The verbs are a closed set, and anything unmatched keeps its command
 * verbatim rather than being labelled 其他: a wrong category is worse than none.
 */
const VERBS: [RegExp, string][] = [
  [/^orch ctx query/, "查索引"],
  [/^orch task (list|claim)/, "领任务"],
  [/^orch task done/, "交任务"],
  [/^orch (note|journal)/, "记笔记"],
  [/^orch (ask-boss|mail|reply)/, "发消息"],
  [/^orch (status|owns|lease|draft|slice)/, "走流程"],
  [/^(bun|npm|pnpm|yarn) (test|run test)|^(pytest|go test|cargo test)/, "跑测试"],
  [/^(bunx tsc|tsc |bun run build|npm run build)/, "编译"],
  [/^git (diff|status|log|show|blame)/, "看改动"],
  [/^git (add|commit|push|checkout|stash|restore)/, "动分支"],
  [/^(rg|grep|ag|find|ls|fd|sed -n|cat|head|tail|wc)\b/, "翻文件"],
];

/** [what it is for, the part that says which thing]. */
export function activityOf(a: Agent): [string, string] {
  const raw = a.activity ?? a.state;
  // File edits arrive as their own item type and never look like a command.
  const edit = /^(file_change|Edit|Write|NotebookEdit):\s*/.exec(raw);
  if (edit) return ["改文件", raw.slice(edit[0].length)];
  const read = /^(Read|Grep|Glob):\s*/.exec(raw);
  if (read) return ["翻文件", raw.slice(read[0].length)];
  const cmd = raw.replace(/^(command_execution|Bash):\s*/, "");
  for (const [re, verb] of VERBS) {
    if (re.test(cmd)) return [verb, cmd.replace(re, "").replace(/^\s*/, "")];
  }
  return ["", cmd];
}
