# PROGRESS

开发断点文件。换 session 或被 compact 之后，读 `CLAUDE.md` → 这个文件 → `PLAN.md` 就能接着做。

**更新时机**：每完成一个**可验证单元**就更新（不是每改一个文件）。可验证 = 有一条 runnable check 变绿，或手动端到端走通一步。

---

## 当前状态

**D4-3 已验证：** escalation 的 INSERT、默认值和开放问题判定收进 `mech/flow/escalate.ts`；去重范围不再从插入行的 `grp_id` 猜，凭据/GitHub 是全局 subject，预算是 group subject；前缀按绑定字面量比较，且去重检查与 INSERT 是一条原子语句。所有动态 subject 的反向清理使用同一字面前缀语义：合法仓库或开放 provider 名 `a_b` 不会再借 SQLite `LIKE` 的 `_` 通配误撤销/回答 `axb` 的待办，源码闸禁止 `question|brief|kind LIKE ?` 再进入。全部运行期调用方都走 `raise()`，`db.ts` 打开数据库时的数据修复是唯一有标记的直写例外；`test/escalate.test.ts` 的源码守卫会在下一处直写落下时直接报错。ask-boss 的 checkpoint/chain、slice/branch review 的 brief/kind、PR 失败和各调用方事件仍由原路径持有。动态清理回归 74 绿，`bunx tsc --noEmit -p .` 绿。

**Settings pane 拆分已验证：** 账号、GitHub、host/server 与项目设置分别只有 `settings/{credentials,github,environment,project}.tsx` 一份实现；不可逆的项目移除证据、确认和按钮仍在同一个 pane。409 行 dialog shell 持有全部 query、project scope、条件挂载、2/3 秒轮询、5 分钟截止与 cache invalidation；pane 只启动动作并请求刷新。`test/settings-boundary.test.ts` 守住 endpoint、DOM ID 和协调边界。TypeScript、oxlint、web build、90 个定向 checks 及完整测试全绿。

**PageIndex Codex 输出只解析一遍：** `readCodex()` 一次 NDJSON 遍历同时保留最后一条非空 agent message 和最后一条合法 usage；banner、坏 JSON、无关 item、乱序、空消息都不破坏已有结果，cached input 仍只计一次。`test/pageindex.test.ts` 11 checks 绿。

**语义状态政策集中完成：** `states.ts` 是 active job、dispatchable group、escalation open/terminal 政策的唯一来源；open 与 terminal 精确分割 canonical escalation 全集，成员受各自状态 union 约束，多状态 SQL 用 `json_each(?)` 绑定 JSON 数据，不拼 SQL。`test/states.test.ts` 守住 canonical/subset 关系、SQL 外观字符串仍只是数据，以及消费者不得重新手写同一集合。直接消费者定向 199 绿，TypeScript 与 oxlint 绿。

**HTTP JSON 边界已封：** 只有真正没有 body 的请求才以 `{}` 进入 schema；非空但无法解析的 JSON 直接 400，不再被吞成空对象后执行全可选控制动作。端到端回归证明 body 只有 `{` 的 pause 请求保持组为 RUNNING；API/smoke 定向 70 绿，TypeScript 绿。

**HTTP schema 输出真正进入 handler：** `route()` / `agentRoute()` 现在把 body 与 params schema 的输出类型和值一同交给 handler，Hono 动态注册使用官方 `app.on()`，不再靠 `Hono<any>`、双重断言或把已验证参数丢回原始字符串。所有动态 path 都必须声明 params schema；动态 row id 共用严格十进制 `Id`，`0x10` 不再被当成记录 16；合法 `z.string()` 输出也不再与错误 sentinel 混淆。gate 名称同一规则同时约束配置、旧 JSON reader 和日志路由，`lint@ci` 不会再写出一个读不回来的日志。通用 route 与 API 回归连同完整 `bun test` 726 绿，TypeScript、oxlint、web build 绿。

**外部 JSON 都先过边界：** Claude/Codex 流、PageIndex 结果和 GitHub device-flow 都用 Zod 解析后才读字段；JSON 合法但为 `null`、内容数组里是 `null` 或 usage token 是字符串时不再异常解引用、伪造用量或伪造成功。事件重放不再将 sqlite row 取成 `any`，项目配置在已有 row 上仍复用统一的 JSON object 窄化；专门回归与完整 suite 绿。

**JSON 边界的同类入口已封：** `jsonOr()` 必须同时拿到 Zod schema 和 fallback，调用方不能再用泛型把 `JSON.parse()` 的 `any` 宣称成业务类型；27 个持久化、CLI 和供应商响应入口都已迁移。GitHub client 的 endpoint schema 是必填参数，合法 nullable 字段不误拒，ETag cache 保存原始响应并按当前调用方 schema 重新验证；坏 job payload 不再静默丢字段，安全 mailbox id 的坏 envelope 会回 400。项目配置同样只有一个 `.passthrough()` schema，坏 `detected` / `gates` 会重新探测而不是永久冻结旧状态。边界定向 149 绿，TypeScript、oxlint、web build 绿。

**质量工具进入可复现链路：** Biome 是唯一 formatter，Fallow 3.16.0 固定为项目依赖；Tailwind v4 继续由官方 `@tailwindcss/cli` 构建，package script 直接调用本地 `tailwindcss` bin，Fallow 能从 manifest script 正确认出这份 dev dependency，不留 ignore。CI/release 都先预演 `fallow fix --dry-run`，再用固定版本的官方 Action 做 changed-code audit；PR 额外写 sticky comment 和 check。存量 findings 用提交进仓库的三份 baseline 隔离，新引入项仍阻断。

**项目沙盒 override 不再靠类型断言：** `sandbox.image: 7` 原来在 PATCH 的 `.trim()` 当场 500，`denyDomains: "x"` 则 200 持久化后以 `string[]` 身份进入 OpenSandbox 网络层。现在机器配置、项目 PATCH 与容器读取共用一个 Zod `SandboxSpecSchema`：入口拒绝坏内层类型且不改数据库，读边界对旧库/旁路坏值完整回退，拒绝镜像时 `base_branch` 也不会先被部分写入，局部 patch 不再静默覆盖损坏的整份 JSON。config/sandbox 定向 31 绿、完整 API 66 绿，TypeScript 与 oxlint 绿。

**旧报告逐项按当前分支复核，不重复实现：** pause/resume 统一入口定向 7 绿（`88aa1e7`）；job 结束立即补位定向 25 绿（`6445c48`）；bare mirror heads/refspec 定向 3 绿（`0706062`）。D2 点名的三个 handler 已分别位于 `api/orch/tasks.ts`、`api/panel/group.ts`、`api/orch/planning.ts`，当前没有第二调用方或重复政策证明需要再包一层 flow；`api.ts` 仍负责路由、中间件和 app 组装，并非纯 route table。Claude/Codex/GitHub 登录和 sandbox server start/restart 的 timeout/error 都会取消、返回失败或升级终止，专项 28 绿；SIGKILL 后再确认退出若有复现证据应另立问题。`db.ts` 运行期依赖 `scrub.ts`，反向只有 `import type`，编译后无循环。no-op 项不制造空提交。

**`bun test` 712 checks 绿（6 skip 是要可控的真沙盒服务器与密钥）。** `bun run dev`（构建前端 + 起服务），web 在 `http://127.0.0.1:47821`。

**你只需要三个动作**：丢想法 → 批 DRAFT 卡 → 查收切片。gate 探测、入职包、推送权限预检都在注册项目时自动完成。

### 还没被真实执行过的一步

**开真 PR。** 两侧都验过 —— preflight 打过真 API，squash + push 到本地裸仓库成功，`pollPrs` 的 MERGED 检测有 check —— 中间那一次 `POST /repos/{}/pulls` 没跑过。第一个需求收尾时会走到它；失败只影响这一步（分支和 journal 都已经在），会以 escalation 落到「待办」。

### 拿 orchestrator 自己当项目跑，要知道的两件事

PLAN §13 风险⑥「系统自己是最大的那个项目」现在是实际情况：

1. **跑着的进程持有旧代码。** agent 在自己沙盒的 checkout 里改的是源码；PR 合进 main 之后，**你手上这个 server 还是旧的**，要重启（`bun run dev`）才生效。合了 migration 就更要重启 —— 新列只在 `open()` 时补。
2. **`data/` 和 `web/dist/` 不进任何组的 owns**，公共文件同理（`package.json`、`src/db.ts` 的 MIGRATIONS 数组）。改这些要走 escalation，不然两个组同时加 migration 会撞号。

## 组的状态机

`PLANNING`（Dispatcher/Architect 规划中，**可派发**）→ `DRAFT`（卡片已交，**等你批，屏蔽派发**）→ `RUNNING` → `PAUSING`/`PAUSED`/`PARKED` → `PR_OPEN` → `DISSOLVED`

分开这两个状态是必须的：Dispatcher 得先跑完才有卡给你批。合成一个状态时，卡片永远写不出来。

## 里程碑

| | 内容 | 关键文件 |
|---|---|---|
| **M0** ✅ | 落盘与断点续开 | `PLAN.md` `PROGRESS.md` `CLAUDE.md` `docs/decisions/` |
| **M1** ✅ | 单组端到端骨架 | `db.ts` `scheduler.ts` `prompt/assemble.ts` `runtime/claude.ts` `api.ts` `bus.ts` `server.ts` `orch/cli.ts` `web/index.html` |
| **M2** ✅ | 安全边界 + 两级 review | `mech/{validate,lease,clearance,gate,reconcile,review,worktree,gitlock}.ts` |
| **M3** ✅ | 三级 intercept + 看门狗 6 条 + 通知 | `mech/{intercept,watchdog,notify}.ts` |
| **M4** ✅ | 代答链 + 撤销接管 + 反馈分诊 | `mech/chain.ts` + 8 个 `roles/*.yaml` |
| **M5** ✅ | file ownership + 串行 merge queue + PR-watcher | `mech/{ownership,mergequeue,prwatch}.ts` |
| **M6** ✅ | standup + 成本归因 + codex adapter + 归档 | `mech/{standup,cost,detect}.ts` `runtime/codex.ts` |


---

> 更早的记录搬到了 [`docs/progress-archive.md`](docs/progress-archive.md)：完成的里程碑验证、被后来架构取代的经过、一次性实测。下面留的是还会被读到的部分。

## 实测得到的、和直觉相反的事实（**别凭直觉改回去**）

**沙盒与成本**（`docs/decisions/001`、`002`）
- 沙盒**只有 deny 语义**：`allowWrite` 无法在 `denyWrite` 里开口子；不加 `denyWrite` 时写 cwd 之外是**允许**的
- `allowUnixSockets` 无效；`allowAllUnixSockets: true` 会连带打开 `/var/run/docker.sock`（一行逃逸）；`excludedCommands` 让**整条命令行**脱离沙盒。→ **localhost TCP + 每 agent token**
- `failIfUnavailable: true` 必开 —— 每种配错都是**静默**失效
- `--allowedTools` 只管权限、不裁 tool 定义。加 `--tools` + `--disable-slash-commands` + `--setting-sources project,local`：前缀 46k → 17.6k tokens、成本 $0.117 → $0.059。（`--disable-slash-commands` 后来撤了 —— 它的 help 原文是 "Disable all skills"，省下的这部分是拿整个技能功能换的，见 `docs/decisions/006`）
- **每个角色都要只读 shell**（`ls`/`cat`/`find`/`grep`/只读 git）。只给 `Bash(orch *)` 时规划岗的 `ls`、`cat` 全被拒，而 headless 下拒绝是**静默的** —— 它们只是看起来困惑并白烧 turn
- **管道把 `orch` 放最前面**：权限检查读命令行开头
- **复合命令要求每一段都命中规则**，所以少一个只读 builtin 就废掉整行 —— Auditor 的 `ls && cat package.json && (test -f tsconfig.json && …)` 被整条拒。`cd`/`pwd`/`test`/`basename`/`dirname` 现在都在只读白名单里

