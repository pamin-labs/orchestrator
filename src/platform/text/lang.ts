import { isChinese } from "../../contracts/config.ts";

/**
 * The strings the orchestrator itself says to the boss.
 *
 * `output.language` governs journals, channel messages, questions and status text;
 * code, commits, branch names, PR bodies and error messages stay English. The rule
 * was being kept by the agents — their role prompts carry it — and broken by us:
 * every `bus.emit` body the orchestrator wrote was English, so a Chinese panel's
 * own feed read "perf-rewrite is at 102% of its budget".
 */
/**
 * Feedback that goes back to an *agent* stays English on purpose: it lands in a
 * prompt beside code and gate output, and translating it would only make the model
 * translate it back.
 *
 * ponytail: a flat table and a formatter. No i18n library for one language pair and
 * two dozen strings; the day a third language appears, this is still the shape.
 */
/**
 * Chinese, where we have it. Partial on purpose: `say` falls back to the English
 * row, so a key added to EN_SAY and not yet translated is a sentence in the other
 * language rather than a build error.
 */
export const ZH_SAY: Partial<Record<SayKey, string>> = {
  "slice.ready": "S{seq}「{title}」做完了，等你查收",
  "slice.accepted": "查收 S{seq} {title}",
  "slice.accepted_why": "查收 S{seq} {title}（{why}）",
  "slice.sentback": "S{seq} 被 {from} 打回（第 {n} 次）",
  "slice.failed": "S{seq} 连续 {n} 次没过 {from} —— 大概是验收标准的问题，不是代码",
  "slice.autoaccept": "{tier} 自动查收，三道闸全过",
  "gate.pass": "S{seq} 闸门通过",
  "gate.fail": "S{seq} 闸门没过",
  "gate.reconcile": "S{seq} 对账没过：{reason}",
  "gate.unclaimed": "S{seq} 还改了这些但没声明：{files}",
  "group.worktree": "开好沙箱，分支 {branch}",
  "group.approved": "计划卡批准，开工",
  "group.approve_held": "已记下你的批准。边界还挡着：{why}。让开之后自动开工，不用再点一次",
  "group.blocked": "被 {path} 挡住了，交给了另一条需求（grp {target}），它落地后自动继续",
  "group.unblocked": "挡路的 grp {target} 已经落地，自动继续",
  "group.dropped": "老板决定不做了",
  "group.dropped_why": "老板决定不做了：{why}",
  "group.merged": "已合入 main",
  "group.paused": "全组已暂停",
  "group.parked": "已封存：{why}。代码和 checkpoint 都留着",
  "sandbox.rebuild": "容器扔了，下一个 turn 会重建：clone + 装依赖，分支在宿主仓库里，不会丢",
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
  "wd.parked": "{name} 等你 {min} 分钟后自动封存 —— 代码留着，并发槽释放了",
  "wd.waiting_on_you": "{name} 已经等你 {min} 分钟",
  "wd.unshipped": "{name} 每一片都查收了但没有 PR，队列也空了 —— 重新走一遍分支复核",
  "rl.waiting":
    "撞到限额，这个 CLI 上的活全部挂起等额度恢复（约 {at}），到点自动继续 —— 换模型不换池子，等是唯一的选择",
  "rl.resumed": "额度恢复，自动继续",
  "net.lost": "宿主断网了，{n} 个 turn 挂起等联网 —— 需求还在跑的状态，活儿排着，通了自动接上",
  "net.back": "网络恢复，挂起的活自动继续",
  "repo.held":
    "GitHub 认不了这个登录了，{repo} 这个项目的活先全部挂起 —— 重试帮不上忙。去设置页重连 GitHub，好了自动接着走。别的项目不受影响。",
  "owns.reverted": "{role} 改了本组不拥有的 {n} 个文件（{files}），已回滚 —— 这个 CLI 的沙箱拦不住写入，只能事后对账",
  "unread.digest": "未读 {n} 条，已让 Librarian 压成摘要",
  sediment: "同一类反馈第 {n} 次了，让 CoS 归纳成项目规约",
  hired: "雇了 {role}",
  "boss.reject_slice": "退回了这一片",
  "wd.waiting_card": "{name} 的计划卡等你批 {hours} 小时了",
  "wd.waiting_slice": "{name} S{seq} 等你查收 {hours} 小时了",
  "wd.waiting_merge": "{name} 的 PR 排在队首 {hours} 小时了",
  "wd.waiting_merge_blocked": "{name} 的 PR 排在队首 {hours} 小时了，后面还堵着 {n} 个",
  "wd.broke":
    "看门狗这一轮挂了，后面的规则都没跑：{why}\n每 30 秒都会再试一次，但在修好之前，靠它推的那些状态（卡住的组、过期的沙箱、基线变了要 rebase、等你决定的计时）都停在原地。",
  "wd.rule_broke": "看门狗第 {rule} 条（{ruleName}）挂了，这一轮其余的照跑：{why}",
  "wd.map_stale": "仓库地图停在上一次的版本：{repo} 的容器读不到 HEAD，重建只会得到一份没有符号的地图",
  "wd.map_failed": "仓库地图没法刷新了：{repo} —— {why}",
  "wd.map_no_remote": "这个项目没记下 remote，没有可以镜像的地址",
  "wd.map_no_reason": "没有原因可说，这本身就是个 bug",
  "wd.base_moved": "{base} 动到了 {sha}，{name} 的基线落后了，已经让它先 rebase",
  "wd.waiting_parked": "{name} 封存了 {hours} 小时，唤醒还是不做了？",
  "wd.sandbox_swept": "{name} 解散了，沙箱回收",
  "wd.sandbox_stale_cred": "{name} 的沙箱绑的是旧凭据，回收了，下一轮重建",
  "wd.server_gone": "opensandbox-server 起不来了，试了 {n} 次，不再自动重试。手动跑一次看它报什么：{cmd}",
  "wd.server_restart_failed": "opensandbox-server 没了，重启失败（第 {n} 次）：{why}",
  "wd.server_restarted": "opensandbox-server 没了，重启了（第 {n} 次）。挂起的活会自己继续。",
  "wd.stale_ask": "{name} 已经走到 PR，那条还挂着的问题过期了，自动关掉",
  "notify.batch": "有 {n} 件事等你：",
};

