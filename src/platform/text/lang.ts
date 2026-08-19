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
 * row, so a key added to EN and not yet translated is a sentence in the other
 * language rather than a build error.
 */
const ZH: Partial<Record<SayKey, string>> = {
  "slice.ready": "S{seq}「{title}」做完了，等你查收",
  "slice.accepted": "查收 S{seq} {title}{why}",
  "slice.sentback": "S{seq} 被 {from} 打回（第 {n} 次）",
  "slice.failed": "S{seq} 连续 {n} 次没过 {from} —— 大概是验收标准的问题，不是代码",
  "slice.autoaccept": "{tier} 自动查收，三道闸全过",
  "gate.pass": "S{seq} 闸门通过",
  "gate.fail": "S{seq} 闸门没过",
  "gate.reconcile": "S{seq} 对账没过：{reason}",
  "gate.unclaimed": "S{seq} 还改了这些但没声明：{files}",
  "group.worktree": "开好沙盒，分支 {branch}",
  "group.approved": "计划卡批准，开工",
  "group.approve_held": "已记下你的批准。边界还挡着：{why}。让开之后自动开工，不用再点一次",
  "group.blocked": "被 {path} 挡住了，交给了另一条需求（grp {target}），它落地后自动继续",
  "group.unblocked": "挡路的 grp {target} 已经落地，自动继续",
  "group.dropped": "老板决定不做了{why}",
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
  "owns.reverted": "{role} 改了本组不拥有的 {n} 个文件（{files}），已回滚 —— 这个 CLI 的沙盒拦不住写入，只能事后对账",
  "unread.digest": "未读 {n} 条，已让 Librarian 压成摘要",
  sediment: "同一类反馈第 {n} 次了，让 CoS 归纳成项目规约",
  hired: "雇了 {role}",
  "boss.reject_slice": "退回了这一片",

  // preflight.ts and authflow.ts: panel diagnostic and login-flow text, ADR
  // 035 category 3. Namespaced by file so a key's origin is legible here too.
  "preflight.reachable.authRequired": "服务器开了鉴权，我们没带密钥",
  "preflight.reachable.keyRejected": "密钥不对，服务器不认",
  "preflight.chatgpt.stored": "存着",
  "preflight.chatgpt.expired": "过期了，重新登录一次",
  "preflight.chatgpt.daysLeft": "还有 {days} 天",
  "preflight.chatgpt.expiringSoon": "快过期了",
  "preflight.works": "能用",
  "preflight.notVerified": "没验成（HTTP {status}）",
  "preflight.unreachableNotVerified": "连不上，没验",
  "preflight.github.tokenRejected": "GitHub 不认这个 token 了",
  "preflight.credential.rejected": "对面不认这个凭据",
  "preflight.credential.notConfigured": "没配",
  "preflight.docker.installedNotStarted": "装了，但没启动（daemon 不理人）",
  "preflight.docker.fixNotRunning": "Docker 装了但没跑起来 —— 启动 Docker Desktop（或 colima start），等它变绿再回来。",
  "preflight.docker.fixNotInstalled": "装 Docker（或 Colima / Podman，任何提供 docker socket 的都行）并启动。",
  "preflight.uv.fix": "brew install uv —— opensandbox-server 是个 Python 包，没有它就没东西可启动。",
  "preflight.sandboxServer.fixContained":
    "这个 orchestrator 跑在容器里，起不了沙盒服务器，也不该起 —— 它要的是宿主的 docker。" +
    "在宿主上跑 uvx opensandbox-server，然后用 ORCH_SANDBOX_SERVER 指过去" +
    "（Docker Desktop 上是 host.docker.internal:8080，Linux 上用宿主 IP 或 --network host）。",
  "preflight.sandboxServer.fixHost": 'uvx opensandbox-server --config ~/.sandbox.toml，监听 {server}，[egress] mode 要是 "dns+nft"',
  "preflight.hostEnvironment.detail": "docker、uv、egress 镜像都归跑沙盒服务器的那台机器管，这儿看不到",
  "preflight.hostEnvironment.fix": "那台机器上要有：docker、uvx opensandbox-server、docker pull opensandbox/egress:v1.1.6。",
  "preflight.sandboxAuth.detail": "服务器没开鉴权，本机任何进程都能进容器",
  "preflight.sandboxAuth.fix":
    '在服务器的 TOML 里写 [server] api_key = "…"，重启，然后设置 → 沙盒服务器 → 「从服务器读」。容器里有仓库、信箱令牌和 CLI 登录。',
  "preflight.egress.fix": "docker pull opensandbox/egress:v1.1.6，然后把 [egress] image 指过去。v1.1.4 一绑凭据就 403 掉所有 scoped 包。",
  "preflight.agentImage.detail": "{image} 不在本机",
  "preflight.agentImage.fix": "docker build -f docker/agent.Dockerfile -t {image} . —— 没有 registry 前缀的镜像只能本地构建。",
  "preflight.skillsMount.none": "没有勾选的技能",
  "preflight.skillsMount.fixContained":
    "{staged} 是这个容器里的路径，而挂载是沙盒服务器的 docker 做的 —— 它按自己看到的路径挂。" +
    "两边要用同一个绝对路径（-v <宿主路径>:{staged}），并且写进沙盒服务器的 allowed_host_paths。" +
    "不一致不会报错，只会挂个空目录。",
  "preflight.skillsMount.fixHost": "沙盒服务器的 allowed_host_paths 要包含 {staged}，否则每个组开容器都会失败。技能在设置里勾。",
  "preflight.allowedPaths.noConfig": "找不到 opensandbox-server 的配置文件，没法核对",
  "preflight.allowedPaths.missing": "{config} 不含 {missing}",
  "preflight.allowedPaths.covered": "{config} 覆盖了要挂的 {n} 个路径",
  "preflight.allowedPaths.fix": "把这一行写进 {config} 的 [sandbox] 段，然后重启 opensandbox-server：\n      {line}",
  "preflight.credentialFix.claude":
    "设置页 → Claude → 登录。在工具容器里跑官方的 claude setup-token，本机不用装；页面给的码贴回输入框就存下了。一年有效。",
  "preflight.credentialFix.github": "设置页里连一次 GitHub。分支是靠它推上去的 —— 没有它，每个切片都会在最后一步被拒。",
  "preflight.credentialFix.codex": "设置页 → codex → 登录，走官方的设备码流程，本机不用装 codex。也可以直接贴一个 API key。",
  "preflight.codexRefresher.stale":
    "这个 ChatGPT 登录已经旧到该续期了 —— 下一个容器起来时会自动续，续不上就要重新贴 auth.json",
  "preflight.codexRefresher.fresh": "登录还新，续期在工具容器里跑，本机不需要装 codex",
  "preflight.codexRefresher.fix":
    "续期是在工具容器里跑真 codex 做的。如果一直续不上，去设置页重新贴一次 ~/.codex/auth.json，或者换成 API key —— API key 不需要续期。",

  "authflow.sandboxConfigMissing":
    "没找到沙盒服务器的配置。它是用 --config 启动的，把那个文件的路径放进 OPENSANDBOX_CONFIG，或者放在 ./sandbox.toml、~/.sandbox.toml。",
  "authflow.sandboxKeyInvalid": "沙盒服务器不认这个密钥。它自己的配置里写的是哪个，这里就得填哪个。",
  "authflow.claudeNoLoginLink":
    "容器里的 claude 没打印出登录链接 —— 镜像里跑一下 `claude setup-token` 看看（它需要一个 pty，没有 pty 时它什么都不打印就退出 0）。",
  "authflow.claudeLoggedIn": "claude 登录好了",
  "authflow.claudeLoginFailed": "claude 登录没成：{detail}",
  "authflow.noCode": "没有码",
  "authflow.noPendingLogin": "没有在等码的登录 —— 先点登录",
  "authflow.githubConnected": "GitHub 连上了",
  "authflow.githubConnectFailed": "GitHub 没连上：{detail}",
  "authflow.githubNoLoginCode": "GitHub 没给出登录码",
  "authflow.codexNoLoginCode": "容器里的 codex 没打印出登录码 —— 镜像里跑一下 `codex login --device-auth` 看看。",
  "authflow.codexLoggedIn": "codex 登录好了",
  "authflow.codexLoginFailed": "codex 登录没成：{detail}",
  "authflow.githubNotConnected": "还没连 GitHub，先去设置里连一下",
};