**「给了 agent 一个它用不了的标识」—— 同一类 bug 犯了四次**
- `orch task list` 返回 JSON 数组 → agent 把 title 当 id 传
- delta 里写 `Slice S1`（组内序号）→ QA 拿不到 `orch review` 要的数据库 id，跑完不交判决
- 批准 DRAFT 不建 task → 写方自己编了个 id，`task done` 永不落地、**整条 review 流水线静默不触发**
- Dispatcher 用组名 `orch draft greet -`（它只看得见名字）
  → 规律：**agent 看得见的标识它一定会用 —— 要么接受它，要么根本别给它看**。现在 `task list` 输出行、delta 给 `slice_id N` 并附上填好 id 的命令、group 同时接受 id 和名字

**对账层曾经名存实亡**
- Engineer 从不传 claim（contract 里 `task done <id>` 后面没写 `--claim`，它就不用），于是「声称 vs 实际」退化成「有没有改动」—— 正好绕过它要抓的那个失败。现在**空 claim 直接拒收**。
- 反向问题同一次跑出来：切片 1 的 Engineer 把整个功能实现完了，切片 2/3 真的没活干，reconcile 判成造假、打回三次后升级。现在有 `--already-done "<why>"`：reconcile 接受，但 **gate 和 QA 照样得过** —— 它是对历史的声明，不是跳过验证的口子。
- 根因是切分质量：Dispatcher 切出的是「加参数 / 实现分支 / 补测试」——同一个改动的三个步骤，不是三个能独立交付的东西。抽象规则（「切片必须独立可验收」）已经在 prompt 里且**没用**，现在换成把那次的真实反例写进去。

**「给了任务但没给做这件事需要的信息」—— 犯了三次，每次 agent 都编了个看起来合理的动作**
- `orch mail` 唤醒常驻收件人，但信的内容没随 job 递过去（它不在发信人的频道里）→ 空 prompt 崩了
- 边界请求 enqueue 了 `payload.boundary`，但 delta **没有对应的渲染分支** → Architect 发了句 `orch status "…准备划定 src/bye.ts 边界"` 然后什么也没做
- 边界 delta 只附了**新组**的需求 → 两个组要切时它分不清谁是谁，把 greet 的文件划给了 farewell 组
  → 现在：信随 job 走；payload 出现没人渲染的键会**发事件点名**；每个组的原始需求都引在它自己那条命令旁边

**server 重启会永久卡死一个组（已修）**
上一个进程在 turn 在飞时退出 → 那条 job 永远停在 `running` → 它占着组的唯一槽位 → **那个组再也派发不出任何东西**，而队列看起来完全健康、什么都不报错。agent 也卡在 `running`，而 running 的 agent 会被跳过。
这是最难发现的形状：没有错误，只是不动了。现在启动时先回收孤儿（进程没了 / 没记 pid / 跑了超过 4 倍 turn 超时），标 failed 并写明原因，并发一条「回收了 N 个」的事件 —— 重启回收了东西要看得见，不能靠猜。

**回收槽位 ≠ 恢复工作（第二层，已修）**
上面那条只解开了**队列**。那条 turn 本身还是丢了：slice 停在 `running`，`startNextSlice` 数着它算「组正忙」，于是再也不排新活 —— 同一种沉默，往下一层。现在回收之后按原 kind / grp / slice / payload **原样重排**（slice 状态不动，worktree 里的半成品留着，等同 `interrupt` 的 `keep`），payload 打 `resumed` 标记，所以**只重排一次** —— 一条能把 server 带崩的 turn 不会被无限复活。看门狗 / 通知 / digest 不重排，定时器本来就会补。
另外 Ctrl-C 以前会把 turn 的子进程留在世上：下次开机看到 pid 还活着就**不肯**回收，那个组要挂到 4 倍 turn 超时。现在 SIGINT/SIGTERM 先把 `running` 的 job 的 pid 全 SIGTERM 掉再退。

**五个「需求会永远停在那」的终局，逐个堵掉**
1. **封存是系统唯一一个自己造成、自己不解开的状态。** `answer()` 把 PAUSED 的组唤醒，却静默跳过 PARKED —— 组等太久被封存后，**老板回答了它等的那个问题，眼睁睁看着什么也没发生**。现在「停下之后才被回答的 blocker」会自动唤醒（判据不能是「没有未答的 blocker」：多数封存组压根没有 blocker，那样会在同一个 tick 里把刚封存的又唤醒）。封存太久还没人管的，每 6 小时提醒一次，唤醒和不做了都在需求页上一键可达。
2. **`blocked_on` 成环。** A 等 B、B 等 A，两个都 PAUSED、都有正当理由，谁也不会解散。`orch blocked` 现在沿链走一遍，指回自己就拒。
3. **合入队列的头堵死就全堵死。** 队列严格串行而没有时钟 —— 「老板忘了」和「刚进队一分钟」长得一模一样。记下进队时刻，队首超时就提醒，并说清后面堵着几个（有人被堵时算 blocker）。
4. **建 worktree 永久失败会无限重试。** `sweepApproved` 跑在看门狗 tick 上，磁盘满、分支名冲突这类失败一辈子好不了，它每 30 秒重试一次并把错误返回给不存在的人。现在失败一次就撤销批准意向 + 落一条 blocker 给老板。
5. **三个「等你」的地方没有时钟**：计划卡待批、切片待查收、PR 待合入。它们**本来就该等**，缺的是它们等得悄无声息 —— 4 小时后提醒一次，之后每 6 小时（不是 30 分钟，那样的提醒只会训练人忽略整个 feed）。

**撞到自己边界外的缺陷时，组现在能把活交出去并自己等回来**
`pm-ai-agent` 的闸门挂在 `tsconfig.json` 少一行上。那文件不在它的 `owns` 里，沙盒直接挡死。它**改不了**、**开不了新需求**（没有这个动词）、**也没法把问题交给别人**（`orch mail` 只是消息，消息不产生工作）。于是它重写了三遍自己的代码、耗尽重试、升级、停住。老板收到一条没有按钮的 blocker，另外四个组同时红在同一行上。

`orch blocked <group> --path <file> --why "…"`。证据就是路径本身：服务端核对文件真的存在、且真的在本组边界之外。**「我够不着」是关于仓库的事实，不是关于活有多难的说法** —— 这是它和「逃避难活」的区别。在自己边界内说被挡住，直接拒。
去向由服务端决定，不由 agent 挑：活着的组拥有那条路径 → 作为补充要求给它（另开一个组会被 `canStart` 挡掉，等于开了一个永远起不来的需求）；没人拥有 → 变成一条正常需求，老板照常批。两种情况调用方都记下 `grp.blocked_on` 并 PAUSED —— 没有合法动作可做的组不该占着并发槽。看门狗规则 10 看到它等的那个组 DISSOLVED 就自动放它继续。
→ 规律：**每一条「我做不了」都要有一条能落到另一个人身上的路，否则它只能变成一条停住的组和一条没有按钮的通知。**

**PR 不再能合入时，去解冲突的是 Engineer**
以前没人看 `mergeable`：分支陈旧了就那么停着，组是 `PR_OPEN`、队列空，唯一的发现途径是老板自己打开 GitHub。现在 conflicting 和红 check 走同一条去重签名（不会每 30 秒吵一次），但派的是 engineer 不是 pm —— 读评审、决定让哪一步是 PM 的判断，`git rebase` 不是。

**已经做完的需求，规划岗现在能说「这条不用做」**
`PLAN.md` §13 风险① 的第一条确定性防线。以前 Dispatcher 没有这个出口：重复的需求、或者老板打字到它读代码之间已经被修掉的需求，它照样深挖、照样切片、照样交一张卡，全靠老板在 DRAFT 那 20 秒拦。
`orch drop <group> --why "…" --duplicate <group> | --commit <sha>`。**agent 不能自己解散组** —— 「这里没什么可做的」是疲惫的模型最容易得出的结论，任何提示词都撑不住它是省事的那条路。所以它只能**提议**，而且要付**服务端自己核得动的证据**：`--duplicate` 那个组真的存在，`--commit` 那条 commit 真的在仓库里（`git cat-file -t`）。老板在审批区看到证据，一键确认或「不，接着做」。
→ 规律：**给 agent 的每个出口都要问「偷懒的时候它会不会走这条」**。会走，就必须付一份服务端核得动的证据 —— 光靠 prompt 说「只有真的重复才用」等于没说。

**审批那一屏的四条出路**
只有「批准开工 / 退回重拆」，而说话的输入框在整页最底下 —— 老板对着卡补的话去了哪、会不会被看见，界面从来没说。现在四条出路（批准开工 / 要求修改 / 退回重拆 / 不做了）连同输入框一起就在卡旁边，每个按钮写明这句话发给谁。

**「队列空」是这个系统唯一真正的故障形状**
一天之内同一个形状撞了五次，每次表现都一样：**状态是活的，队列是空的，界面显示在干活，没有任何错误**。
- turn 在飞时重启 → job 停在 `running` 占着槽位（回收孤儿）
- 回收了但没重排 → slice 停在 `running`，`startNextSlice` 数它算忙（重排一次）
- `--settings` 传相对路径 → worktree 里的 turn 全部秒退，失败是终态没人续
- turn **正常结束**却没安排下一步（Dispatcher 跑完没交卡）→ 和成功长得一模一样
- 组在 `DRAFT`，而批准被挡时系统给它派了架构师切边界的 turn → `DISPATCHABLE` 不含 DRAFT，那条 turn 永不派发。**边界永远切不好、批准永远落不了地、老板被告知「再点一次」** —— 三个组同时挂着这样一条 job

现在：**活着的组队列为空本身就是故障**，不看上一条 turn 的退出码（看门狗规则 8，重排一次，再不行就找老板）；DRAFT 只挡写方（engineer/pm/qa/auditor），规划岗（dispatcher/architect/cos/librarian）放行；已解散的组的 pending job 直接取消（规则 9）。
→ 规律：**每条链路都要问「这一步之后谁来排下一步」，没有答案就是一个静默死锁。** 确定性兜底必须建立在「状态 × 队列」的矛盾上，不能建立在错误信息上 —— 这类故障根本不产生错误信息。

**批准了但落不了地（已修）**
老板报「有的需求无法批准开工」。三个缺口叠在一起，最后一个才是真正堵死的：
1. `canStart` 挡下就 `return bad`，**老板的表态没有任何地方记着**，组留在 DRAFT
2. 边界后来切好了（`orch owns`）、挡它的组后来合入了，**没有任何地方重跑这个组**
3. 错误信息叫老板「等切好了再批一次」，而**再批一次必然 500**：第一次批准已经写进了 slice **和** task，第二次 `DELETE FROM slice` 撞上 `task.slice_id` 的外键。它指的那条路本身是死的
现在：批准落成持久意向（`grp.approved_at`），被挡就记下来并**返回 200**（422 弹红 toast，等于说「你没决定」）；开工只有一个入口 `startGroup`（worktree → RUNNING → 起第一片），批准和自动开工共用；`orch owns` 之后扫一遍全项目（重切边界放行的常常是**别的**组），看门狗每 tick 兜底一次（挡它的组也可能是合入、被拆、封存后解散的 —— 挂四个钩子就是四个会忘的地方）。面板上这种组从「待办」挪到「停着」，写明谁挡着、让开会自动开工，出路仍是「退回重拆」（会撤销批准）。
→ 规律：**一次点击必须终局。** 让老板「等会儿再点一次」，等于把调度器的活派给人，而人不知道什么时候该点。

**「静默 no-op」是最贵的失败模式**
- `orch mail architect` 在没有 Architect 时静默丢弃 → Dispatcher 对着墙问了两次就放弃，卡片没交。现在：不存在的收件人报错并列出存在的角色；配置里有但还没雇的**常驻岗第一封信就是雇它的事件**
- 常驻 agent 通过 mail 被雇时没继承 project → cwd 退化成 server 的工作目录，**Architect 跑去读 orchestrator 自己的源码**。现在常驻 agent 按 project 归属，且回信优先找**已存在**的角色持有者（否则一个项目雇了两个 opus Dispatcher）
- 打印不等于记录：contract 里现在明说「任何要留存的东西都得走命令，否则就是没发生」

