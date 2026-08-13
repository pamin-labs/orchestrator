/**
 * The strings the orchestrator itself says to the boss.
 *
 * `output.language` governs journals, channel messages, questions and status text
 * (PLAN.md §11); code, commit messages, branch names, PR title/body and error
 * messages stay English. The rule was being kept by the agents — their role prompts
 * carry it — and broken by us: every `bus.emit` body the orchestrator wrote was
 * English, so a Chinese panel's own event feed read "perf-rewrite is at 102% of its
 * budget".
 *
 * Feedback that goes back to an *agent* stays English on purpose: it lands in a
 * prompt, next to code and gate output, and translating it would only make the model
 * translate it back.
 *
 * ponytail: a flat table and a formatter. No i18n library for one language pair and
 * two dozen strings; the day a third language appears, this is still the shape.
 */
type Args = Record<string, string | number>;

const ZH: Record<string, string> = {
  "slice.ready": 'S{seq}「{title}」做完了，等你查收',
  "slice.accepted": "查收 S{seq} {title}{why}",
  "slice.sentback": "S{seq} 被 {from} 打回（第 {n} 次）",
  "slice.failed": "S{seq} 连续 {n} 次没过 {from} —— 大概是验收标准的问题，不是代码",
  "slice.autoaccept": "{tier} 自动查收，三道闸全过",
  "gate.pass": "S{seq} 闸门通过",
  "gate.fail": "S{seq} 闸门没过",
  "gate.reconcile": "S{seq} 对账没过：{reason}",
  "gate.unclaimed": "S{seq} 还改了这些但没声明：{files}",
  "group.worktree": "开好 worktree，分支 {branch}",
  "group.approved": "计划卡批准，开工",
  "group.approve_held": "已记下你的批准。边界还挡着：{why}。让开之后自动开工，不用再点一次",
  "group.blocked": "被 {path} 挡住了，交给了另一条需求（grp {target}），它落地后自动继续",
  "group.unblocked": "挡路的 grp {target} 已经落地，自动继续",
  "group.dropped": "老板决定不做了{why}",
  "group.merged": "已合入 main",
  "group.paused": "全组已暂停",
  "group.parked": "已封存：{why}。worktree 和 checkpoint 都留着",
  "group.resumed": "继续",
  "group.autoadvance": "autoAdvance：没等你，下一片已经开工",
  "pr.opened": "PR #{n} 已开",
  "pr.queued": "进合入队列，排在第 {n}",
  "wd.unparked": "{name} 等的那件事已经了结，自动唤醒",
  "wd.stalled": "这一组 RUNNING 但队列是空的，重排一轮也没救回来。最后一次失败：{why}",
  "wd.turn_timeout": "一个 turn 超过 {min} 分钟，已掐断",
  "wd.no_progress": "{role} 连续 {n} 个 turn 没动过文件、task 或 note",
  "wd.circling": "{role} 连着 {n} 个 turn 在改同一个文件 {file} —— 大概是设计问题，转给 Architect",
  "wd.env_suspect": "{resource} 失败 {n} 次而代码没变 —— 先怀疑环境，别再改代码",
  "wd.budget_exhausted": "{name} 把 {tokens} tokens 花完了，全组挂起",
  "wd.budget_80": "{name} 预算用到 {pct}%",
  "wd.parked": "{name} 等你 {min} 分钟后自动封存 —— worktree 留着，并发槽释放了",
  "wd.waiting_on_you": "{name} 已经等你 {min} 分钟",
  "wd.unshipped": "{name} 每一片都查收了但没有 PR，队列也空了 —— 重新走一遍分支复核",
  "rl.waiting": "撞到限额，这个 CLI 上的活全部挂起等额度恢复（约 {at}），到点自动继续 —— 换模型不换池子，等是唯一的选择",
  "rl.resumed": "额度恢复，自动继续",
  "owns.reverted": "{role} 改了本组不拥有的 {n} 个文件（{files}），已回滚 —— 这个 CLI 的沙箱拦不住写入，只能事后对账",
  "unread.digest": "未读 {n} 条，已让 Librarian 压成摘要",
  "sediment": "同一类反馈第 {n} 次了，让 CoS 归纳成项目规约",
  "hired": "雇了 {role}",
  "boss.reject_slice": "退回了这一片",
};