/**
 * English, and the list of keys that exist.
 *
 * Deliberately not annotated `Record<string, string>`. It was, and that made
 * `keyof typeof EN` mean `string` — so the `key` parameter below checked
 * nothing, in any caller, ever. `say` answers an unknown key with
 * `String(key)`, which does not throw and does not log: the literal
 * `wd.stalledd` goes into the boss's feed where the sentence explaining why a
 * group stopped was supposed to be.
 */
const EN = {
  "slice.ready": 'S{seq} "{title}" is ready for you',
  "slice.accepted": "accepted: S{seq} {title}{why}",
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
  "group.dropped": "dropped by the boss{why}",
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

  "preflight.reachable.authRequired": "server has auth on and we sent no key",
  "preflight.reachable.keyRejected": "wrong key, server does not accept it",
  "preflight.chatgpt.stored": "stored",
  "preflight.chatgpt.expired": "expired, log in again",
  "preflight.chatgpt.daysLeft": "{days} days left",
  "preflight.chatgpt.expiringSoon": "expiring soon",
  "preflight.works": "works",
  "preflight.notVerified": "not verified (HTTP {status})",
  "preflight.unreachableNotVerified": "unreachable, not verified",
  "preflight.github.tokenRejected": "GitHub no longer accepts this token",
  "preflight.credential.rejected": "credential not accepted",
  "preflight.credential.notConfigured": "not configured",
  "preflight.docker.installedNotStarted": "installed, but not started (daemon is not answering)",
  "preflight.docker.fixNotRunning":
    "Docker is installed but not running — start Docker Desktop (or `colima start`) and come back once it's green.",
  "preflight.docker.fixNotInstalled":
    "Install Docker (or Colima / Podman — anything that provides a docker socket works) and start it.",
  "preflight.uv.fix": "brew install uv — opensandbox-server is a Python package and has nothing to start it without one.",
  "preflight.sandboxServer.fixContained":
    "This orchestrator runs inside a container, so it cannot start a sandbox server here — and shouldn't, since it " +
    "needs the host's docker. Run uvx opensandbox-server on the host, then point ORCH_SANDBOX_SERVER at it " +
    "(host.docker.internal:8080 on Docker Desktop, the host IP or --network host on Linux).",
  "preflight.sandboxServer.fixHost": 'uvx opensandbox-server --config ~/.sandbox.toml, listening on {server}, [egress] mode should be "dns+nft"',
  "preflight.hostEnvironment.detail":
    "docker, uv and the egress image are owned by the machine running the sandbox server; not visible from here",
  "preflight.hostEnvironment.fix":
    "That machine needs: docker, uvx opensandbox-server, docker pull opensandbox/egress:v1.1.6.",
  "preflight.sandboxAuth.detail": "server has no auth on; any process on this machine can enter a container",
  "preflight.sandboxAuth.fix":
    'Write [server] api_key = "…" in the server\'s TOML, restart it, then Settings → Sandbox server → "Read from ' +
    'server". Containers hold checkouts, mailbox tokens and CLI logins.',
  "preflight.egress.fix":
    "docker pull opensandbox/egress:v1.1.6, then point [egress] image at it. v1.1.4 403s every scoped package fetch once a credential is bound.",
  "preflight.agentImage.detail": "{image} not on this machine",
  "preflight.agentImage.fix":
    "docker build -f docker/agent.Dockerfile -t {image} . — an image with no registry prefix can only be built locally.",
  "preflight.skillsMount.none": "no skills ticked",
  "preflight.skillsMount.fixContained":
    "{staged} is a path inside this container, and the mount is done by the sandbox server's docker — it mounts the " +
    "path as it sees it. Both sides need the same absolute path (-v <host path>:{staged}), written into the sandbox " +
    "server's allowed_host_paths. A mismatch does not error, it just mounts an empty directory.",
  "preflight.skillsMount.fixHost":
    "The sandbox server's allowed_host_paths must include {staged}, or every group's container will fail to open. Tick skills in Settings.",
  "preflight.allowedPaths.noConfig": "could not find opensandbox-server's config file to check against",
  "preflight.allowedPaths.missing": "{config} does not contain {missing}",
  "preflight.allowedPaths.covered": "{config} covers all {n} path(s) to mount",
  "preflight.allowedPaths.fix": "Write this line into the [sandbox] section of {config}, then restart opensandbox-server:\n      {line}",
  "preflight.credentialFix.claude":
    "Settings → Claude → Log in. It runs the official `claude setup-token` inside the utility container, nothing to " +
    "install here; paste the code the page gives you back into the input and it's stored. Valid for a year.",
  "preflight.credentialFix.github":
    "Connect GitHub once in Settings. Branches are pushed through it — without it, every slice gets rejected at the last step.",
  "preflight.credentialFix.codex":
    "Settings → codex → Log in, through the official device-code flow — nothing to install locally. Or paste an API key directly.",
  "preflight.codexRefresher.stale":
    "This ChatGPT login is old enough to need a refresh — the next container renews it automatically, and re-paste auth.json if that fails",
  "preflight.codexRefresher.fresh":
    "Login is still fresh; the refresh runs inside the utility container, nothing to install here",
  "preflight.codexRefresher.fix":
    "The refresh runs the real codex inside the utility container. If it keeps failing, re-paste ~/.codex/auth.json in Settings, or switch to an API key — those never need a refresh.",

  "authflow.sandboxConfigMissing":
    "Could not find the sandbox server's config. It's started with --config — put that file's path in OPENSANDBOX_CONFIG, or place it at ./sandbox.toml or ~/.sandbox.toml.",
  "authflow.sandboxKeyInvalid": "The sandbox server does not accept this key. Whatever its own config says, that's what belongs here.",
  "authflow.claudeNoLoginLink":
    "The claude CLI inside the container did not print a login link — run `claude setup-token` in the image and see (it needs a pty; without one it prints nothing and exits 0).",
  "authflow.claudeLoggedIn": "claude logged in",
  "authflow.claudeLoginFailed": "claude login failed: {detail}",
  "authflow.noCode": "no code",
  "authflow.noPendingLogin": "no login waiting on a code — click login first",
  "authflow.githubConnected": "GitHub connected",
  "authflow.githubConnectFailed": "GitHub did not connect: {detail}",
  "authflow.githubNoLoginCode": "GitHub gave no login code",
  "authflow.codexNoLoginCode":
    "The codex CLI inside the container did not print a login code — run `codex login --device-auth` in the image and see.",
  "authflow.codexLoggedIn": "codex logged in",
  "authflow.codexLoginFailed": "codex login failed: {detail}",
  "authflow.githubNotConnected": "GitHub isn't connected yet — connect it in Settings first",
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
export type SayKey = keyof typeof EN;

/** Every key, for a check that has to walk them. */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Object.keys erases the literal keys that EN owns
export const SAY_KEYS = Object.keys(EN) as SayKey[];

export function say(lang: string | undefined, key: SayKey, args: Record<string, string | number> = {}): string {
  const l = lang ?? "";
  const table = l.startsWith("中") || l.toLowerCase().startsWith("zh") ? ZH : EN;
  const t = table[key] ?? EN[key] ?? String(key);
  return t.replace(/\{(\w+)\}/g, (_m: string, k: string) => String(args[k] ?? ""));
}