**其它**
- **reconcile 要比工作树**，不能比 `sha..HEAD` —— 它在 `task done` 那刻就跑，那轮改动还没 commit
- **task 只在它所属切片开工时可见可完成**，否则写方会把没开工的切片标完成，把它们推进 review
- **`git -C <path> rebase` 会绕过 repo 写锁**：跳过 flag 时必须连它的值一起跳
- **`staticPrefix` 对无通配符路径不能回退到目录**：`package.json` 会变成空前缀，而空前缀「与全仓库重叠」
- **`\b其实\b` 永不匹配**：汉字之间没有 word boundary
- **PR 的失败 check 只在状态变化时报**，否则同一条红 check 每 30 秒唤醒 PM
- **`grp_id` 为 null 的 job 曾绕过所有准入检查**，包括并发上限 —— 常驻岗的 turn 照样花钱，不该有特权
- **工位墙不显示裸工具名**：`content_block_start` 早于 input 到齐，报出去会把有用的一行覆盖成 `Bash`


## 已知偏离 PLAN.md


- 新增状态 `PLANNING`
- `grp` 无 `channel_id`；`worktree` 列被 024 删掉（从来没被写过）；增加 `owns_json` / `spent_usd` / `paused_at` / `merge_seq` / `pr_number` / `pr_seen_at` / `pr_checks_sig`
- `agent` 增加 `token` / `stable_hash` / `idle_turns` / `loop_file` / `loop_count`
- `slice` 增加 `gates_json` / `depends_on` / `base_sha` / `retries`；`job` 增加 `slice_id` / `checkpoint_sha`；`lease` 增加 `head_sha`
- 传输层从 unix socket 改成 localhost TCP（决策 001），再改成**文件信箱**（决策 005：`host.docker.internal` 只有 Docker Desktop 有）
- `profiles/` 按组生成 —— 后来整个删了（决策 005，容器就是边界）
- **intent 只有 5 种**（`ask`/`request`/`inform`/`note`/`decision` + 正交字段）
- 迁移共 8 条，全部 append-only


## 边界收尾：三个真 bug，加四条从来没跑过的路径

005 把边界换成容器之后，宿主侧留下的东西分两种：**还在守着的**（信箱前缀闸、token、lease 模板校验、`shq`、凭据金库、只读 GitHub token + bundle-out、`scrub`、watchdog 17/17b、组间路径冲突、repo 写锁）和**看起来在守、其实早就断了的**。这轮扫的是后者。

**`reconcileOwnership` 从来没跑成功过。** 005 之后它是文件归属的**唯一**强制手段（deny-list 删了，`engineer.yaml` 还在对 agent 承诺这件事），而它拿**宿主**的 git runner 去打 `/work` —— 宿主上没这个目录，每个 turn 都抛。断言只覆盖了纯函数 `outsideOwns`，接线没有任何 check。现在是 `sandboxGit`，并且补了那条接线 check。

**两条 `/orch` 读路由从来不看 token。** `GET /orch/task` 和 `GET /orch/lease/:id/log` 不调 `agentOf` —— 信箱的 `/orch/` 前缀闸管的是「哪些路由够得着」，不管「谁在够」，所以任意组在 URL 里换个数字就能读别的组的任务卡和构建日志。lease log 还拿 agent 给的字符串 `new RegExp` 在宿主单进程里跑（一个嵌套量词就能卡死整个 orchestrator）—— 构建日志用子串匹配就够。

**`orch split` 的组名是 agent 给什么算什么**（`.trim().slice(0,40)`）。这个名字会变成 `orch/<name>` 分支、`docs/journal/<name>/` 路径、和一条 shell 命令的参数。现在一律走 `slug()`，journal 的 `mkdir` 也套上 `shq`。

**四条路径读的是一个从来没被写过的列。** `grp.worktree` 在 schema 里、被四处读、全库没有一处写。四处全部 `if (grp?.worktree)` 守着：「打断并回滚」只打断不回滚、封存唤醒不 rebase、撤销代答不撤销工作、**reconcile 闸门拿空变更集给每条 claim 打分**（= 全过）。全部换成 `sandboxGit` + `/work`，列删掉（024）。

**为什么测试一直是绿的**：它们自己在 fixture 里写 `worktree`，指向一个宿主临时目录，然后断言那个目录变了 —— 一个生产环境从来没产生过的状态。现在断言的是发到组沙盒里的命令。

**`orch git --` 这个动词不存在**，而 prompt 的 `orch` 速查表里有它，watchdog 和 PR 冲突的退回话术里也在教 agent 用它（硬约束 6：prompt 给的许可校验器不认，就是在教模型撒谎）。沙盒里 `git` 就是 `git`，push 不到远端 —— 宿主从 bundle 里取分支再 push。

`linkAgentsMd` 同样是宿主对 `/work` 做 `symlinkSync`，`existsSync` 守卫让它静默空转 —— 挪进 `createCheckout`，一条 `ln -s`，check 直接跑那个命令串本身。

**没动、但记在这儿**：信箱没有大小上限也没有超时；`env.id` 不校验就拼进 `/var/orch/res/${id}.json`（容器内路径穿越，agent 本来就有 shell）；token 不和来源沙盒绑定（同组共用一个容器，跨组不行）；`orch mail` 打给一个没雇的角色会雇一个，没有成本上限。都是 DoS / 自伤级别，不是越界。

`bun test` 506 pass（3 条 sandbox-live 没有服务器，跳过）。

## 开源前的边界收尾：一个沙盒逃逸、一个自毁凭据、断网自动挂起

四个问题一起做的一轮：容器化后还有没有冗余安全措施、pageindex 是不是通用的、开源前的漏洞与泄露、断网怎么自动挂起。前两问的答案改变了后两问的形状，所以合成一轮。

**沙盒逃逸，端到端复现过。** `mailbox.ts` 的 `/orch/` 前缀闸是整个沙盒信任边界所依赖的**唯一**一个 `if`（它自己的注释写着 "this is an `if`, not a line in a role prompt"）。它对**原始字符串**做 `startsWith`，然后把同一个原始字符串拼进 `fetch` —— 而 `fetch` 走 WHATWG URL 解析，点段会被归一化：

```
prefix check passes: true
server saw: /api/auth
```

`/orch/../api/auth`、`/orch/%2e%2e/api/dirs`、`/orch/x/../../api/state` 全部通过，而 `/api/*` 一个鉴权都没有。于是容器里的 agent 能读任意宿主文件（`/api/attach/local` 复制进来，`/api/attach/<name>` 取回）、遍历宿主文件系统、清空老板凭据、批准自己的 DRAFT、查收自己的切片。**正是上一轮修的同一个洞，换了个形状回来** —— 上次修的是「哪些路由够得着」，这次是「判的和发的不是同一个字符串」。现在归一化之后再判断，并且把归一化后的 pathname 交给 `fetch`。

**codex 凭据会被自己种的假值覆盖。** `filesFor` 往容器写 `decoyAuth()`，turn 结束后 `executor.ts` 又把 `${CODEX_HOME}/auth.json` 读回来存进 `runtime_auth`，全部校验只有「是 JSON」和「和当前不同」。decoy 和真值不同 → 存下 decoy → **第一个 codex turn 就把真登录换成假的**，之后 sidecar 注的是 `decoy-aaa…`，全舰队 401，表现成「账号过期了」。而 `preflight` 对被覆盖后的假凭据**报绿**：它只解 JWT 的 `exp`，`decoy-aaa…` 不是 JWT，`jwtExpiry` 返回 null 就走 `{ok: true}`。

修法不是加三道校验，是**删掉写回路径**：沙盒里那个 `auth.json` 是我们自己写进去的 decoy，而 `decoyAuth` 特意把 `last_refresh` 盖成当下，目的就是让 codex 别去刷新。设计上「一个登录，一个续期者，在宿主」。所以这条读回路径能读到的永远只有我们种的假值 —— 它不是缺校验，是只有害处。测试断言的是源码里不再有这个调用，因为原来的失败正是两个各自正确的部件（写 decoy / 吸收 rotated）之间没人连起来。

**附件功能自 005 起就是死的。** `withAttachments` 把宿主绝对路径写进消息体，`imagePaths` 挑出来，codex 直接 `-i <宿主路径>` 传给容器里的进程。全仓 grep：**没有任何代码把附件送进沙盒**。claude 那侧更隐蔽 —— agent 被要求 `Read` 一个不存在的路径，工具调用失败，agent 绕过去接着干，turn 报成功。现在 turn 组装时 `putBytes` 进 `/var/orch/attach/`，消息体改写成容器路径；送不进去就发一条事件，不再静默。

**codex-home 一分为二，两个机制都指着没人写的那半。** `CODEX_HOME` 是容器路径，而 `codexUsage` 和 `sweepCodexSessions` 读的都是宿主的 `<dataDir>/codex-home` —— 今天还往那儿写东西的只剩每周一次的续期 nudge。所以头部的 codex 额度条反映的是那一次 `reply with: ok`。现在额度先从活着的沙盒读最近的 rollout（宿主作兜底），清理走沙盒里一条 `find -mtime +7 -delete`。

**所有模型调用统一进沙盒。** `modelAsk`（pageindex 的索引和检索，系统里最频繁的模型调用）原来是宿主裸 `Bun.spawn`，用的是**老板个人的 CLI 登录**，不是设置页存的 `runtime_auth`，也不过金库 —— 自建网关配了 `baseUrl` 它根本不走。而且 `summarise` 先写签名再 `await ask`，`modelAsk` 失败返回 `""`：宿主没登录过 codex 的机器上，每个节点存空摘要 + 匹配的签名，下一 tick 命中缓存，**整棵树永久是空的且看起来是「已建好」**，没有任何探测器会发现。

现在 `modelAsk(ctx, spec, scope)` 走 `execIn` 跑在项目沙盒里，prompt 走文件、每次唯一文件名（`/tmp/orch-prompt.txt` 原来是每沙盒一个固定名，今天撞不上只是因为常驻角色全共用调度槽位 0）；签名只在拿到答案时才写，一整轮全失败就发一条 blocker。加了一条 grep 断言守着：`src/` 里除 `login.ts` / `chatgpt.ts` 外不许再出现 spawn `claude`/`codex`。代价说清楚：`commands.run` 中位数 ~1000ms，检索最多 3 跳，等于给每个 turn 的第一步加约 3 秒 —— 换掉的是那条没有探测器的影子凭据路径。

**索引的花销上账了。** 它不是 turn，`cost.ts` 读的是 turn，所以这笔钱在成本页完全不可见。现在 `modelAsk` 带出 usage（codex 的 `turn.completed` 本来就在输出里被读过去丢掉了；claude 那条加 `--output-format json`），记到一个常驻的 `indexer` agent 行上 —— 一行记录，不是一个角色。不并进 librarian：真 librarian turn 带完整前缀和 session，和一次性索引调用单价差两个量级，混在一起这个数字就没法用。也不做成真角色：`orch ctx query` 在每个 turn 的关键路径上，而调度器一个槽位只跑一个 turn，agent 问一句要等自己占着的槽位。

**pageindex 的语料口径反过来写。** 原来树的过滤器只认 `ts|tsx|js|jsx|md|yaml|yml`，接一个 Go/Python/Rust 项目进来源码整个不可见。而 repomap 那份「更全」的 18 种扩展名列表也是假的 —— 配套的符号正则是纯 JS/TS 语法，对 Go 文件一个符号都提不出来。实测本仓库那个 allowlist 的全部作用是挡掉 8 个文件（207 → 199），其中只有 lockfile 是真该挡的。**allowlist 这个形状本身就是错的**：扩展名猜不完，而二进制和产物的集合跟语言无关、是稳定的。现在两个索引共用一个 `indexable()`：二进制/资源 denylist + 名字 skiplist + 每项目可改的 `config_json.index.exclude`（照抄 `detect.ts` 对闸门定下的规矩：best-effort，写在能改的地方）。

**知识库存哪**：全在 orchestrator 自己的 sqlite，`note` 表 `kind='pageindex'` / `kind='map'`，每个项目恒定两行，目标仓库一个字节都不写。顺带修了一个真 bug：`ctx.ts` 取 note 时不过滤 kind，这两行 `project_id` 非空、`KIND_WEIGHT` 没有条目所以按 ×1.0 参与 BM25、内容一变就重写所以常驻最近窗口 —— 命中一次就把整棵序列化的树塞给 agent，吃光 char 预算。

**断网自动挂起。** 什么都不做的话：CLI 一直退避重试 → 撞 `turnTimeoutMs` → 规则 1 把组 `interrupt` 成 **PAUSED** → 而 PAUSED 是没人会主动推出去的状态，park 计时器把它封存，联网后老板面对一堆要手动重启的组。

