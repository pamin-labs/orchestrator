import type { Agent } from "./api";
import i18n from "../i18n";

/**
 * What the agent is doing, in the fewest words that are still true.
 *
 * The raw string is `command_execution: orch ctx query "…"`. Stripping the tool name
 * was not enough: a wall of shell is read command by command, and the question this
 * page answers is "who is stuck", which needs one glance per row. So a command is
 * classified into what it is *for* — 查索引 / 跑测试 / 改文件 — with arguments as detail.
 *
 * Anything unmatched keeps its command verbatim: a wrong category is worse than none.
 */
const VERBS: [RegExp, string, string][] = [
  [/^orch ctx query/, "queryIndex", "查索引"],
  [/^orch task (list|claim)/, "claimTask", "领任务"],
  [/^orch task done/, "handInTask", "交任务"],
  [/^orch (note|journal)/, "takeNote", "记笔记"],
  [/^orch (ask-boss|mail|reply)/, "sendMessage", "发消息"],
  [/^orch (status|owns|lease|draft|slice)/, "workflow", "走流程"],
  [/^(bun|npm|pnpm|yarn) (test|run test)|^(pytest|go test|cargo test)/, "runTests", "跑测试"],
  [/^(bunx tsc|tsc |bun run build|npm run build)/, "compile", "编译"],
  [/^git (diff|status|log|show|blame)/, "viewDiff", "看改动"],
  [/^git (add|commit|push|checkout|stash|restore)/, "gitOps", "动分支"],
  [/^(rg|grep|ag|find|ls|fd|sed -n|cat|head|tail|wc)\b/, "browseFiles", "翻文件"],
];

/** [what it is for, the part that says which thing]. */
export function activityOf(a: Agent): [string, string] {
  const raw = a.activity ?? a.state;
  // File edits arrive as their own item type and never look like a command.
  const edit = /^(file_change|Edit|Write|NotebookEdit):\s*/.exec(raw);
  if (edit) return [i18n.t("shared.activity.editFile", "改文件"), raw.slice(edit[0].length)];
  const read = /^(Read|Grep|Glob):\s*/.exec(raw);
  if (read) return [i18n.t("shared.activity.browseFiles", "翻文件"), raw.slice(read[0].length)];
  const cmd = raw.replace(/^(command_execution|Bash):\s*/, "");
  for (const [re, key, text] of VERBS) {
    if (re.test(cmd)) return [i18n.t(`shared.activity.${key}`, text), cmd.replace(re, "").replace(/^\s*/, "")];
  }
  return ["", cmd];
}