/**
 * English, and the list of keys that exist.
 *
 * Deliberately not annotated `Record<string, string>`. It was, and that made
 * `keyof typeof EN_SAY` mean `string` — so the `key` parameter below checked
 * nothing, in any caller, ever. `say` answers an unknown key with
 * `String(key)`, which does not throw and does not log: the literal
 * `wd.stalledd` goes into the boss's feed where the sentence explaining why a
 * group stopped was supposed to be.
 */
export const EN_SAY = {
  "slice.ready": 'S{seq} "{title}" is ready for you',
  "slice.accepted": "accepted: S{seq} {title}",
  "slice.accepted_why": "accepted: S{seq} {title} ({why})",
  "slice.sentback": "S{seq} sent back by {from} (attempt {n})",
  "slice.failed": "S{seq} failed {from} {n}x — probably the acceptance criteria, not the code",
  "slice.autoaccept": "{tier} auto-accepted, all three gates passed",
  "gate.pass": "gate pass on S{seq}",
  "gate.fail": "gate fail on S{seq}",
  "gate.reconcile": "reconcile failed on S{seq}: {reason}",
  "gate.unclaimed": "also changed on S{seq}, unclaimed: {files}",
  "group.worktree": "checkout on {branch}",
  "group.approved": "DRAFT approved",
  "group.approve_held": "approval recorded — held by the boundary: {why}. Starts by itself once that clears",
  "group.blocked": "blocked by {path}; handed to grp {target} and waiting for it to land",
  "group.unblocked": "grp {target} landed; resuming by itself",
  "group.dropped": "dropped by the boss",
  "group.dropped_why": "dropped by the boss: {why}",
  "group.merged": "merged into main",
  "group.paused": "PAUSED",
  "group.parked": "parked: {why}. checkout and checkpoint kept",
  "sandbox.rebuild":
    "container discarded; the next turn rebuilds it — clone and install. The branch lives in the host repo",
  "group.resumed": "resumed",
  "group.autoadvance": "autoAdvance: started the next slice without waiting for you",
  "pr.opened": "PR #{n} opened",
  "pr.queued": "joined the merge queue at position {n}",
  "wd.unparked": "{name} is no longer waiting on anything — woken up",
  "wd.stalled": "group is RUNNING with an empty queue, and one re-queue did not revive it. Last failure: {why}",
  "wd.turn_timeout": "turn ran past {min} min and was killed",
  "wd.no_progress": "{role} finished {n} turns without changing a file, a task or a note",
  "wd.circling":
    "{role} has rewritten {file} {n} turns running — probably a design problem, sending it to the Architect",
  "wd.env_suspect": "{resource} failed {n}x with no code change in between — treat the environment as the suspect",
  "wd.budget_exhausted": "{name} spent its whole budget ({tokens} tokens) and is suspended",
  "wd.budget_80": "{name} is at {pct}% of its budget",
  "wd.parked": "{name} parked after waiting {min} min — checkout kept, slot freed",
  "wd.waiting_on_you": "{name} has been waiting {min} min for you",
  "wd.unshipped": "{name} has every slice accepted, no PR and an empty queue — re-running the branch review",
  "rl.waiting":
    "rate limited; everything on this CLI holds until the window reopens (~{at}) and resumes itself — the quota belongs to the account, so no model spends less of it",
  "rl.resumed": "quota is back, resuming",
  "net.lost": "the host lost its network; {n} turn(s) held and re-queued, requirements left running",
  "net.back": "network is back, held work resumes",
  "repo.held":
    "GitHub no longer accepts this login, so every turn on {repo} is held — retrying cannot help. Reconnect GitHub in settings and they resume on their own. Other projects are unaffected.",
  "owns.reverted":
    "{role} wrote {n} files this group does not own ({files}) — reverted; this CLI's sandbox cannot stop the write, so the check runs after it",
  "unread.digest": "{n} unread — the Librarian is compressing them",
  sediment: "the same feedback for the {n}th time; asking the CoS to make it a project rule",
  hired: "hired {role}",
  "boss.reject_slice": "rejected the slice",
  /**
   * The watchdog's own findings, which is what the boss sees most of.
   *
   * Arguments are named for what they are — `{hours}`, `{cmd}`, `{ruleName}` —
   * because the panel-rendered version of these is a message id and a `values`
   * object, and `{h}` is not a name a translator can read. ADR 041 is where that
   * is going; this table is the half of it that has to exist first.
   */
  /**
   * A sentence with an optional clause is two rows, not one row and a fragment
   * concatenated at the call site. `waiting_merge` was
   * `` `…{hours} 小时了` + (behind ? `，后面还堵着 {n} 个` : "") ``, which fixes the
   * clause order in Chinese and English and has nowhere to put it in a language
   * that needs it first.
   */
  "wd.waiting_card": "{name}'s plan card has been waiting {hours}h for you",
  "wd.waiting_slice": "{name} S{seq} has been waiting {hours}h for you",
  "wd.waiting_merge": "{name}'s PR has been at the head of the merge queue for {hours}h",
  "wd.waiting_merge_blocked": "{name}'s PR has been at the head of the merge queue for {hours}h, with {n} behind it",
  "wd.broke":
    "the watchdog threw this tick and the rules after it did not run: {why}\nIt retries every 30s, but until it is fixed everything it drives — stalled groups, expired sandboxes, the rebase after a base moves, the clocks on what is waiting for you — stays where it is.",
  "wd.rule_broke": "watchdog rule {rule} ({ruleName}) threw; the rest of the tick ran: {why}",
  "wd.map_stale":
    "the repo map is stuck on its last version: {repo}'s container cannot read HEAD, and a rebuild would only produce a map with no symbols in it",
  "wd.map_failed": "the repo map cannot be refreshed: {repo} — {why}",
  "wd.map_no_remote": "this project has no remote recorded, so there is nothing to mirror",
  "wd.map_no_reason": "no reason given, which is itself a bug",
  "wd.base_moved": "{base} moved to {sha}; {name} is behind it and has been told to rebase first",
  "wd.waiting_parked": "{name} has been parked {hours}h — wake it, or drop it?",
  "wd.sandbox_swept": "{name} dissolved; its sandbox is reclaimed",
  "wd.sandbox_stale_cred":
    "{name}'s sandbox is bound to a superseded credential; reclaimed, and the next tick rebuilds it",
  "wd.server_gone":
    "opensandbox-server will not start; {n} attempts and no more automatic retries. Run it by hand to see what it says: {cmd}",
  "wd.server_restart_failed": "opensandbox-server was gone and the restart failed (attempt {n}): {why}",
  "wd.server_restarted":
    "opensandbox-server was gone and has been restarted (attempt {n}). Held work resumes by itself.",
  "wd.stale_ask": "{name} reached PR, so the question still hanging on it expired — closed by itself",
  "notify.batch": "{n} things need you:",
};

/**
 * `中文` (the configured default) or anything else, which gets English.
 *
 * Tolerates an absent language: a unit test builds a Ctx without config, and a
 * missing string is not a reason to throw inside a bus.emit.
 */
/**
 * A key this table has. Exported so a caller that wraps `say` can say so too:
 * `watchdog.ts` wrapped it as `(k: any)` and thereby switched the check off for
 * its fourteen messages.
 */
export type SayKey = keyof typeof EN_SAY;

/** Every key, for a check that has to walk them. */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Object.keys erases the literal keys that EN_SAY owns
export const SAY_KEYS = Object.keys(EN_SAY) as SayKey[];

export function say(lang: string | undefined, key: SayKey, args: Record<string, string | number> = {}): string {
  const table = isChinese(lang) ? ZH_SAY : EN_SAY;
  const t = table[key] ?? EN_SAY[key] ?? String(key);
  return t.replace(/\{(\w+)\}/g, (_m: string, k: string) => String(args[k] ?? ""));
}