所以照抄调度器里已有的两个全局准入闸（`providerHeld` / `credentialMissing`）加第三个：离线时 `agent_turn` 不派发。被闸住的 job 只是没被取走 —— 没有进程、没有重试循环、不花钱。翻转的那一刻掐掉在跑的 turn 并直接重排，**组的状态一个字都不改**：组还是 RUNNING，活儿变回 pending，闸压着，联网后闸一开自己排干。`resumeReclaimed` 里 `orphaned:` 的豁免扩到 `offline:` —— 被网络掐掉的 turn 不该花掉它唯一那次重试。**没有新状态，没有恢复时的簿记。**

探测目标从金库绑定的 host 推出来，零配置，自建网关换了 `baseUrl` 探测目标自动跟着换。判据故意弱：**任何 HTTP 响应都算在线，401/403 也算** —— 凭据被拒不是网络问题，把它当断网会因为一个坏 token 停掉整个舰队（`preflight` 早就是这么划线的）。只有传输层抛错才是离线。离线的 tick 直接返回，底下那些规则全是我们自己记下来的状态的复述，不值得每条一次两秒 DNS 超时。

**顺带扫掉的边界错配**（同一类，共同形状是「错的那侧被一个 `existsSync`/`.catch(() => {})`/`if (code !== 0) return` 兜住，于是错误路径长得和成功一模一样」）：
- `orch blocked --path` 拿宿主主检出校验 agent 从 `/work` 里报的路径 —— 组自己新建的文件被拒，还说「这个仓库里没有这个文件」。**这条断言原来一直是被 `why.length < 10` 挡下的，存在性检查从来没被测到。**
- `orch drop --commit` 的 `cat-file` 打宿主检出，祖先判定用宿主 `HEAD` 而不是 `baseRefFor()` —— 结论取决于老板本地切在哪个分支。
- DRAFT 卡的「未知路径」提示同样读宿主工作树，改成 `ls-tree` 基线。
- 规则 15 的 rebase 判据：克隆没 fetch 过，`merge-base --is-ancestor` 对「对象不认识」和「你落后了」返回同一个非零码。先 `cat-file -e`，不认识就 fetch，还不认识就不是 rebase 能解决的事。
- `reconcileOwnership` 沙盒够不着时静默 `return` —— 这是 005 之后**唯一**的文件归属强制手段，`engineer.yaml` 还在对 agent 承诺它。现在发事件。
- gate / lease 的日志提示把宿主路径印进 agent 上下文，改成只给动词。
- `orch` 在闸门/lease/install 里没有 `ORCH_MAILBOX`，掉到容器内的 127.0.0.1 上 —— 不给它们 token（那会扩大 token 的可读范围），而是把「连接被拒」换成一句说清楚为什么的话。
- `ArgSpec.mustExist` 声明了没人查（要查也只能是沙盒里的 `test -e`，不是宿主 `existsSync`），删了；`resource.cwd` 没人写但留着，注释写明它是容器路径 —— `grp.worktree` 就是这么错的。

**其余 P1**：`decoyAuth` 原来把**真 `id_token`**（一个签名 JWT）透传进沙盒，直接违反「真 token 永不进沙盒」（`account_id` 不改 —— 它是标识符不是凭据，改了每个 codex turn 都会挂）；`git clone` 用 `JSON.stringify` 拼命令，双引号下 `sh` 照样展开 `$(...)`，同文件其他七处全用 `shq`；`getGateLog` 拿查询参数 `new RegExp` 在宿主单进程里跑（隔壁 `getLeaseLog` 特意避开了，注释都写了，规则没推广过来）；`/api/*` 全部无鉴权且 `body<T>()` 不校验 content-type，`text/plain` 的 POST 是 simple request 不触发预检 —— 加了 `Sec-Fetch-Site`/`Origin` 的 deny-list 守卫，不动前端；`/orch` 的写路由拿调用方给的 `group_id` 不校验归属，判据按角色作用域（常驻角色判同项目，组内角色判同组）。

**没有一层安全措施是冗余的** —— 容器（写边界）/ 金库（凭据边界）/ `orch` 校验（动作边界）三层互不重叠。扫出来的全是残骸：`workRoot` 死了（唯一消费者是 `refreshIndex(ctx, _workRoot)`，下划线开头就是不用）、role fixture 里的 `clearance`、`gate.ts` 的死导入、`narrate` 的死参数、`config.ts` 里一段过期的理由（结论对、理由错，下一个读它的人会照着错的理由重建错的模型）。`--add-dir` / `allowedTools` 的 hash 项**不动** —— 删一次全舰队 session 轮转一遍，换一个空转 flag，不值。

**README 加了「沙盒挡什么，不挡什么」**：出站是 `defaultAction: allow` 加空黑名单，凭据受控、**数据不受控**。这是 005 的明确取舍，但读者会默认「沙盒」等于「数据不出去」，开源前必须写在看得见的地方。

`bun test` 539 pass（3 条 sandbox-live 无服务器跳过），`bunx tsc --noEmit -p .` 干净，`bun run build:web` 通过。

**没验的**：断网只能手动拔网线验；模型进沙盒要配一个和宿主 CLI 登录不同的凭据跑一次 `orch ctx query`；claude 的 `--output-format json` 输出形状按 stream-json 的 result 事件推的，解析失败会退回纯文本。

### 收尾：把上面那轮自己引入的每-tick 开销掐掉

写完回头算了一遍 30 秒一次的东西，三处是这轮新加的浪费，`maxGroups` 默认 10 的时候尤其明显：

| | 原来 | 现在 |
|---|---|---|
| `probe()` 出网 HEAD | 每 tick 2 次 = **5760 次/天** | 在线时 5 分钟一次 = 288 次/天；离线仍每 tick，恢复才够快 |
| codex session 清理 | 每 tick **串行** 11 次 `execIn` ≈ 11 秒 | 每小时一次，`Promise.allSettled` 并行 |
| 沙盒里读额度 | 每 tick 1 次 `execIn` | 跟 `POLL_EVERY_MS` 同一个闸，10 分钟一次 |

后两条不只是浪费 —— `commands.run` ~1s，它们是在 agent 自己的容器里跑，抢的是容器被 cap 住的那点 CPU。七天保留期不需要一分钟强制两遍。

**还有一条会直接卡并行的**：`orch ctx query` 原本一律走**项目沙盒**，理由是「答案不该取决于谁问的」。但那条推理是错的 —— 这个 walk 什么文件都不读，菜单是从库里的树摘要拼的，模型只回 id，容器换成哪个都不影响答案。而它是 `assemble.ts` 让每个角色**第一步**就做的事，十个组的第一步全挤进一个容器、一份 CPU 配额。现在跑在**调用方自己的沙盒**里，十个组就是十个容器。索引**构建**仍然是项目级 —— 那是共享产物，只有一份。

顺带：`indexExcludes` 被写在 `.filter()` 里面，等于每个文件查一次库（本仓库 207 次/轮），提到循环外。

`bun test` 540 pass。

### 宿主上不再有第二条凭据路径

顺着「不应该有任何本地宿主机的 claude/codex 会话」扫了一遍，找到三处，全是同一个形状：**写死了那个 CLI 在宿主上的位置，或者干脆去读那个 CLI 自己的登录**。

**1. 用量条读的是老板的个人登录。** `pollClaudeUsage` 先用 `subscriptionAccount(db,'claude')` 把关 —— 那个函数自己的注释写着「a bar sourced from whatever this host happens to be logged into would be about an account the fleet never touches」—— 然后三行之后，`claudeToken()` 读的**正是那个**：macOS keychain 的 `Claude Code-credentials`，退回 `~/.claude/.credentials.json`。**闸门查 A 账号，数字来自 B 账号，标签写的是 A。** 现在用 `runtime_auth` 的 token。顺带这也是全仓唯一一处平台相关的读法（keychain 是 macOS，文件是 Linux，Windows 两个都没有）。

**2. `<dataDir>/codex-home/auth.json` 在真机上是个指向 `~/.codex/auth.json` 的 symlink。** 不是代码建的。但方向反了：这个目录装的是**产物** —— 凭据来自 `runtime_auth`，写出去只是给宿主续期器一个 CODEX_HOME。`Bun.write` 跟 symlink 走，所以每周那次续期会覆盖并重新刷新老板自己的个人登录，正是 codex CI 指南警告的「两个写者一个 token」，从后门进来。`seedHome` 现在先 `lstat`，是链接就删掉再写 —— 删而不是拒，拒的话续期器永远跑不了。

**3. `~/.codex` / `~/.claude` 写死了，不认 CLI 自己认的环境变量。** codex 认 `$CODEX_HOME`，Claude Code 认 `$CLAUDE_CONFIG_DIR`。设了任一个的人会遇到**静默失败**：`codex login` 成功、我们从一个它没写过的目录读、面板说「finished but produced no credential」（读起来像 CLI 挂了）；技能那边是勾了一堆结果暂存零个文件、挂载是空的，因为 `scan` 对不存在的目录直接 return —— 行为正确，答案错误。现在走 `hostCodexHome()` / `hostClaudeHome()`：先看环境变量，再退回惯例路径，`homedir()` 管平台差异。

`scan` 多了个 `relBase` 参数：`base` 是「在 root 底下去哪找」，`rel` 是「写进消息文本、用来匹配老消息的惯例路径」（migration 026）。搬了家的人改的是前者，后者不能跟着变。

**`serverKeyOnDisk` 不用改** —— 它早就做对了：env → cwd → home → 问运行中的进程。

**留在宿主的两条，是设计**：`login.ts`（老板点按钮、浏览器在这台机器上、一次性），`chatgpt.ts` 的续期器（codex CI 指南要的「一个 runner」，而且它刻意用真 `codex exec` 让官方客户端刷自己的 token，不自己 POST refresh token）。

顺带补的脱敏：`bus.emit` 现在连 `meta_json` 一起洗（同一行、同样 append-only，好几个 emitter 往里塞整个 CLI payload，以前只洗 body）；`notify.ts` 打到 ntfy 的那条也洗了 —— 那是唯一一条**离开这台机器**的，而 ntfy topic 是公开无鉴权的。

三条 check 守着：`src/` 里不许再出现 `find-generic-password` / `.credentials.json` / `claudeAiOauth`（只看代码行，注释里的事故记录留着）；`hostCodexHome`/`hostClaudeHome` 认环境变量；`seedHome` 遇到 symlink 不能写穿。

`bun test` 543 pass。

### 宿主上到底还需要装什么

**`missingBinaries()` 没装 `claude` 就拒绝启动**，错误信息写着「Every agent turn would fail with the same error」—— 005 之后这句是假的。turn 跑在容器里，宿主的 `claude` 只剩登录按钮和（codex 的）续期器在用，两个都是可选的。结果是：一台装了 docker、拉了镜像、凭据也贴好了的无头机器起不来，而且理由说错了。现在只要 `git`（宿主真的用它 —— bundle 进出和 push）。

**没有任何东西检查续期器能不能跑。** ChatGPT 账号登录是唯一一个**永久**需要本机有二进制的凭据：它是一对 codex 自己轮转的 token，而续期是**刻意**跑真 `codex` 让官方客户端刷自己的 token，不是我们拿它的 client id 去 POST refresh token（`chatgpt.ts` 写了理由：那是我们的代码把自己伪装成官方客户端，正是订阅条款针对的形状）。所以宿主没 codex = 不会续期，而失败是静默且延迟的：nudge 抛异常 → 被吞 → 保留旧 token → 几小时后全舰队 401，看起来像账号过期。现在 preflight 有 `codex-refresher` 一条，直说这件事和两条出路（装 codex，或改用 API key —— API key 不过期）。

**所以「宿主没登录过」的完整答案**：
- **claude**：什么都不需要。设置页贴 `sk-ant-oat01-…` 或 API key 就行。`setup-token` 铸的是**另一个**一年期 token，连你现有的会话都不碰。
- **codex API key**：什么都不需要。
- **codex ChatGPT 订阅**：本机要有 `codex`，长期要有。这是不伪造的代价，preflight 现在会提前说。

