import type { Agent } from "./api";
import { t } from "@lingui/core/macro";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { i18n } from "../i18n";

/**
 * What the agent is doing, in the fewest words that are still true.
 *
 * The raw string is `command_execution: orch ctx query "…"`. Stripping the tool name
 * was not enough: a wall of shell is read command by command, and the question this
 * page answers is "who is stuck", which needs one glance per row. So a command is
 * classified into what it is *for* — `Query index` / `Run tests` / `Edit file` — with arguments as detail.
 *
 * Anything unmatched keeps its command verbatim: a wrong category is worse than none.
 */
const VERBS: [RegExp, MessageDescriptor][] = [
  [/^orch ctx query/, msg`Query index`],
  [/^orch task (list|claim)/, msg`Claim task`],
  [/^orch task done/, msg`Submit task`],
  [/^orch (note|journal)/, msg`Take note`],
  [/^orch (ask-boss|mail|reply)/, msg`Send message`],
  [/^orch (status|owns|lease|draft|slice)/, msg`Workflow`],
  [/^(bun|npm|pnpm|yarn) (test|run test)|^(pytest|go test|cargo test)/, msg`Run tests`],
  [/^(bunx tsc|tsc |bun run build|npm run build)/, msg`Compile`],
  [/^git (diff|status|log|show|blame)/, msg`View diff`],
  [/^git (add|commit|push|checkout|stash|restore)/, msg`Git ops`],
  [/^(rg|grep|ag|find|ls|fd|sed -n|cat|head|tail|wc)\b/, msg`Browse files`],
];

/** [what it is for, the part that says which thing]. */
export function activityOf(a: Agent): [string, string] {
  const raw = a.activity ?? a.state;
  // File edits arrive as their own item type and never look like a command.
  const edit = /^(file_change|Edit|Write|NotebookEdit):\s*/.exec(raw);
  if (edit) return [t`Edit file`, raw.slice(edit[0].length)];
  const read = /^(Read|Grep|Glob):\s*/.exec(raw);
  if (read) return [t`Browse files`, raw.slice(read[0].length)];
  const cmd = raw.replace(/^(command_execution|Bash):\s*/, "");
  for (const [re, verb] of VERBS) {
    if (re.test(cmd)) return [i18n._(verb), cmd.replace(re, "").replace(/^\s*/, "")];
  }
  return ["", cmd];
}