const EN: Record<string, string> = {
  "slice.ready": 'S{seq} "{title}" is ready for you',
  "slice.accepted": "accepted: S{seq} {title}{why}",
  "slice.sentback": "S{seq} sent back by {from} (attempt {n})",
  "slice.failed": "S{seq} failed {from} {n}x — probably the acceptance criteria, not the code",
  "slice.autoaccept": "{tier} auto-accepted, all three gates passed",
  "gate.pass": "gate pass on S{seq}",
  "gate.fail": "gate fail on S{seq}",
  "gate.reconcile": "reconcile failed on S{seq}: {reason}",
  "gate.unclaimed": "also changed on S{seq}, unclaimed: {files}",
  "group.worktree": "worktree {branch}",
  "group.approved": "DRAFT approved",
  "group.approve_held": "approval recorded — held by the boundary: {why}. Starts by itself once that clears",
  "group.blocked": "blocked by {path}; handed to grp {target} and waiting for it to land",
  "group.unblocked": "grp {target} landed; resuming by itself",
  "group.dropped": "dropped by the boss{why}",
  "group.merged": "merged into main",
  "group.paused": "PAUSED",
  "group.parked": "parked: {why}. worktree and checkpoint kept",
  "group.resumed": "resumed",
  "group.autoadvance": "autoAdvance: started the next slice without waiting for you",
  "pr.opened": "PR #{n} opened",
  "pr.queued": "joined the merge queue at position {n}",
  "wd.unparked": "{name} is no longer waiting on anything — woken up",
  "wd.stalled": "group is RUNNING with an empty queue, and one re-queue did not revive it. Last failure: {why}",
  "wd.turn_timeout": "turn ran past {min} min and was killed",
  "wd.no_progress": "{role} finished {n} turns without changing a file, a task or a note",
  "wd.circling": "{role} has rewritten {file} {n} turns running — probably a design problem, sending it to the Architect",
  "wd.env_suspect": "{resource} failed {n}x with no code change in between — treat the environment as the suspect",
  "wd.budget_exhausted": "{name} spent its whole budget ({tokens} tokens) and is suspended",
  "wd.budget_80": "{name} is at {pct}% of its budget",
  "wd.parked": "{name} parked after waiting {min} min — worktree kept, slot freed",
  "wd.waiting_on_you": "{name} has been waiting {min} min for you",
  "wd.unshipped": "{name} has every slice accepted, no PR and an empty queue — re-running the branch review",
  "rl.waiting":
    "rate limited; everything on this CLI holds until the window reopens (~{at}) and resumes itself — the quota belongs to the account, so no model spends less of it",
  "rl.resumed": "quota is back, resuming",
  "owns.reverted":
    "{role} wrote {n} files this group does not own ({files}) — reverted; this CLI's sandbox cannot stop the write, so the check runs after it",
  "unread.digest": "{n} unread — the Librarian is compressing them",
  "sediment": "the same feedback for the {n}th time; asking the CoS to make it a project rule",
  hired: "hired {role}",
  "boss.reject_slice": "rejected the slice",
};

/**
 * `中文` (the configured default) or anything else, which gets English.
 *
 * Tolerates an absent language: a unit test builds a Ctx without config, and a
 * missing string is not a reason to throw inside a bus.emit.
 */
export function say(lang: string | undefined, key: keyof typeof EN, args: Args = {}): string {
  const l = lang ?? "";
  const table = l.startsWith("中") || l.toLowerCase().startsWith("zh") ? ZH : EN;
  const t = table[key] ?? EN[key] ?? String(key);
  return t.replace(/\{(\w+)\}/g, (_m, k) => String(args[k] ?? ""));
}