顺带：`data/` 和 sqlite 建出来是 `0755`/`0644`，而 `runtime_auth` 里是明文 token —— 本机任意账号可读。启动时 chmod 成 `0700`/`0600`，尽力而为（Windows 上 chmod 对权限位是 no-op，不作为拒绝启动的理由）。`chmodSync` 本来就 import 在 `server.ts` 里没人用。

README 补一句：桌面通知是 macOS 的，其他平台走 ntfy，而那个 topic 名就是唯一的凭据。

`bun test` 545 pass。

### preflight 说自己会拒绝启动，它不会

`missingBinaries()` 是唯一致命的检查，现在只剩 `git`。docker / uvx / opensandbox-server / egress 版本 / 镜像 / 技能路径 / 凭据全在 `preflight` 里 —— 而它是 `void preflight(...).then(consola.warn)`，一条 fire-and-forget 的控制台警告。**而 `preflight.ts` 自己的文档写着 "this refuses to start rather than degrading"。**

后果是实的：docker 没起时每个组各自撞一次墙 —— 派发、`ensureSandbox` 抛、turn 失败、规则 8 重排一次、再给老板一条 blocker。十个组十条同样的话，一个事实。正是 `providerHeld` / `credentialMissing` / 断网闸存在的理由。

**不改成拒绝启动**：拒绝会把面板一起带走，而面板正是这几条的修法所在 —— 沙盒密钥就是在那儿贴的，一个没有密钥就不启动的服务端没法被贴上密钥。

改成**第四个同形状的闸**：`ensureSandbox` 失败就全局 hold 60 秒，第一个组撞墙，其余根本不派发；成功就解除。事件每次故障只发一条（被闸住的 job 不产生尝试，每分钟同一行是让 feed 失效的方式）。60 秒是因为两头都要防：docker 回来了要快速恢复，而万一那次失败其实只跟某个项目的配置有关，也不该长时间拖住所有人。

`sandboxReady` 和 `online` 是**两个**注入项，不合并 —— 一个说的是这台机器够不够得着模型服务，一个说的是 docker 和沙盒服务端在不在。合并的话，第一次只有其中一个为真时，两边的注释就都错了。

文档也改了：preflight **报告**，`sandbox.ts` 的 hold **执行**。

`bun test` 546 pass。

### 决策 007：项目来自 GitHub，宿主不再参与 git

设计定了，还没动代码。全文在 `docs/decisions/007-github-is-the-source-of-a-project.md`，这里只记落地状态。

**它修正了 005 的一句话**：边界不是「容器」，是「**跑 agent 的**容器」。一个没有 agent、不挂仓库、不跑模型的工具容器，是 server 的同级，给它真凭据是选择而不是漏洞。三类进程从此按「里面跑不跑 agent」分，不按「宿主还是容器」分。

**要达到的形状**：设置页点一次连 GitHub（设备流，只要公开的 `client_id`，不要 client secret）→ 切 org、列仓库、选主分支 → 开需求就是开容器 + clone + 装环境 + 干活 → PR → 合了删容器。宿主上**一个外部二进制都不需要**（`missingBinaries()` → `[]`）。

**submodule 的答案是「哪个容器」，不是「支不支持」**：CVE-2024-32002 / CVE-2025-48384 是 clone 带 submodule 的仓库直接 RCE，而 GitHub 自己给的第一条缓解措施就是「在临时的、网络受限的容器里做」。组容器支持（本来就一次性、只有 decoy），工具容器绝不碰（它持有真凭据）。

**删除面**（都不是「拿库换我们的代码」，是宿主不再参与 git 之后那些只为协调宿主而存在的代码没了）：`gitlock.ts` 75 行 + 24 项子命令表、`makeGitRunner`、`httpsRemote`、`remoteUrl`、`detectBaseBranch` 30 行启发式、`seedBranch` 和「分支可能在三个地方」那段、规则 15 每组每 tick 的 `git fetch` + `merge-base`、`gh` 封装 + 6 处调用、`/api/dirs` 和宿主目录选择器。

**留下的**是我们的工作流而不是 git 管道，全部跑在组自己的克隆上：`checkpoint` / `squashWip` / `rollbackTo` / `filesAt` / `sliceDiffBase` / `changedSince` / `rebaseOntoBase` / `abortStaleRebase`。

**凭据过期和 git 失败**：过期的 GitHub token 的信号和这个库被烧过四次的那个一样 —— 所有组同时失败、每个报的错都不一样。所以照抄 `handleAuthFailure` 的做法：挂起、一条升级、指向设置页、绝不重试，成为第五道准入闸。失败分三桶（老板 / agent / 瞬时），**今天只实现了中间那桶**。GitHub 对看不见的私有仓库返回 **404 不是 403**，所以「删了」和「撤权了」是同一个响应，文案不许断言是哪个。

**落地顺序**（1、3 可独立开工）：
1. `--filter=blob:none`
2. 设备流登录 + 仓库列表
3. `gh` → REST（带 ETag 条件请求，304 不计入限额）
4. `Scope` 第三种 + 工具容器 + TTL invariant
5. 分支推到远端，`seedBranch` 删掉
6. 检出搬进工具容器，`gitlock.ts` 等一批删掉，`missingBinaries()` 清空
7. codex 续期器搬进去（最后，真凭据）
8. 规则 15 换成 API 基线

#### 007 第 1-3 步落地（`b96c65e` / `231bd96` / `c11f702`）

**568 pass / 3 skip / 0 fail**，`tsc` 干净，`build:web` 通过。三个 subagent 并行做的，文件互不重叠。

**第 1 步 clone**：`--filter=blob:none`（不是 `--depth=1` —— shallow 更快但砍历史，`rebaseOntoBase` 和 `merge-base --is-ancestor` 都要真历史）。顺带把 `ensureCheckout` 那四个静默 `return` 改成各自报出是哪一个 —— 以前任何一个触发，组都会在空的 `/work` 里跑完一整个 turn，状态 RUNNING、有 agent、哪儿都不报错。

**第 3 步 `gh` → REST**：`src/mech/github.ts`，八个端点的普通 JSON。转换过程中挡下三个会**静默出错**的形状差异：REST 里 `state: MERGED` 不存在（合并是 `closed` + `merged:true`，只读 `state` 就是 grp16 那个 bug 重演）；`mergeable` 在 GitHub 后台计算时是 `null`，当成冲突就是每次 push 后都派人 rebase 干净分支；REST **不大写**，`failure` 撞上匹配 `FAILURE` 的过滤器 = 每个红的 PR 报成绿的。失败带 boss/agent/transient 三桶。ETag 条件请求，key 带 token（304 不计限额，换登录不能重放旧缓存）。顺带修了一个既有 bug：`pollPrs` 原来拿**第一个项目**的检出当 `gh` 的 cwd，所有 PR 都在 `ORDER BY id LIMIT 1` 那个项目里查。

**第 2 步设备流登录**：`src/mech/ghlogin.ts`，纯 `fetch`，无二进制、无 client secret。**注册的是 GitHub App 不是 OAuth App**，所以没有 scope —— 权限声明在 app 上、安装时选。两个 app 开关从我们这侧不可见，各在三处写明症状：Device Flow 没开 = 取码请求直接被拒；user token 过期没关 = 今天能用、明天全舰队 401，而刷新需要我们 ship 不了的 client secret。**「授权了」和「装上了」是两个状态**，只有后者够得到仓库 —— 授权但没装报成已连接，就是一条绿线配一个永远空的仓库列表。账号问 GitHub 而不是存下来（存下来的名字会替一个上周就吊销的 token 继续说「已连接」）。

**没做**：仓库列表、org 切换（第 2 步的后半，依赖前面）；`client_id` 空着等注册。

**上线前必须在真沙盒服务器上验的两条**（假设了就会失败）：控制面到底校不校验 `paths`（被静默忽略是 **fail-open** —— push 能成功而设计说它不能）；GitHub 的 301 重定向会不会让精确白名单丢掉注入。

#### 007 第 1-5 步全部落地，`paths` 实测通过

**598 pass / 4 skip / 0 fail。** 三个 subagent 并行做的，16 个提交。以下只记「读代码看不出来」的部分。

**接 GitHub 是一次登录 + 一次安装，两件事**（`c11f702` `1060b6d`）。设备流，`client_id` 不是机密所以进仓库（`Iv23liUP6a00TszuLZvc`，app 在 pamin-labs 名下，slug `orchestrator-connect`，Public）。**授权 ≠ 安装**：GitHub App 的 user token 只够得到 app 装过的仓库，所以「授权了但没装」是一个看起来像成功、实际一个仓库也列不出来的状态，面板单独一态。App 本身可以在设置里换，存 `setting` 表不存 yaml —— yaml 是提交进仓库的，自托管的人改了下次 pull 就丢。

**`paths` 是「沙盒不能 push」的全部，而且永远是**（`84bc400`、007 那节）。经典 OAuth 没有只读档，private key 不能 ship，所以没有第二道。已实测：白名单内注入、名单外不注入（**不 fail open**）；重定向两个方向都安全（逐请求按自己的路径判定）；**尾部 `*` 跨 `/`** —— 上游文档给的 `/owner/repo.git*` 会把 `git-receive-pack` 放回来，我们用枚举精确路径。手法是「容器里主动发 decoy」，因为注入是替换已有 header，所以两个方向都能观察到，不靠「header 不存在」推断。

**不变式要说准**：**写永远完不成**（packfile 那个 POST 拿不到凭据）；但「token 从不出现在写路径上」**不成立** —— push 的 ref 广告和 fetch 只差 query，而 query 在匹配前被剪掉。

**发现的三个静默失败**（都是「四道观察全报绿」的形状）：

1. **macOS 上技能挂载一直是空的**（`ee18e94`）—— docker 在虚拟机里，`/var/tmp` 是虚拟机自己的，绑一个运行时够不到的路径**会成功并给你空目录**。宿主 179 个、容器里 0 个、`lowerdir=/`。从 006 起每个 agent 都在零技能下跑。默认路径改到 `$HOME` 下，并加了「挂了但里面是空的」的读回检查。
2. **`ctx.config` 是手写白名单**（`29655a0`）—— 加配置键要改两处，第二处漏了 `tsc` 照样绿（`Ctx.config.github?` 是可选的），结果设置页永远说「没配 client id」。守卫是**读 `server.ts` 的文本**，因为整个失败的本质是类型系统满意。
3. **游离 promise 的拒绝打在无关调用者身上**（`d2c6e83`）—— 一条测试三次挂一次、挂在毫无关系的文件里、单独跑永远过。Bun 里未处理拒绝是致命的，所以一个到本机容器的 socket reset 能带走整个舰队。

**本地项目彻底没了**（`9e07828` `7f09a17`）。migration 037 用 `project.remote` + `parseRepo` 转换，**幂等靠形状不靠标志位**；转不了的行原样保留 + 一条点名所有卡住项目的问题。注册时的闸门探测搬到**第一个组 clone 之后、装依赖之前**（它产出的就是安装命令），`detect.ts` 变纯函数、不再 import `node:fs`，fixture 测试因此变简单而不是被替换。**一项目一次用 `config.detected` 标记，不是用「有没有闸门」** —— 后者会让探测不出东西的仓库每个组重跑一遍。

**移除项目**（`b81edb8`）：顺序就是正确性 —— 取消 job → 杀容器（趁 id 还读得到）→ 清附件（**只删解析后落在附件目录内的**，那些路径是从 agent 写的散文里抠的）→ 删行（`PRAGMA foreign_key_list` 确认全是 NO ACTION，没有级联）→ 清模块状态。**远端零请求**，有测试断言，会在将来有人加「顺手收拾一下分支」那天变红。

**还没做**：007 第 6-8 步（检出搬进工具容器、删 `gitlock.ts`、`missingBinaries()` 清空、codex 续期器搬入、规则 15 换 API 基线）。宿主现在还有 git 且工作正常，这几步是清理不是修复。

#### 007 全部落地，宿主不再参与 git

**606 pass / 5 skip / 0 fail。** 第 6-8 步 + 目录拆分 + 一轮只读审计和它找到的东西。

**`missingBinaries()` 现在是 `[]`** —— 宿主上零外部二进制。`gitlock.ts` 删了（三个并发写者变一个，它的存在理由没了）。宿主检出那三份工作分开落地：文件**名字**去工具容器的裸镜像 `ls-tree`；文件**内容**去项目自己的容器，**一次 exec 拉整个语料**（`summarise` 要读每个文件头部才知道变没变，逐文件读就是每 tick ~125 次往返来证明什么都没变）；规则 15 的基线走 GitHub API，那也是唯一能看见别的机器 push 的方式。

**`src/mech/` 拆成 `{git,sandbox,flow,knowledge,ops,util}/`**，`git mv` 保留历史，行为改动和纯搬家分两个提交。三个放得别扭的没硬塞、标了理由。

**一轮只读审计，两份报告，值回全部成本。** 它量了 `Bun.spawn`（**cwd 不存在时抛出，不返回退出码**），于是**每一个跟在宿主 git 后面的 `code !== 0` 守卫都是死代码** —— 604 个测试全绿，因为**测试全都注入 runner，而生产守卫只有 spawn 成功才可达**。四处会挂：批准落不了地、DRAFT 卡静默 500、查收页 500、PR 开不出来。更糟的是看门狗规则 7e 抛出**带走整个 tick**，规则 8-19 从第一个项目行存在起就再没跑过（invariants 表里约 12 个状态的 driver 集体失效），**而且每 30 秒静默失败一次**。

修在源头：`makeGitRunner` 返回退出码，整类一次性复活。同一形状在 `execIn` 上更严重 —— 那里的后果是 **agent 永久阻塞**（lease 拒绝 → `finishLease` 不跑 → 等待者的 promise 没有超时，`orch` 轮询没有截止），而为它写的 `126` 守卫**恰恰不可达**。

**两处把责任指错人的**：凭据金库绑失败什么都不说（注释说 preflight 会报，而 preflight 在启动时跑、那容器当时还不存在，**它从来没有过机会**），后果是让老板去重铸一个从来不是问题的 token；preflight 的 docker 检查用 `docker --version`，**daemon 没起时退出码是 0**，于是「装了没启动」这个最常见的首次状态报绿，而沙盒 hold 正把老板往那一栏指。

**审计还验收了修复本身**，找到三个新缺陷。最值钱的一条：看门狗那个「因为静默死掉」而加的守卫**绕过了它自己文件里的去重**，而它唯一的触发方式是抛出、直线 tick 里的抛出每 30 秒重现 —— 于是它会让看门狗**大声地死，每小时 120 条**。

**invariants 表有个盲区**：测试只比对 `states.ts` 和 `invariants.ts`，而两个文件是一起改的 —— **数据库永远不会产生的状态能全绿通过**。加了一条 15 行的 grep 检查（只覆盖存储态，不覆盖 `repoHeld()` 这类计算态），第一次跑就抓出 `slice.self_review`：在状态清单里、在 invariants 里、在 `db.ts` 的 schema 注释里**从一开始就在，而没有任何代码写它**。

**验过的数字**：工具容器首开 2.6s，裸镜像 clone 2.0s（第一个切片边界约 5 秒一次性），之后每 turn 的 `keepBranch` 3.1s 且不走网络。组容器 `createCheckout` 12.2s（小仓库）。

#### 007 第 7 步：宿主上只剩它该剩的

**611 pass / 5 skip / 0 fail。** 「所有凭据相关的事都在容器里做」这一轮。

**金库那句话之前是假的。** 它的前提是「真 token 只在出站时由 sidecar 换上，容器里永远是假值」，而查用量是**宿主进程自己拿着 `runtime_auth` 的真值 `fetch` 出去的** —— 唯一一处真模型凭据不经过 sidecar 就离开这台机器。**这个例外读那句声明是发现不了的。** 现在在工具容器里 `curl`，带假值，替换在设计说它发生的地方发生。

**codex 登录搬进容器了，用的是 codex 自己的 `--device-auth`** —— 它印在「用 localhost 那条」的下一行，专给远程/无头机器。**真 CLI 走完整个流程，只是换了地方跑**，所以「我们的代码冒充官方客户端」那条反对意见不成立。先设计的那个方案（把 localhost 回调代理出容器）实测**被拒**：`redirect_uri` 是注册死的，唯一能通的办法是改它 = 伪造。解析钉在 `codex-cli 0.147.0` 并写了重探指令 —— **CLI 改措辞这会坏，而且坏成「登录一直不完成」**，所以读不到码时报错并给出手动命令。

**Claude 登录搬不了，原因不是 OAuth 是 stdin。** 实测：没有 pty 时**无声阻塞到超时**（rc=124，两个流一个字都没有，也没有监听端口）；挂上 pty 才打印 URL，而那个 URL 是 `code=true` **零监听端口** —— 浏览器给一个码，**人粘回 CLI 的 stdin**。我们的 exec 是请求/响应，没有 stdin 通道。**是传输层缺口**，绕过去就是脚本化粘贴。留在宿主，写明例外。

**宿主最终剩下**：服务 HTTP/SSE、持有 sqlite、轮询信箱。三个写明的例外，都不是模型凭据在线上：`claude setup-token`（上面）；preflight 的凭据验证（**一个需要它所检查之物才能运行的检查不是检查** —— 它在启动时跑，那时不保证有容器，搬进去等于「能不能开容器」成了「报告开不了容器」的前提，这句写进了文件，否则下一个人看到真 token 的宿主 fetch 紧挨着一个刚删掉同类的提交，会得出错误结论）；GitHub REST 客户端（不是模型凭据，007 §1 刻意选 fetch 不选二进制）。其余碰进程的都是管容器运行时（`ps` / `lsof` / docker / 重启）或在老板自己机器上弹通知 —— 容器做不了。

**GitHub App 写死进代码**（`mech/git/ghlogin.ts`），yaml 和 `Config` 里的键删掉。理由：**一个永远不该被拧的旋钮就是在邀请别人去拧它**，而 client id 不是机密（设备流没有 client secret，那正是这个设计能开源的原因）。面板里那块「用哪个 App」也删了 —— 它服务的人约等于没有，而换 Client ID 会**丢掉存着的 token**。

**选仓库那个对话框：两次测量都推翻了显而易见的修法。** 慢**不是**分页也**不是**渲染 —— `api.github.com` 往返 262-630ms，87 个仓库一页装得下，成本是**串行两趟**（要先拿 installations 才知道 id）。改成指明 installation 时并行，面板记住上次选的，第一次之后每次一趟。下拉被挡**不是** portal 问题 —— Radix portal 完全正确，是 `ui/menu.tsx` 的 `z-50` 在 `z-[70]` 的对话框底下。**一个数字。**

**还没做**：项目自带的 `.claude/skills/` 读不到（`repo_path` 已是 `owner/name`，没有那个宿主目录）—— 现在是每项目响一次的跳过，不是静默的。而**这个仓库自己就带 `.claude/skills/git-commit/`**，所以拿 orchestrator 跑 orchestrator 时，agent 拿不到这个仓库想给它们的提交约定。看门狗真正的逐条规则隔离也还欠着。

#### 技能真的送到了，claude 登录进容器，外加两个一直在发生的静默 bug

**617 pass / 6 skip / 0 fail，live 沙盒 6 条全绿。**

**上一条「还没做」的答案是：投递本身从来就没接上，而且比记的更糟。** 先数了镜像里两个二进制自己的字符串：

```
claude   .claude/skills 93   .codex/skills 0   .agents/skills 0
codex    .codex/skills  3    .claude/skills 0  .agents/skills 0
```

codex 那三处是**同一句话** —— `$CODEX_HOME/skills`。**codex 根本没有项目级技能目录。** 所以三个约定里 `.codex/skills` 和 `.agents/skills` 谁都到不了，`.claude/skills` 只到 claude 一半，而设置页把三个都列着。旧注释把 `.codex/skills` 写成「codex 的项目路径」，**一个词，整件事就看起来是通的**。

**上一次尝试为什么失败，值得留着**：它把仓库技能链进 `$CODEX_HOME/skills`，而那个路径**本身就是只读挂载**，每个 `ln` 都是 EROFS —— 被尾巴上的 `; true` 吞掉，配套测试跑在一个根本没有挂载的临时目录里。**报成功，投递零个。**

修法是把挂载从两个 CLI 自己的目录上挪开：暂存目录只读挂到 `/opt/orch/skills`，`SKILL_SYNC` 把两个 CLI 的目录搭成指向它的软链农场，再把仓库自己的链上去。它**并进了本来就要跑的那条 checkout 探测**，所以零额外往返、每轮都是最新的，而不是每容器一次。

同一条 exec 把仓库技能的清单印回来（`ORCHSKILL <rel> <base64 头部>`），这就补上了 `repo_path` 变成 `owner/name` 之后丢掉的那一半：设置页列得出来、输入框 `/名字` 点得着。**头部是原样传回来在这边解的** —— `description: |` 是块标量，shell 里一行 `sed` 解出来是 `|`。

**`claude setup-token` 搬进工具容器了，上一条说的「传输层缺口」是可以补的。** 它没有 pty 时**什么都不打印、退出 0**（上次记的是超时，这次实测是静默成功），最坏的形状。给容器一个 pty（`pty.fork` 加显式 `TIOCSWINSZ` —— 默认 80 列会把 URL 断在 token 中间，而 `script` 不认 `COLUMNS`），粘回来的码经由一个我们 append 的文件进 stdin。**跑的是真 CLI，OAuth 全程由它自己走完。** `startLogin` 和 `/api/auth/login` 跟着删了 —— **宿主上再没有任何一处 spawn 模型 CLI**。

**顺手撞见的第一个：沙盒 SDK 每行一条消息，换行符被吃掉。**

```
printf 'a\nbb\nccc\n'    ->  ["a","bb","ccc"]
printf 'a\nb'            ->  ["a","b"]              半行不标记
printf 'a\n\n\nb\n'      ->  ["a","\n","\n","b"]    空行是 "\n" 本身
printf '1%\r42%\rdone\n' ->  ["1%","42%","done"]    \r 也切，也被吃
300KB 无换行             ->  一条                    长行永远不切
```

`join("")` 把每一行都拼在一起。`git status --porcelain`、`ls`、技能清单**全都是一行**，每个按行解析的调用方都在「什么都没匹配上」—— 不抛、不警告。流式那侧更糟：没有终止符，`lineSplitter` 攒下整个 turn 的 NDJSON，最后吐成一坨不可解析的东西。**最后一行是把「按 `\n` 重接」从猜变成事实的那一行**：服务端只按行边界切，一条消息永远不是半行。

**第二个：仓库地图从 007 落地起就没有符号了。** `buildMap` 读 `join(repo_path, rel)`，而 `repo_path` 是 `owner/name`。每次读都抛，每次抛都被 catch 成「git 认得但磁盘上没有」，地图照常渲染、照常报 `repo map refreshed`。符号来源改成调用方传，看门狗从项目自己的容器读。

**两句指错人的话**：看门狗猜「工具容器起不来，或者这个登录读不到这个仓库」—— 第一个撞上的人两个都不是，而**一条列三个可能原因的建议，是把它本该替你做的活退回给你**；现在 `listTree` 把四种失败分开，直接印 git 自己的话。preflight 教人跑 `claude setup-token` / `codex login` —— 照做只会把**宿主**登录上、什么都不存，而检查继续说「没配」。

**宿主现在剩什么**：服务 HTTP/SSE、持有 sqlite、轮询信箱、管容器运行时（`ps` / `lsof` / docker / 重启 opensandbox-server）、在老板自己机器上弹通知。带真凭据出网的只剩 preflight 的凭据校验一处，理由写在文件里没变 —— **一个需要它所检查之物才能运行的检查不是检查**。


## 提交和 PR 现在是写出来的，不是拼出来的

**641 pass / 6 skip / 0 fail。** 只记「读代码看不出来」的部分。

**每个 PR 的标题都是 `orch: <组名>`** —— dispatcher 在一行代码都还没有的时候给需求起的 slug，一次发版里四个 PR 全叫这个，所以 `--generate-notes` 把四个都归到「其它」。更糟的是 squash 出来的 commit message **就是整个 PR body**：`## Slices (3, all accepted)`、闸门表、`Opened by orchestrator` 全进了 `git log`，进了别人的仓库，进了那个比 review 页面活得久的地方。

新角色 `scribe`：审计过了之后跑一轮，在**组自己的沙盒**里（分支就 checkout 在那儿），读 diff 和卡，交 `orch pr <id> --title "..." -`（body 走 stdin）。low effort、8 轮、没有 Edit/Write —— 更强的模型不会写出更好的 subject，只会写更长的；而能改文件的 scribe 能让刚通过的审计失效。

**`checkPrMessage` 就是规范本身**（硬约束 6）：type 前缀、72 字符、不以句号结尾、英文、body 不能只有一行。`roles/scribe.yaml` 把这五条拒绝逐条写进 prompt —— prompt 允许而校验器不认，就是在教模型写一段注定被丢掉的东西，而且它是在唯一那轮的最后才知道。

**开 PR 从审计上挪走了。** `auditVerdict` 只决定「可以发」并进合入队列，`ctx.publishBranch` 在消息落地时才跑。这开了一个窗口：组在队列里但没有 PR 号。PR_OPEN 的 invariant repair 负责关掉它 —— 审计过了、在队列里、没号、而且这个组已经没有任何 pending/running 的活，就说明 scribe 那轮死了，用兜底文案发出去。**不这么做，一段做完的活会卡在严格串行的合入队列头上，后面全停，而且组看起来是健康的。**

**checkpoint 提交一直在给上一轮的产物写下一轮的名字。** checkpoint 跑在 turn 开头、提交当时脏的东西 —— 而那是**上一轮**的产出，因为没有任何地方在 turn 结束时提交。label 取自即将开始的 job，所以 Engineer 的 diff 被记成 `wip: S2: qa`。任务标题错得一模一样：它挑的是第一个**未完成**的 task，那时候已经是下一个了。现在两者都取自这个组最后一轮跑完的 turn，而且列出改了哪些文件（12 个封顶）—— `squashWip` 在 agent 写过真 commit 时是**故意**不压的，那时候这些消息就是 reviewer 看到的全部。

**三个函数把没验证过的 base ref 交给 git。** `origin/${await detectBaseBranch(...)}` 出现了三次，每一处还都带一个「外面没有任何调用方传过」的 override 参数 —— 于是生产上只有 fallback 这一条路，而它恰恰对那个「没有 remote 的克隆」是错的：`detectBaseBranch` 返回裸名字、找不到时返回 `HEAD`，所以没 remote 的克隆被问了 `origin/HEAD`，没分支的被 `git rebase HEAD`（成功，什么也没干）。`baseRef()` 解析一次并验证，找不到返回 null。null 才是重点：没验证的 ref 不会以「这个仓库没有基线分支」失败，它会在 rebase / squash / diff 内部以 `fatal: ambiguous argument` 失败 —— 一个原因，三种看不出关系的报错。

**仓库改名之后一切照常，所以没人发现。** 组织改名成 `pamin-labs`，面板一直显示 `Pamin-Labs`：`repo_path` 注册时写一次，之后再没读过。`GET /repos/old/name` 会重定向，所以每一次读都有答案、没有任何报错提到它。**不跟着重定向走的是开 PR 的那个 `POST`**，以及别人把腾出来的名字占掉的那天。修在 `baseBranch` 里 —— 它是唯一一个每条路径都会跑的请求，而同一个答案里 `full_name` 和 `clone_url` 就在 `default_branch` 旁边。

**两个 trailer 是「有设置项、但没有任何东西能设置它」。** `trailers()` / `setTrailers()` 在，`gitTrailers()` 两个提交点都接了，但没有路由也没有控件读写那一行 —— 默认值是唯一能到达的值。顺带发现 **Claude Code 自己也会加一行**：CLI 对它自己做的提交追加 `Co-Authored-By: Claude`，所以把我们的关掉之后仍然有一个，只是来自另一个方向。容器里 `/root/.claude/settings.json` 的 `includeCoAuthoredBy` 跟同一个开关走（`--setting-sources user,project,local` 本来就读它）。

**沙盒镜像是个文本框，而里面的错字要四步之后才失败。** 打错的 `ghcr.io/pamin-lab/...` 当场没人拒，答案是在一个**已经派发出去、已经告诉老板开工了**的组上，以「容器创建不了」的形式到达。合法答案的集合小且可知（沙盒只认我们发布的和本机构建的），所以两半都直接列出来：远程走 ghcr 的匿名 pull token（不需要账号 —— 面板在任何人连 GitHub 之前就能列版本），本地枚举 docker 里没有 registry 前缀的镜像。

**「agent 镜像不在本机」不再是故障。** 这条检查早于发布镜像 —— 那时候只能 `docker build`。现在默认是 `ghcr.io/pamin-labs/...`，沙盒服务器第一次建容器时自己拉，所以那行红字是在催人去做一件马上就会自动发生的事，而且是在那个唯一职责是「这台机器不能干活」的面板上。裸 tag 仍然红：它没有地方可拉。

**设置页的下拉滚不动。** Radix 的 Dialog 会锁住自己内容之外的滚动，而 combobox 的列表 portal 到 body —— 就在外面。二十个本地镜像的列表，滚轮没反应，看起来就像列表到此为止。popover 加 `modal`，它自带的锁接管。同一批还修了：设置页的分栏进了 hash（刷新会回到原来那一栏），禁止访问的域名从空格分隔的字符串换成一个一个 chip（粘进去的 `https://...` 以前原样存下来，匹配不上任何东西 —— 面板说拦了，实际没拦）。

## /etc/hosts 劫持 sidecar：探过了，打不穿，而挡住它的不是 DNS

P2 最后一条，`docs/decisions/005` 从来没覆盖过的场景。问题是：金库按**主机名**绑定
（`matchFor` = `{schemes:["https"], hosts:[…]}`），而 agent 在自己的容器里是 root ——
它可以让那个名字解析到任何地方。真跑了一遍，绑一个带标记的合成凭据，从沙盒里打自己
架的监听器。

**sidecar 确实跟着容器自己的解析走。** `/etc/hosts` 加一行、或者干脆 `curl --resolve`，
两种都成功：我的监听器收到了 TLS ClientHello，SNI 就是 `api.anthropic.com`。也就是说
它不自己解析域名，连的是这条连接本来指向的地址 —— 而它同时正握着这个主机名的绑定。

**但它验上游证书。** 自签一张 `CN=api.anthropic.com` 的证书摆上去，回的是
`502 Certificate verify failed: self-signed certificate`。凭据是注进握手**之后**那个
HTTP 请求的，握手不成就没有请求，也就没有 token。

**明文 http 一点都不注。** 同一个主机名走 `http://`，监听器收到的请求头只有
`Host / User-Agent / Accept` —— `schemes: ["https"]` 是真的在执行，不是装饰。

结论：**打不穿，而站在中间的是上游 TLS 校验，不是域名解析。** 这条要写下来是因为它
决定了以后什么动作是危险的 —— 谁哪天在 sidecar 配置里关掉上游证书校验（很多代理都有
这么个开关），这条路立刻变成一条完整的凭据外泄通道，而且没有任何症状：agent 拿到的
仍然是正常的 200。

## 缓存和排队：账本身是错的，而慢的那 2/3 不在模型里

拿这个库自己的 725 个记账 turn、907 个 `agent_turn` 量了一遍，四条都不是猜的。

**codex 的 token 数一直被算两遍。** codex 的 `input_tokens` 含 `cached_input_tokens`，claude 的不含 —— 两个 adapter 把语义不同的两个数填进同一个字段。实测 438k input / 402k cacheRead，于是同一个错误在三处呈现三种样子：面板上 codex 的 cache 命中率写着 0.39（真值 0.92），切片预算在真实花费一半时熔断，而 `contextTokens = input + cacheCreate` 一个 turn 就吃掉 272k 窗口 60% 的天花板 —— **18 个 codex agent 有 15 个的 `session_tokens` 已经在 ceiling 之上，也就是下一轮必然重开会话**。重开 = 丢掉整条 transcript = 下一轮重读一遍仓库。改动是一行减法。

**「重开了几次、为什么」以前没人记。** 13 个 claude turn log 抽样，10 个的首步 `cache_read_input_tokens` 是 0、首步 cacheCreate ≈ 17k —— 全新 session、只有前缀。而四个触发源（前缀变了 / 上下文满了 / 打回重做 / 新雇的）合成一个 boolean 就丢掉了。现在带进 `tool_summary.meta.rotate`，成本页在 cache 命中下面多一行「重开会话 N/50 · 原因」。**低命中率和高重开率是同一张图，但修法相反**，没这个数只能猜。

**gate 的优先级是 0。** 它不花模型、跑 16 秒，却卡着 slice → QA → 老板查收整条链 —— 实测排队 **3235 秒**。旁边的 `reconcile` 用 `priority: 5`，排队 74 秒。这就是 QA 的 turn 平均等 6876 秒才开始的原因。补一个 `priority: 5`。

**四个常驻角色在抢同一个槽位。** `job.grp_id ?? 0` —— Architect / CoS / Dispatcher / Librarian 都没有 `grp_id`，于是全局串行，Dispatcher 平均排队 4309 秒、CoS 1752 秒，而它们之间没有任何共享状态。槽位改成按 agent（`grp_id ?? -(agent_id ?? 0)`，负数永远撞不上 group id），同一个 agent 仍然一次只写一份 transcript，`maxGroups` 那道成本上限一点没松 —— 那才是当初写 0 的真实理由。

**还有一条是潜伏的：** 读 lessons 是 `ORDER BY at DESC`，而决定哪 20 条活下来的淘汰逻辑是 `ORDER BY at DESC, id DESC`。`at` 是整毫秒，Librarian 一轮写好几条，一旦并列，两次读回的顺序就可能不同 → `systemAppend` 字节变 → 全舰队冷启动，且**每个组看起来都健康**。今天只有 6 条 lesson、没有并列，所以还没炸过。

**claude 那半还有个更隐蔽的：** 默认 system prompt 里有一段 cwd / env / memory paths / **git status**，排在 `--append-system-prompt` 前面。而这个 executor 在每个 turn 开头都提交一次 checkpoint —— 工作树每轮都不一样。前缀的头一百个 token 每轮都变，就等于前缀从来没被复用过，而这件事没有任何症状：turn 照跑，只有 cache 命中率安静地记着这笔损失。CLI 有 `--exclude-dynamic-system-prompt-sections` 正好把那段挪进第一条 user message，加上了。这条标着**待验证** —— 用上面那个重开原因的分布和首步 cache_read 做 A/B，没效果就撤掉（一行）。

## `api.ts` 3885 行拆成 20 个文件，而路由层换成 Hono

**手抄 21 遍的鉴权是这次真正要修的东西。** `/orch` 的每个 handler 开头都是
`const a = agentOf(ctx, req); if (!a) return bad(...)` —— 这是 agent 那侧全部的身份验证
（信箱的 `/orch/` 前缀决定哪些路由**够得着**，从来不决定**谁**够得着），而它是一条靠人记得的
约定，21 个副本里已经有 2 个漂成了另一个状态码。现在挂在 mount 上，注册在 `/orch` 下面就绕不开，
测试也从抽查 5 条改成列出全部 19 条。顺带：没带 token 统一成 401（`orch` 对 400 以上一视同仁地打印
body，没有调用方分支于此）。

**拆分是一次一簇、每簇一个提交、每步四条门槛全绿**（`tsc` / `oxlint --deny-warnings` /
`build:web` / `bun test`）。Hono 先上，旧的正则表退居 fallback，簇搬完一个就从表里删一批 ——
这样每个提交都能单独 review，而不是一个 3800 行的 diff。最后 `api.ts` 剩 220 行：路由挂载、
两条中间件、一个给外部的 re-export 块。

**`Ctx` 从 `api.ts` 搬到 `src/ctx.ts` 是前置。** 18 个 `src/mech/**` 文件为了一个类型 import
整张路由表，其中 14 个和它构成 2-环。搬完 `src/mech` 里 import `api.ts` 的文件数是 **0**。
顺带查清一件事：剩下的 `db.ts` ↔ `scrub.ts`、`sandbox` ↔ `auth` 都是 `import type`，
TypeScript 会擦掉，**运行期没有环** —— 所以那几个文件不搬，搬了是纯粹的 churn。

## 三个「自己造的轮子」里，只有一个真的坏了

**`covers()` 放行了两整类 glob。** 它决定 turn 结束后哪些越界文件要被 `git checkout --` 回滚，
而它只认识结尾的 `/*`，别的通配符一律当前缀处理 —— 于是 `src/a/**/*.ts` 覆盖 `src/a/b.js`，
`src/*.ts` 覆盖 `src/deep/nested/x.ts`。两个错都是「是，这个文件是它的」，而这个方向没有第二道防线：
容器不知道组的存在，turn 后对着 `git status` 跑的这一次就是最后一道闸。它漏掉的文件没有任何人回滚，
而组全程看起来是健康的。换成 `Bun.Glob`，只保留一条我们自己的规则：不带通配符的条目是目录声明
（agent 写 `owns: ["src/mech"]` 意思是整个目录，glob 库的意思是那一个路径）。

**技能描述的两个手写解析器**：正则版对 `description: |` 返回 "|"（picker 上显示的就是这个），
替代它的 20 行缩进遍历把 `>-` 按 `|` 折叠，还会命中 frontmatter 下面正文里的 `description:`。
`Bun.YAML.parse` 三个文件之外就在用。MIME 表同理：`Bun.file(path).type` 回答同一个问题，
不需要文件存在，而且同一个文件往下 40 行早就在这么用了。

**CLI 的重复 flag 用 `\n` 拼接，读的时候按 `\n` 切** —— 于是「两个值」和「一个带换行的值」
是同一个字符串，而后者一行就能踩到：`orch pr --body "$(cat msg.txt)"`。改成数组。

**查过之后明确不换的**：`node:util` 的 `parseArgs` 要每个子命令声明选项才能分辨
`--flag value` 和布尔值，配置比它替掉的 50 行还多；lease 的参数校验器保持手写 —— 五个分支最后都是
`String()`，错误信息是写给要据此自我纠正的 agent 看的，而 zod 的 `coerce.boolean()` 会把 "no" 当 true，
偏偏这个函数是整条沙盒边界；`shell-quote` 会把 `>` `&&` 解析成操作符对象，对一个**不过 shell** 的
上下文来说那是多出来的语义，方向反了；`K()` / `waited()` 换 `Intl` 会把 token 数显示成 120万 而不是
1.2M，而 DESIGN.md 早把 token 数和路径、分支一起归进等宽的技术列 —— 那是已经做过的产品决定，不是 bug。

## 已经咬过人的那条 DRY，用 `if` 而不是 helper 收口

`paused_at` 是所有能推动一个暂停组的定时器读的那口钟（两小时后封存、十五分钟后提醒老板、解封）。
带着 NULL 到 PAUSED 的行对这三条同时隐形，而且**看起来完全健康** —— 组是 PAUSED、有 agent、
哪儿都不报错，它只是再也不动了。`settle()` 里早就有一句 `coalesce` 和一条点名三个调用方的注释；
三个调用方今天还在那么写。所以时间戳挪到写入处，同时加一条**源码检查**：任何
`UPDATE grp SET ... status = 'PAUSED'|'PAUSING'` 不带 `paused_at`，`bun test` 直接红
（故意改坏验证过，它会指名文件和语句）。

用检查而不是 helper，因为要修的正是「靠记得」这件事本身，而 helper 是又一个要记得的东西；
而且检查在这行被写下来的时候就响，不是在它真正要命的那个夜里。

**`enqueue` 后面那个 `tick()` 没有跟着改。** 19 处配对、5 处没配，看起来像漏写 —— 查了一遍，
那 5 处全都跑在 tick 周期内部（invariants、watchdog、start、executor），`tick()` 的 `draining`
重入保护让它们再 tick 一次也是空操作，所以是对的。而把 `enqueue` 改成默认 tick 会改变批量入队的
调度顺序：现在「入队 A、入队 B、tick 一次」是一起参与评估，改完就变成 A 先占掉组的槽位 ——
一条为了整齐而引入的优先级 bug，不划算。

## 配置搬进面板，通知换成浏览器

**两个 config 对象在打架，而且是无声的。** `cfg` 给 executor / watchdog / review，`ctx.config`
是 `server.ts` 里一个手抄十三个字段的字面量，给所有路由。六个 key 从来没抄过去 ——
`maxTurnsPerJob` / `turnTimeoutMs` / `sessionRotateFraction` / `gateRetries` / `difficultyModel` /
`contextWindow`。handler 读到 undefined，落进一个看起来像决定的默认值。抄写的本意是不让 handler
乱伸手，实际买到的是第二个「类型检查通过但是错的」对象。现在 `ctx.config` 就是 `cfg`，
那条守卫它的测试从三十行变成一行 —— 要守的东西已经不存在了。

**yaml 从 156 行到 39 行。** 发布物是五个平台的单文件，`ROOT` 是可执行文件自己的目录，
所以 `config/default.yaml` 躺在解包出来的发布物里面 —— 改并发上限等于改下载下来的东西。
剩下 host / port / dataDir 三个真·启动参数，其余 35 个进 `setting` 表，`DEFAULTS` 是「哪些
path 存在、各是什么类型」的唯一权威，老版本留下的行跳过而不是抛（一行设置永远不该让服务器起不来）。

**顺手抓到三处 yaml 和 DEFAULTS 的分歧，每一处底下都有一段注释解释自己为什么是谨慎的那个答案。**
`turnTimeoutMs` 代码写 10 分钟、文件写 20；`leaseSlots` 代码是一个大小 2 的池、文件是
`{default:2, browser:1}`（browser 池存在是因为每个 browser lease 是一个真的 Chromium，
拍平成一个数就让所有 typecheck 排在一次截图后面）；`autoAcceptTiers` 代码 trivial、文件
trivial+normal，而且有一条测试钉着代码那个值 —— 那条断言一直在为一个没有任何安装跑过的值放行。
三处都以文件为准，因为文件是实际在跑的那个。没人能看见这件事，因为 yaml 键就是会覆盖默认值，
而默认值只在键缺席时被读 —— 所以现在有一条检查：留在 yaml 里的必须和 `src/config.ts` 说的一样。

**三个冻进闭包的知道自己变了。** `maxGroups` / `leaseSlots` 改成每次 tick 现读（和 `now` /
`online` 一样的注入形状），看门狗周期发现自己的值变了就重新挂 —— 把这个知识留在唯一知道它的地方，
而不是让设置路由去持有一个 timer handle。

**写设置的时候差点把「默认值」本身改掉。** `defu` 对缺席的键是按引用填的，所以一份 `sandbox:`
整块来自默认值的 config **就是**默认值那一块，一次写入就改掉了本进程后面所有的 `DEFAULTS`。
在没人写活配置的年代无害；面板一能写，「恢复默认」就会把你刚要撤销的那个值恢复回来。
`structuredClone`，加一条「写完设置再问默认值是什么」的测试。

**通知：mac 专有的两个二进制换成浏览器。** `terminal-notifier` / `osascript` 都是 macOS 独有，
而 windows-x64 是正式发布目标 —— 唯一那条本该找到老板的路径，在一个我们发布的平台上根本不存在。
服务器推一帧 `notify`，页面用 Notification API 弹真正的系统通知：零依赖、零安装、五个平台同一份代码，
点一下把已经在跑的面板拉到前台并跳到对应组。**后台标签页照样弹**（EventSource 还连着），
那才是 terminal-notifier 真正在覆盖的场景；浏览器整个关掉才收不到，重新打开时游标重放把队列补回屏幕。
规则 / 分级 / 去重 / 5-15-60 退避 / 批量一行没动。写死的 ntfy 变成一个 `notifyWebhook` 设置，
默认关，出站前脱敏 —— 那是唯一把内容送出这台机器的通道。Web Push 能覆盖「浏览器关着」，
刻意不做：为了让手机为一台在家里跑的机器震动，要付一个 service worker、VAPID 密钥、一张订阅表
和一次经 FCM 的往返。

## 设置页：单位、形状、和说在字段旁边的拒绝

**`1200000` 是二十分钟，`10800000` 是三小时，而这两个数字只差在中间。** 页面把它们原样印出来，
所以判断一个超时是不是设错了要数零。现在 `web/src/lib/units.ts` 负责换算：`20 分钟` / `3 小时` /
`30 秒`、`8M` / `272k`、`60%`，存进去的还是那个整数。一个数字取「能整除它的最大单位」，不四舍五入，
所以往返一定精确；空框子接受 `45s` / `2 小时` / `1.5h`，只写数字就沿用框里已经显示的单位。
`test/knob-units.test.ts` 把配置里每一个真实值都跑了一遍两个方向，还有一条断言：叫 `*Ms` /
`*Seconds` 的 knob 必须在单位表里 —— 这一类 bug 是无声的，字段读起来是对的，舰队跑的是另一个数。

**六个值是表，之前挤在一行 JSON 里。** `难度 → 模型` 是 runtime × 难度的网格，`每片 token 上限`
是三档（两块用同一套列，所以列对得上），`上下文窗口` / `闸门并发` / `共享缓存目录` 是开放映射，
一行键一行值加一个空行——填个名字就多一行，没有 ＋ 按钮。`禁止访问的域名` 一行一个。
`自动查收` 是三个可多选的档位，不是一段 `["trivial","normal"]`。顺手发现 `索引模型` 这一行
**从来没有画出来过**：settings 表把定键的对象拆成 `indexModel.runtime` 和 `indexModel.model`
两条 path，而页面问的是 `indexModel`，所以全系统调用最频繁的那个模型没有行，解释它为什么重要的
那段话在屏幕上出现过零次。现在两条 path 合成一行，因为模型是属于某个 CLI 的。

**拒绝说在字段旁边。** 之前只有一个 toast：它活得比修正久，而且从不说是四个框里的哪一个。
现在坏值的那个框自己变色（`aria-invalid`），标签变 accent，理由写在行下面 —— 服务端 422 的原话
或者本地解析器的话。把值改回原样（或者按 Esc）会把这条抱怨收回去，否则它会留在一个已经不在框里的
字符串上。`?` 从 tooltip 换成 popover：那些理由有五六行，而 hover 的东西在鼠标往字段移动的那一刻
就消失了，触屏上根本打不开。字全部搬过去了，一个字没删。

## 模型选，不靠拼；数值和单位分开

**模型 id 是个必须逐字符对上的东西，而它之前是六个自由文本框。** 打错的代价最安静的一处是
`上下文窗口`：键错了就回落到 `default` 那一档，于是一个 1M 的模型按 200k 的两成去轮换 session，
每轮扔掉一次花钱建起来的缓存前缀 —— 正好是那一行自己的 `?` 里写的那个故障。

**列表是推出来的，不是写死的。** 两个 CLI 都没有「列出可用模型」的命令，我们手里是它们的 OAuth
token 而不是 API key，所以硬编码一张表就是第四个会过期的地方。`difficultyModel` 本来就声明了
runtime→模型的配对，顺带教会了 `claude-` / `gpt-` 这两个族前缀，`contextWindow` 的键才能归到
某个 runtime 名下。什么都不拒绝 —— 打一个还没出现过的模型 id 正是第一个模型进来的方式，所以
`Combobox` 多了一个 `free`：列表是建议而不是权威的那种场合。

**索引模型换 CLI 时，模型跟着换成那个 CLI 最便宜的那个。** 把 `gpt-5.6-luna` 带到 claude 上是
一个那个 runtime 跑不了的模型，而这是全系统调用最频繁的一次模型调用。最便宜 =
`difficultyModel[runtime].trivial` —— trivial 这一档的定义就是「不值得上大模型」，答案本来就在
配置里，再维护一张价格表就是再多一个没人更新的东西。

**数值全部拆成「整数框 + 单位」**：`20 · 分钟`、`272 · k`、`60 · %`。解析器留着（谁想打 `3h`
照样行），但没人必须去拼，剩下的自由文本只有数字。为此加了 `splitCount`，因为给人读的
`fmtCount` 会把 8500000 印成 `8.5M` —— 8.5 既步进不了也填不进整数框，选择器给的是 `8500 k`，
配置能存的每个值都有一个整数写法。百分比是数字加一个固定后缀：在 `60%` 上打 `6` 是一个合法的
分数，意思是每个 turn 都轮换。`对外语言` 变成两个 segment，因为 `say()` 本来就是两列表 ——
不以 中 或 zh 开头的任何东西都静默走英文列。
