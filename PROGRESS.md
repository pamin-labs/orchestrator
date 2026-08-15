# PROGRESS

开发断点文件。换 session 或被 compact 之后，读 `CLAUDE.md` → 这个文件 → `PLAN.md` 就能接着做。

**更新时机**：每完成一个**可验证单元**就更新（不是每改一个文件）。可验证 = 有一条 runnable check 变绿，或手动端到端走通一步。

---

## 当前状态

**PLAN.md 全部实现完毕，`bun test test/` 498 checks 绿。** `bun run dev`（构建前端 + 起服务），web 在 `http://127.0.0.1:47821`。

**你只需要三个动作**：丢想法 → 批 DRAFT 卡（20 秒）→ 查收切片。gate 探测、入职包、PR 权限预检都在注册项目时自动完成。

### 唯一还没被真实执行过的一步

**`gh pr create` 打真 GitHub。** 两侧都验过：preflight 打过真 API（正确报出「没有 remote」和 `viewerPermission`），squash + push 到本地裸仓库成功，`pollPrs` 的 MERGED 检测有 check。**中间那一次网络调用没跑过** —— 第一个需求收尾时会走到它，出问题也只影响这一步（分支和 journal 都已经在），失败会以 escalation 的形式落到「待办」。

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

## live 验证到哪一步（真 `claude -p`，全自动无人手写）

一整条链逐段验过：

注册项目（gate 自动探测出 `bun test`、Librarian 写出真实入职包、PR 预检正确报「没有 remote，只有 PR 那步会卡」）→ 丢一句中文需求 → Dispatcher 读代码 + `orch ctx query` + 问 Architect → Architect 回真意见 → **Dispatcher 自己交出 11 行合规卡**（`反对` 栏是 Architect 的类型设计批评）→ 你批（不带 card，用它交的那张）→ 建 worktree/branch/task → Engineer 干活 → **reconcile pass → gate pass → QA pass** → 待查收 → **你验收 → 下一片自动开工**。

**多组并行也验过了**：两个组各自 branch、**同时各有一个 turn 在跑**；Architect 真调了 `orch owns` 切边界。

**一次完整的三切片需求，零重试**（切分防线 + claim 强制 + `--already-done` 三处修复合起来的结果 —— 同一个需求上一轮在切片 2 连败三次）：
```
S1 lang 参数 + zh 分支 + 测试      reconcile✓ gate✓ qa✓ accepted
S2 未知 lang 显式回退英文并有测试   reconcile✓ gate✓ qa✓ accepted
S3 导出 Lang 联合类型供外部复用     reconcile✓ gate✓ qa✓ accepted
```
QA 的判决有内容不是盖章：`S2 pass: Unknown lang values explicitly fall back to English (tested with 'fr', 'es', 'invalid')`

**PR 级 review 也验过了**（三片全查收之后）：branch gate 绿 → **拒绝收尾，因为没写 retro** → PM 写出有内容的 retro（写明 S1 已经把功能做完、放宽参数类型才编得过）→ 交 retro 自动恢复 PR 级 review → `PR_OPEN` → **Auditor 在组外被雇**（`grp_id` null，同 project，独立 session、独立 context）→ 它自己 `orch ctx query` 调出 DRAFT 卡、`git log main..orch/greet` 读全 diff → `orch audit 1 --verdict pass`（判词点到三片各自的验收断言 + 「无平行造轮子」）→ 进串行 merge queue 拿到 `merge_seq 1` → 停在等你 merge。Auditor 一次 $0.21。
只有真正开 PR 那一步没走通，原因正确且预检早就报过：`could not open a PR: no git remotes found`（fixture repo 没 remote）。

**成本**：一次完整三切片需求含每片独立 review **$0.62**（dispatcher $0.31 / engineer $0.15 / qa $0.07 / architect $0.07 / librarian $0.03）。注意这次跑**把 `hard` 降成了 sonnet**，所以里面没有一个 opus 数 —— 单独量 Dispatcher 档位的结果见下面那张表。

## 界面（面板）现状

**主操作面 = `web/`，React 19 + Tailwind v4 + shadcn 组件（Radix + cmdk + sonner）。** `bun run dev` = 构建前端 + 起服务。

四个页面各答一个问题，不重复答：

| 页面 | 答的问题 | 关键取舍 |
|---|---|---|
| **首页** | 哪个项目在等我 | 跨项目的「等你」队列 + 项目卡；没有事件流（决策时的跨项目噪音） |
| **概览** | 现在该我做什么 | 「等你」队列（可归零）+ 最活跃 8 条 + 去进展 |
| **进展** | 全部需求走到哪 | 按「谁的回合」分组：等你决策 / 执行中 / 停着 / 已交付，各自分页；标出 `并行 N/上限` |
| **需求（钻进去）** | 这一个需求的全部细节 | 切片 + 闸门刻度 + 验收依据（diff/QA 判词/闸门日志）+ 代答撤销 + 一个输入框 |
| **工位墙** | 谁在干活、卡没卡 | 在跑的排前面，空闲折叠；`turn` 数是绕圈的可见形状 |

**面板上不许再犯的几件事**（都犯过）：

1. **要老板做的决定必须给证据。** 查收按钮旁边就是 diff、QA 判词、闸门日志（`GET /api/slices/:id/evidence`）。只给标题和验收标准 = 橡皮图章，前面三道闸白跑。
2. **不可逆动作先向权威核对。** 「确认已合入」会解散组，所以服务端先问 GitHub（`gh pr view --json state`）；prwatch 检测到 MERGED 会自己收尾，正常路径老板根本不用点。
3. **卡住的状态必须有出路。** 预算烧穿有「加预算」，退回的 DRAFT 回 `PLANNING`，代答有「撤销并接管」。看门狗只发通知不给入口 = 死路。
4. **一个页面一个输入框。** 想法 / 跟组说话 / 分量分诊 / 退回理由 / 回答提问全走 `ui/composer.tsx`，都能带附件（存盘传路径，不塞 prompt）。
5. **列表一律分页并报出没显示的条数**（`lib/page.ts`）。静默截断读起来跟「就这些」一样。
6. **崩了要说话。** `ui/boundary.tsx` —— 白屏在控制面板上等于「点了没反应」，是最误导的故障。
7. **主题三态**（跟随系统 / 浅 / 深），`data-theme` 在首屏绘制前定好，深色只有一份定义。

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

## 后来补掉的

- ✅ **M0 断点验收**：开了个全新 haiku session，只说「继续开发这个项目」，它准确读出状态并合理排了优先级。断点文件有效。
- ✅ **codex adapter 真跑通**（`src/mech/../runtime/codex.ts`）：不指定 model 就能跑（指定会被 ChatGPT 账号拒）。顺带修掉「信息性 error item 被当成权限拒绝」——那会为一条杂务消息打扰你。
- ✅ **`ctx query` 换成 BM25**（`src/mech/ctx.ts`）：idf + 饱和 + 长度归一；无论问什么都先返回本组切片和验收标准（那是一切提问的框架）；中文按字切（否则中文笔记搜不到）；预算截断时明说丢了几条。**没上 embedding** —— 这是值得拿去量的基线版本。
- ✅ **写入约束递归**（`denyOutsideOwns`）：沿 owned 路径逐层拒绝兄弟，文件和目录都拒。`src/auth/**` 现在会拦住 `src/ui/`。
- ✅ **切分质量有确定性防线了**（`checkSplit`）：验收标准重复 / 嵌套 / 纯「补测试」片，三种都拒。故意做窄，`legacy client 回归测试套件` 仍放行。
- ✅ **写 retro 会自动恢复 PR 级 review**。之前是死路：PM 交了 retro 但没人再推一下，分支就停在「做完了、没审过」，得手动捅一下才动。
- ✅ **PR 那步之前少了 push**。全仓库没有一处 push 组分支，而 `gh pr create` 在非交互下不会替你 push，它直接 abort。也就是说**在真 remote 上每个 PR 都会失败**，原因跟账号无关。现在 push 走 repo 写锁（多 worktree 共用一个 `.git`）。
- ✅ **checkpoint 现在真的会 squash**。`checkpoint` 的注释一直写着 "Squashed before the PR"，但没人做 —— live 跑出来的分支是三条一模一样的 `wip: qa turn`。只有全是 `wip:` 的区间才压（`--soft`，工作树不动）；里面有真 commit message 就整段不碰 —— 为了整理噪音去销毁信息是划不来的。
- ✅ **回滚失败会说出来**。`rollbackTo` 不看 git 退出码，两个调用方都照样报「rolled back to abc123」。「打断并回滚」只打断没回滚，会留下一棵你以为是干净的脏工作树 —— 两种状态里更糟的那个，而且看不见。
- ✅ **卡交了之后才到的反对意见，现在也送到你眼前**。Dispatcher 故意不等 Architect（交不出卡比没反对更糟），所以反对意见常常晚一分钟到 —— 而卡上写着「反对 : 无」。更糟的是 `postMail` 盖的是**发信人**的组，常驻岗没有组，于是那条反对意见落在 `grp_id = NULL`，连组的时间轴里都看不见。实测那条反对意见是对的：「locale 推断那片和『不传 lang 行为不变』那条验收互相冲突」。你批的是一张别人已经吵过的卡。
- ✅ **空信拒收**。Dispatcher 写了 `orch mail architect --intent ask --wait` —— `--wait` 这个 flag 不存在，通用 parser 把它当 flag 吃了，于是信发出去是空的，Architect 花一整轮报告「收到的 ask 消息内容为空」。报错里直接说这个 flag 不存在，因为 CLI 是 agent 唯一的反馈渠道。
- ✅ **切片下限从 3 降到 1**。prompt 里早就写着「真的不可分就交一片，凑三片更糟」，但校验器拒收 1-2 片 —— prompt 在骗它，模型只能凑。实测在一句话需求上，它把「切片 2、3 是为满足最少切片数补的相邻能力」当风险写在自己卡上，而补出来的那片会从 `$LANG` 推断语言、**改变现有调用方的输出**。`if` 和 prompt 说的话不一致时，模型听 `if`。

- ✅ **新 worktree 现在拿得到它自己造不出来的东西**（`seedIgnored`）。`node_modules` 和 `web/dist` 都在 `.gitignore` 里，`git worktree add` 一个都不带；而 `denyOutsideOwns` 把组自己的边界外全拒了，`bun install` 和 `bun run build:web` 都是 `Operation not permitted`。结果是 `bun test` / `bunx tsc --noEmit` 在新组里必红，红的原因跟这个组写的代码没有任何关系 —— 实测同时有 6 个组这样，其中一个挂着 blocker 等了一小时。现在 create 完就从主仓库软链过去（软链不是拷贝：主仓库 rebuild，所有 worktree 跟上；往回写被 `denyWrite: repoPath/**` 挡住）。
- ✅ **进 PAUSED 一定盖 `paused_at`**。三个调用方写 `PAUSING` 都不盖时间戳（`api.ts` 的 ask-boss blocker、退回切片、`review.ts`），而 watchdog 的 park / 催办 / unpark 全部 `WHERE paused_at IS NOT NULL` —— 这种组是**静默冻结**：不会被 park、不会催你、不会自己醒，面板上看着还在跑。改在汇合点 `settle()` 盖一次，三个调用方全好；watchdog 再补一行把已经坏掉的行捞回来。
- ✅ **batched 通知也要走 backoff**。原来只有 immediate 查 `dueNow`，batched 无条件进队；而 standup 每 30 s 把同样三条 finding 原样重推一遍，攒够 5 条就发 —— 于是「5 things need you」每分钟糊一次，内容一字不差。顺带删掉 `flush()` 里重写 `lastSent` 那行：它把 strikes 打回 1，backoff 永远停在第一档。
- ✅ **`repeat_failure` 会自己消失**。原来数的是 `lease` 表里所有 `state='failed'` 的历史行，修好了也不清零 ——「typecheck 在 4 个组里失败」在这 4 个组早就绿了之后还挂着。现在只看每个 (resource, 组) 的**最后一次**。
- ✅ **`-h` 不是问题**。`parseArgs` 只认 `--`，于是 `orch ask-boss -h` 把 `-h` 当问题立了张单，挂在你名下等回答。
- ✅ **clearance 拒绝说人话**。原来直接 `JSON.stringify(permissionDenials)` 塞进 escalation 正文，你看到的是 `blocked by clearance: [{"tool_name":"Bash","tool_use_id":…` 截在半截的 JSON。同一时刻 6 张单里有 3 张是这个。

- ✅ **PR 描述不再是一句话**（`prBody`）。原来写死 "Opened by the orchestrator after the audit passed."，读起来像提 PR 的 agent 偷懒，其实压根没人写过 —— 而需求原话、每片的验收标准、四道闸结果、decision/retro 在开 PR 那一刻全都已经在库里。现在是 SELECT 拼出来的：让模型写这段等于为一次查询付钱，而且提示词会被忘掉。
- ✅ **注册项目必须有 GitHub origin**。原来没有 remote 也放行，只发一条「只有 PR 这步不能用」的提醒 —— 那是整个交付环节：分支做完没地方去。而且 `project.remote` 只在前端传了才写，preflight 明明 `git remote get-url origin` 读到了却不回存，于是 `prUrl()` 永远返回 null，「打开 PR」按钮在任何页面都不出现。现在没有 origin / origin 不是 GitHub 直接拒绝注册；gh 没装没登录仍是提醒（那个不用重新注册就能修）。
- ✅ **删掉「确认已合入」按钮**。合没合是 GitHub 的答案，`pollPrs` 每跳都在问，MERGED 自己收尾。那个按钮是让老板手动确认服务端已经知道的事，而且点错一次就把 PR 还开着的组归档了。现在只剩「去合并 PR ↗」一个链接。
- ✅ **Runner 池按标签分**（`resource.tags_json` + `leaseSlots: {default: 2, browser: 1}`）。一个全局数字只能取所有资源里最小的那个：按浏览器取 1，全队门禁排在一张截图后面；按门禁取 4，浏览器互相拖死。标签描述「争的是什么」，每个标签一个池；无标签走 `default`；一个租约占它所有标签的名额，任一满就排队；未知标签回落到 default 而不是「无限制」。
- ✅ **无头浏览器成了一等资源**（`scripts/browse.ts` + `browser` 资源）。前端切片的验收几乎都是「菜单能弹」「行能点开」，而全项目没有任何角色能验 —— QA 只能读 JSX，Auditor 因证据不足退回分支，最后让老板自己点。三组同时卡在这上面。现在 QA 写一个 JSON 步骤文件（`api` 播种 / `goto` / `click` / `expect` / `missing` / `shot`）然后 `orch lease browser --arg steps=qa-steps.json`：它在**本 worktree** 起服务器（随机端口 + 一次性数据库），跑 Chromium，失败自动截图。**步骤是数据不是脚本**（当时的理由是 Runner 跑在 host 上有真权限；005 之后它跑在组自己的沙盒里，而「agent 只能选资源名 + 校验过的参数」这条不变 —— 理由反过来了，规则没变）。实测跑通：`click text=更多` → `expect 不做了` PASS，截图为证。

- ✅ **状态机有了不变量表**（`src/mech/states.ts` + `src/mech/invariants.ts`）。每条 watchdog 规则都是一次事故换来的，而它们形状完全一样：某个转移只有一条路径会触发，那条没跑，状态就永久停住且**看起来健康**。表里一个状态一行：什么必须成立 / 谁推它 / 幂等 repair；`test/invariants.test.ts` 断言 `states.ts` 的四台机器（grp / slice / job / escalation）全被覆盖 —— 加状态不填表就构建失败。**表里只放活性**，健康检查（超时/打转/预算/env_suspect）留在 watchdog。
- ✅ **PageIndex 取代了 BM25 做「东西在哪」**（`src/mech/pageindex.ts`）。带 LLM 摘要的树 + 模型走树导航（VectifyAI 那套方法，不是向量、不是词法）。仓库文件和黑板 note（journal/retro/decision/fact/lesson）**在同一棵树**上，叶子 id 是路径或 `notes/<scope>/<kind>/<id>`。按 signature 增量，静止的仓库零调用，每跳最多 12 次 haiku。导航失败/超时降级到词法。走到 note 直接把正文带回来（journal 本来就 ≤6 行，让 agent 再取一次就是多一轮）。
- ✅ **token 实测三刀**（259 个 turn 的数据）。tool_result 占 transcript 的 **90.1%**，缓存前缀只有 5-7k 字符 —— 账单 = 拉进来多少 × 多少轮重读。所以：`maxTurnsPerJob` 60→45 且**每角色自己的上限**（qa/auditor 20，engineer 保持 45 —— 一个全局数字必然等于 engineer 的需求，reviewer 拿着它去翻仓库）；切片边界**只轮换 engineer+qa**（原来全组清空 → 95% 的 turn 冷前缀，45.5M creation ≈ 570M read 的价）；`ctx query` 直接答组状态（实测一个 turn 花 12 轮跑 `sqlite3` 全被拒）。
- ✅ **第一次 clearance 拒绝不立单**。一次拒绝叫醒 pm→architect→cos 三个 turn × 3M token，去问一个 agent 下一轮自己会绕开的问题。连续第二次才立单 —— 那才是真卡住。agent 后来走通合法路子时自动关闭。
- ✅ **PR 全链路补齐**：正文由 `prBody()` 从库里 SELECT 出来（原来是一句硬编码，读着像 agent 偷懒，其实压根没人写过）；注册项目必须有 GitHub origin；「确认已合入」按钮和路由删掉（`pollPrs` 每跳问 GitHub）；**PR 被关 → 组暂停并让出队列 + 给老板两条出路**，重开自动回队；分支被强推删不了重开时有「开新 PR」。
- ✅ **`web/dist` 陈旧从根上解决**：不再软链，`build` 成为第一道门禁 —— 每次门禁都从**这个分支的源码**产出 bundle 再测它。附带：服务端静态资源发 `cache-control: no-cache`（bundle 名字没 hash，浏览器一直喂旧的，一个已删的按钮活过了重建和重启）。
- ✅ **push 不再烧 turn**：合并按**队列**做不按时钟 —— 已有 rebase turn 排队时新 sha 不再派第二个（那个 turn 跑起来 rebase 的就是最新 main），跑完之后 main 再动**立刻**响应。曾经用时钟做过一版，错在它困住的正是「PR 卡着等 rebase」那个组。
- ✅ **日志从 123MB 降到写入端就小**：tool_result 只留 400 字符头 + 真实长度，tool_use 入参整个留（小，且是「它当时想干什么」那一半）；一天后 gzip，两周后删。写入端 ~10x + gzip ~3.5x。

## Dispatcher 档位：量过了，建议保持 opus

同一句需求、同一 fixture、同一校验器，只换 Dispatcher 的 model。比的是**它自己那一轮**，因为 `tier: hard` 只管这个：

| | 成本 | 卡 | 验收条数 |
|---|---|---|---|
| **opus**（默认） | **$0.2567**（9 步） | 1 片 / 10 行，另写了 decision journal 解释为什么只切一片 | 3 条，其中一条是**签名断言**「greet(name) 不改一字仍通过类型检查」 |
| sonnet | $0.1922 | 1 片 / 7 行 | 2 条 |

差 **$0.06/需求**，不是之前记的 $0.2-0.45（那个数是拿 sonnet 跑出来却标成 opus 的，已改）。

**建议保持 `tier: hard`。** 多花的 $0.06 买到的是那条签名断言 —— 「现有调用方不受影响」正是切错方向时最先被破坏的东西，而 DRAFT 卡是这套系统唯一能拦住方向错误的地方。要省就改 `roles/dispatcher.yaml` 的 `tier: hard` 为 `normal`，一行。

两次跑里 Architect 的成本都不可比：我的测量脚本 900 秒超时退出，把它在飞的那轮杀了（job 停在 `running`）。是脚本伪影，别去追。

## 待开发的功能：没有了

M0–M6 全部落地，324 checks 绿。下面两节都不是待办：一条是只有你能按的按钮，一条是设计上的固有限制。

### 唯一没在真 GitHub 上跑过的：`gh pr create` 这一个调用

它会在你账号下创建东西，属于对外动作，我不替你做。**它前后的每一步都验过了**：

- squash → `git push -u origin <branch>`（走 repo 写锁）→ `gh pr create` 的 argv → 记 `pr_number` → 发事件：对着**真裸 remote + 假 `gh`** 全跑通。裸 remote 真的收到了 `refs/heads/orch/greet`，而且是**一条** `orch: greet` commit
- 前置条件对着**真 GitHub API** 验过：`preflightPr` 在 `origin` 指向你 `DailyExpense` 时返回 `ok: true`（真 remote 解析、真 `gh auth status`、真 `viewerPermission` = ADMIN）
- 会失败的形状也都有 check：没 `origin` / 不是 GitHub / `gh` 没装 / 没登录 / 只有读权限

你要收尾就两步，随便挑个已有的私有仓库：
```bash
bun run src/server.ts                     # 起服务
# web 上注册那个项目，看事件流里有没有：PR flow ready (git@github.com:…)
```
真跑一个需求到底就能看到 PR 开出来。**预检失败会在注册那一刻就告诉你原因**，不会等到分支做完才发现没地方去。

### 固有限制：切错方向只能靠你在 DRAFT 那 20 秒拦

`checkSplit` 拦得住「切重了」，拦不住「切错了」。就是 `PLAN.md` §13 风险①，实测确认成立 —— 也是全系统唯一没有确定性防线的判断点。两条补强已经做了：卡上有 Architect 的反对栏，而**卡交完之后才到的反对意见现在也摆在卡旁边**，所以「反对 : 无」不再能盖住一条真反对。

## 用之前

1. **注册项目就够了** —— gate、入职包、PR 预检自动完成。探测不出 gate 会明确报「no gates detected」（没有确定性底座，上面的 LLM review 就是空的）。
2. 想省钱：`config/default.yaml` 里把 `difficultyModel.hard` 改成 sonnet（实测一次完整跑 $0.8 → $0.45）。只想省 Dispatcher 那一项就改 `roles/dispatcher.yaml` 的 `tier` —— 见上面量过的表，只差 $0.06。

## 面板上的排序规则（`web/src/lib/rank.ts`）

「待办里的每一件都重要」是对的 —— 那是进这个列表的条件。所以排序不是按重不重要，是按**不管它会怎样**：

| 理由 | 权重 | 依据 |
|---|---|---|
| agent 挂着等你答 | 100 | `ask-boss` 阻塞调用方，那个 agent 真的在挂 |
| 全组已挂起（系统提的 blocker） | 80 | 没有 agent 在挂，是组被停了 —— 不许说成前者 |
| 组停着不动 | 60 | 这个需求上没有 running 的 agent |
| 批了才开工（DRAFT） | 45 | DRAFT 屏蔽派发，整个需求零进展 |
| 后面还排着 N 个 | 12N | 合入队列头卡着后面全部 |
| 等了 Nh | ≤40 | 切片存在的理由就是这个钟 |
| 已经花了 $X | ≤30 | 花过的钱正闲着 |

**每一行显示它的理由，不显示分数。** 一个不能被追问的分数比按时间排更糟：它按没人能核对的原因挪动行，第一次看起来不对，整个顺序就再也不可信。

**同一个需求上有 ≥2 件才聚成一组**（一趟处理完）；只有 1 件就平铺 —— 每行一个组头比不分组更差。**不按 agent 分组**：老板操作的对象是需求/切片/卡/提问，agent 是「谁在等」，属于行上的上下文，不是导航维度。

## 已知偏离 PLAN.md


- 新增状态 `PLANNING`
- `grp` 无 `channel_id`；`worktree` 列被 024 删掉（从来没被写过）；增加 `owns_json` / `spent_usd` / `paused_at` / `merge_seq` / `pr_number` / `pr_seen_at` / `pr_checks_sig`
- `agent` 增加 `token` / `stable_hash` / `idle_turns` / `loop_file` / `loop_count`
- `slice` 增加 `gates_json` / `depends_on` / `base_sha` / `retries`；`job` 增加 `slice_id` / `checkpoint_sha`；`lease` 增加 `head_sha`
- 传输层从 unix socket 改成 localhost TCP（决策 001），再改成**文件信箱**（决策 005：`host.docker.internal` 只有 Docker Desktop 有）
- `profiles/` 按组生成 —— 后来整个删了（决策 005，容器就是边界）
- **intent 只有 5 种**（`ask`/`request`/`inform`/`note`/`decision` + 正交字段）
- 迁移共 8 条，全部 append-only

## 两个账号，一份工作（决策 004）

`RoleDef.runtime` 从第一版就有，八个 role 一个都没用过 —— 而它背后是空的：`difficultyModel` 里只有 claude 的模型 id，真写了 `runtime: codex` 会把 claude 模型名喂给 `codex exec -m`，当场被拒。现在补齐了，claude 只留三个决策角色：

| role | 跑在 | 模型 | effort |
|---|---|---|---|
| dispatcher / architect / cos | claude | hard 档（opus 5） | xhigh / high / high |
| engineer / qa | codex | 随切片难度（sol / terra / luna） | medium |
| auditor | codex | 钉死 `gpt-5.6-sol` | high |
| pm | codex | normal 档（terra） | medium |
| librarian | codex | trivial 档（luna） | low |

`orch ctx query` 的索引调用（全系统最频繁的一次模型调用，纯摘要）也挪到了 codex 最便宜那档 —— `config.indexModel`。

**强度（effort）两边同名**：`claude --help` 是 `low…max`，codex 的 `models_cache.json` 也是同五档，只有 `gpt-5.6-sol` 多一个 `ultra`。所以没有映射表，只在 `providers.ts` 里按 provider 声明支持的档位并钳位。effort 进了 `hashStable` —— 改强度会轮换 session，和改模型一样。

**provider 是注册表不是 union**（`src/runtime/providers.ts`）：加第三个 CLI = 一个文件 + 一行注册，`Runtime` 是 string，没有 union 要加宽、没有 `if` 要找。每个 provider 声明自己能不能约束写入（`confinesWrites`），这决定 ownership 是前置拦截还是事后对账。

沙箱、ownership 后置对账、`CODEX_HOME` 隔离、AGENTS.md 软链的实测依据全在**决策 004**。真跑了一个 codex turn 用最终这套 argv 去 `curl 127.0.0.1`，拿到 `ORCH-OK` —— 「agent 够不够得着 orchestrator」这个前提是验过的，不是推的。

### 顺手挖出来的一个真 bug：轮换分母写死 200k

`overTokenBudget` 对所有模型都除以字面量 `200_000`。翻本仓库真实 turn 日志：haiku-4-5 报 200k，**sonnet-5 和 opus-5 报 1M**，codex 的 `token_count` 报 272k。也就是强模型一直在自己窗口的 12% 处轮换 session，每轮换一次扔掉一次花钱建起来的缓存前缀。现在 `config.contextWindow` 给初值、turn 里 CLI 报的真实值覆盖它、`contextWindowFor` 把结果钳在 [100k, 2M]。

## nav 上的订阅用量

codex 每个 turn 的 `token_count` 里自带 5h 和周窗口的 `used_percent`。claude 的流里没有 —— 267 条真实 `rate_limit_event` 只有 status 和重置时间，所以 `src/mech/subusage.ts` 走那个社区通用但**未文档化**的 `api/oauth/usage`（token 从 Keychain 读，只读不写），5 分钟一次，挂了就静默降级回 status + 倒计时。整套东西不许让任何主流程依赖它。

放进 header 是对 `DESIGN.md` 那条「不放仅仅为真的东西」的有意让步：花了多少钱属于 成本 页，**今晚还能不能干活**属于这里。80% 以下是灰的。

## turns 日志

`data/turns` 涨到 59MB / 365 个文件，而**全仓库没有任何代码读它**。改成 turn 一结束就 gzip（watchdog 那道 24h 扫描退成崩溃残留的兜底，保留期 14d → 7d），codex 侧也套上了裁剪 —— 它之前写的是未裁剪原始行，claude 侧早就量过 tool 输出占文件 90.2%。

## 页面高度：窗口不滚，面板滚

老板的话：「我要能局部上下滚动，但是页面总高度就是 100vh」。做到这一步花了三轮，前两轮都错在同一个地方 —— 把高度写了两遍。

外壳原来是 sticky header + `calc(100vh - 3.5rem)` 的内容区：同一个高度写两份、两种单位，改一次 header 就悄悄失谐，而且 header 之上没有任何约束，任何子元素撑破自己的盒子就把 window 撑高。第二轮我给 `body` 加了 `overflow: hidden` —— 那不是修，是把够不着的内容藏起来，成本页的表格立刻少了半屏（老板一眼看出来：「这个是在偷懒」）。

现在：外壳是一个 `h-dvh` grid，行 `auto`（header）+ `minmax(0,1fr)`（其余），每个视图从上到下一条 `min-h-0` 链接到那个真正持有滚动条的 `Pane`。另外两条是踩出来的：

- grid 的行默认 `auto`，会长到最高的子元素为止，**不管容器上写了多少个 `min-h-0`** —— 成本页左右两列就是这么溢出的，要 `grid-rows-[minmax(0,1fr)]`。
- 视口算术只能有一处。事件流里那个 `max-h-[calc(100vh-11rem)]` 是第三份同样的算术，还在一个本来就会滚的 pane 里造了第二个滚动条。

## 待办只有一个

需求页曾经同时有两个「待办」：顶上钉着一张卡（所有等老板的事），下面 tab 里还有一个同名 tab（这些事所属的需求）—— 两个数字不一样。而且那张卡在滚动容器**外面**，一个两段长的提问就把列表挤出屏幕。

现在队列**就是**待办 tab，和别的 tab 用同一个滚动面板；`进行中` 吃下 DRAFT 和 PR_OPEN（等你批的需求也还在进行中，它的决策在隔壁 tab）。

顺带修掉一个真 bug：常驻 agent（没有 grp_id）的提问，唯一的按钮是 `去回答` → `onOpen(null)`，什么也不会发生 —— 唯一没有地方可跳的那类问题，也是老板唯一关不掉的。现在在行内回答；常驻发的非 blocker 是通知不是提问，只给「知道了」。

## `orch task list` 现在会说自己为什么短

切片是一片一片开的，后面的切片是 `pending`，它的任务卡被服务端过滤掉 —— 从 turn 里面看，这和「卡片根本没建」一模一样。实测代价：engineer 把短列表读成「S2 没有卡片」，开了一条 blocker 让老板去建卡，一个组挂起、老板队列里躺了 12 分钟，而那个状态从头到尾都是对的。提示词治不了这个，答案必须出现在提问的地方 —— 现在列表末尾直接写「S2: 1 cards, not yet open」+「不要让老板建」。

## codex-home 的保留期

`data/codex-home` 两天涨到 110MB / 78 个 rollout，一点清理都没有，而 turn 日志从第一天就有 gzip + 保留窗口。同一个窗口套上去了（`sweepCodexSessions`，watchdog 每次 tick 顺手扫）。

## 成本页「按账号」不再猜模型名

原来是 `model LIKE 'gpt%'` 推出来的 —— 今天准，任何一边改个命名就错，而事件行里没有 agent 可以 join 回去。现在 provider 直接记在 turn 事件的 meta 里，旧行还走前缀匹配兜底。

## 退回的切片会把任务卡还给工程师（八个组同时卡死那次）

一次退回（gate / qa / reconcile 任意一个）只写 `slice.status='running'` 和 `retries`，**不动它的 task 行**。task 还是 `done` —— 而 `done` 恰好是工程师唯一动不了的状态：`task list` 显示一张已完成的卡，`task claim` 说切片还没开工，`task done` 说这卡不是你的。**一步合法动作都没有**，所以那一轮只能以「问老板」收场。八个组同时卡在这个形状上，四个直接停摆，每一个看起来都是健康的 RUNNING + 有工程师在岗。

死锁的另一半：`owner_agent_id` 是行号。组里换一次工程师（轮换、重启、任何结束一行 agent 又起一行的路径），这张卡就永久锁给一个不存在的会话，没有任何东西能解开。

- `sendBack` 现在调 `reopenTasks`；`claim_json` 故意留着 —— reconcile 只从 `done` 行读它，在重开的卡上它是「上一轮已经交到分支上的东西」的记录。
- claim / done 两处谓词都认「owner 已 retired = 无主」。
- `SLICE_INVARIANTS.running` 补了 repair：`running` 的切片如果每张卡都 `done`，把卡放回去；顺手清掉 retired owner 持有的未完成卡。这条是给「已经被弄坏的行」和「以后任何一条不看卡就翻切片状态的路径」兜底的。
- **`orch task list` 现在会说这张卡上一轮交过什么**（`claim_json` + `pending` 就是「交付过又被退回」的精确判据），并指名 `--already-done`。不说这一句，重试就是从零重写，然后和自己上一条 commit 打架。

配套修掉的两个：

- **规则 8 把「上一轮带了 rebase 指令」当成「rebase 失败了」。** 只读 `payload.conflict`，不看那个 job 是 `done` 还是 `failed`。规则 15 派的 rebase 轮次正常跑完、队列一空，架构师就收到一句「The Engineer could not rebase this branch onto main」—— pm-ai-agent 连收八次，八次全假，架构师逐条驳了八轮。
- **合入了的组没人告诉它。** `pollPrs` 只查 `status IN ('PR_OPEN','PAUSED')`，MERGED 判断还压在 `if (g.status !== 'PR_OPEN') continue` 下面。组被打回 RUNNING 的窗口里 PR 合了 —— grp16 的 PR #2 进了 main，它继续给一个和 main 逐字节相同的分支派 turn。**MERGED 不该看组状态**，有 pr_number 才是该轮询的理由。

check 在 `test/stuck-slice.test.ts`（五条，去掉任一修复都会红）+ `test/watchdog.test.ts` / `test/prwatch.test.ts` 各一条。

## 切片证据面板：手风琴 + 三层表面 + rebase 后的 diff 基线

`git diff <slice.base_sha>` 在规则 15 rebase 之后就不再是这一片的改动 —— base_sha 变成 main 的祖先，别的组已合入的东西全算到这片头上。`sliceDiffBase` 只在 base_sha 仍然落在本分支（且在与 main 的分叉点之后）时用它，否则从分叉点开始 diff（= 整条分支相对 origin/main，也就是 PR 会显示的东西），面板上标出用的是哪一种。check 在 `test/worktree.test.ts`。

UI 这轮的三件事，写进了 `DESIGN.md`：

- **less is more，克制** —— 砍的是屏幕上的记号，不是事实。同一个数字只印一次；已经在框里的东西不再套框；控件不许比它控制的内容更响。
- **三层表面各有含义**：`paper` 你操作的东西（行、问题、表头）/ `rail` 你正打开的那一行 / `sunk` 机器产出的东西（diff、闸门日志、代拟答复）。分界线 `rule` 分种类、`rule-soft` 分同类，左右一样的 gutter。
- **accordion 归 Radix**（CLAUDE.md 硬约束 4 里补了 accordion）。手写的 `<button>` + boolean 少了 `aria-expanded`/`aria-controls`、方向键、`data-state`。

顺带：闸门日志改成整份局部滚动（服务端 tail 400 → 4000 行），不再把通过的行藏在计数后面；待办每一行整行可点开需求；agent 写出来的字面量 `\n` 在渲染处还原成换行。

## OpenSandbox Phase 0：探针跑完，边界要换

宿主 deny-list 那条路 001 自己写着天花板：**一条没人想到去 deny 的路径就是可写的**。换成容器边界，命题反过来 —— agent 碰不到宿主，宿主只通过 `orch` 暴露有限动作。实测结论全在 `docs/decisions/005-opensandbox-is-the-boundary.md`，几条和官方文档相反的：

- **Credential Vault 在 `defaultAction: allow` 下照样注入**（文档说必须 deny）。所以「网随便上」和「凭据不进 sandbox」不是二选一，是都要。注入是**替换** `Authorization` 头，沙盒里的假值不上线。
- **`allow "*"` 匹配不到任何东西** —— 通配符只有 `*.domain` 形式。要全放行就 `defaultAction: allow` + 项目黑名单。
- **`claude` 不本地校验 token**：格式合法的假 token 拿到的是服务端 `401 OAuth access token is invalid`。vault 这条路对 claude 成立。
- **`pause`/`resume` 是真的 `docker pause`**，文件系统和 vault 都活着（文档那句「resume 后 vault 空」是 K8s 的事）。但它**不释放任何资源**，容器还在 —— 解散组只能 `kill`。
- **`host.docker.internal` 不是答案**：Docker Desktop 才有，Linux 原生 Docker 没有。通道改用 **files API 文件信箱**（write 5ms / read 1ms / search 1ms，处处一样）；`commands.run` 约 1s/次，那是给 turn 和闸门用的，不是给闲聊用的。
- **默认 `cpu: "1"`** —— 这个仓库的 `tsc --noEmit` 因此 7.6s（宿主 2.07s）。给到 6 核就是 3.2s。慢的是配置不是虚拟化，没有 bind mount，checkout 在容器自己的 overlay 上。
- 文档里的阿里云 registry 这边拉不动（auth EOF），Docker Hub 的 `opensandbox/*` 才是真源。`code-interpreter` 镜像 **7.04GB**，自己做个小的（要 bun + node + git，`tsc` 需要 node）。
- 一个 sandbox = **两个容器**（本体 + egress sidecar），起一个 2.2–2.6s。orchestrator 崩了会漏，得有看门狗规则（硬约束 7）。

下一步 Phase 1：`src/mech/sandbox.ts` + `grp.sandbox_id`，两个 adapter 的 `Bun.spawn` 换成 `execIn`。

## OpenSandbox 落地：边界换掉了，clearance 整个删了

Phase 0 的实测在 `docs/decisions/005`。这一轮把它做完了，净效果是删代码。

**边界**：一个组一个容器。`ensureSandbox` / `execIn` / `execLines` / `putFile` / `killSandbox` 全在 `src/mech/sandbox.ts`，那是唯一知道 OpenSandbox 存在的文件。驱动挂在 `Ctx.sandbox` 上，和 `git`/`gh`/`ask` 一个模式 —— 单元测试注一个假的（`test/fake-sandbox.ts`），真的连不上就报错，不静默兜底。

**代码是 clone 不是 worktree**。worktree 的 `.git` 指向主仓库，容器里要 commit 就得把主仓库也 mount 进去，边界当场又开。从 remote main clone，出来走 **git bundle** —— 沙盒里**没有能写远端的凭据**，宿主 fetch 完自己 push。这条是硬约束 3：给了 push 凭据，「不许直推 main」就只能写在 prompt 里求它自觉。

**通道是文件信箱**。`orch` 在沙盒里写请求文件、轮询回信，宿主 `startMailbox` 每 150ms 扫一遍、拿同一套 HTTP 路由回放。`host.docker.internal` 只有 Docker Desktop 有，Linux 没有 —— 建在它上面等于宣布只支持 mac/Windows。files API 到处一样，实测 1-5ms。

**凭据不进沙盒**。真 token 写进 egress sidecar 的 Credential Vault，沙盒环境里是格式合法的假值（`sk-ant-oat01-AAA…`），出站命中绑定时 sidecar 替换 header。claude 不本地校验 token，这是这条路成立的前提。设置页在「设置」标签，存下会回收所有在跑的沙盒 —— 它们 sidecar 里还是旧凭据。凭据失效 → 组 PAUSED + escalation 指向设置页。

**删掉的**：`clearance.ts`（191 行）、`denyOutsideOwns`、`handleDenials`/`denialSummary`、`confine`/`INSTALL_DOMAINS`/`installDeps`/`SEED`、`setupRefusal`/`SETUP_BINS`、`postGit`/`reservedGitAction`、`codexHome`、codex 的沙盒参数块 + `REFUSAL` 正则、`ContainerSpec`/`containerArgv`、gate 里那条 node_modules 必须是软链的硬拦、`providers.confinesWrites`、`@anthropic-ai/sandbox-runtime` 依赖、宿主的 orch shim。

**保留但换了理由**：`reconcileOwnership` 从「codex 拦不住写的补救」变成**唯一**的 ownership 机制（容器不知道文件归属）；`orch` 的 arg_schema 校验从「沙盒唯一的缺口」变成**唯一的接口**；`allowedTools` 从 clearance 表移进 `roles/*.yaml`，因为它本来就不是安全，是这个角色给多少工具。WebSearch/WebFetch 现在**所有角色都有** —— 控制点换成了 egress 域名黑名单，而且 MITM 下每个出站域名都有日志。

**看门狗**：规则 17 从「删 worktree」改成「kill 沙盒」（pause 是真 `docker pause`，容器和磁盘都还在，不省任何东西）；新增规则 18 给活着的组续 TTL —— TTL 短才能兜住崩溃泄漏，短了就得有人续。

**新增的 check**：`test/sandbox.test.ts`（规格 + 行重组）、`test/auth.test.ts`（真值不外泄、假值格式对、失效识别、preflight 说人话）、`test/mailbox.test.ts`（请求文件的形状、阻塞语义、非 200 不吞）。`bun test test/` 464 pass。

**还没做**：`orch setup` 的端到端、真实容器里跑通一整个需求。要 `uvx opensandbox-server`（`dns+nft` 模式）起着，镜像还得自己做一个（bun + node + git，`tsc` 需要 node；官方 code-interpreter 7GB 太大）。

### 最后一米：是 sidecar 镜像旧了，v1.1.6 修好了

拿真 token 跑端到端时撞上：**只要 vault 绑了凭据，带 `%2f` 的 scoped 包请求全 403**（npm 和 bun 都中招）。绑定只写了 `api.anthropic.com`，挂的却是 `registry.npmjs.org`。

先排掉了更严重的那个可能：**不是泄漏**。拿 postman-echo（未绑定的 host、会回显收到的请求）验过，没有多出来的 Authorization 头，也没有凭据的影子 —— 注入是按 host 正确隔离的。

然后是 `%2f` 的路径重写。上游 `main` 的 addon（`components/egress/mitmscripts/system.py`）里有 `allow_single_encoded_slash`，注释直接写着「npm scoped 包的合法形式」—— 也就是修过了，只是没进我们钉的那个版本。**`opensandbox/egress:v1.1.4` → `v1.1.6`，三行全绿。**

而 v1.1.4 正是 `opensandbox-server init-config --example docker` 写出来的版本。所以 preflight 加了一条**查 egress 镜像版本** —— 这个 bug 的症状是「这个项目装不上依赖」，没人会往 sidecar 版本上想。`newEnough()` 有 check。

### 镜像做出来了，实测两条对着真容器过了

`docker/agent.Dockerfile` —— bun 1.3.14 + node 20（`tsc` 需要）+ git + 预装两个 CLI，**1.51GB**（官方 code-interpreter 是 7.04GB）。之前配置里那个 `ghcr.io/orch/agent:1` 是占位符，拉不下来，等于第一个组必挂。

`test/sandbox-live.test.ts` 驱动真代码打真容器，没 server 就**大声跳过**（打印为什么），不静默绿：

1. 沙盒建起来、provision 到位（`/usr/local/bin/orch` + `/var/orch`）、工具链齐、**够不到宿主机的文件**、从 remote clone 出 checkout、agent 在里面 commit、文件进出。
2. **agent 通过信箱够到 orchestrator，直连 47821 不通。**

顺手抓到三个只有真跑才会暴露的 bug：
- metadata 值不许有冒号 —— `grp:1` 400，改 `grp-1`
- `mode: 0o644` 被序列化成十进制 `420`，服务端按八进制字符串解析 —— 要传八进制**数字面值**（`644`/`755`）
- `git clone` 没有凭据时停在 `could not read Username` **等一个永远不会有人答的提示** —— 加 `GIT_TERMINAL_PROMPT=0`，失败才是有用的回答

还有一个设计缺口：`origin` 通常是 SSH（`git@github.com:...`），而沙盒没有 key，**SSH 也没法走 vault 注入**（那是 HTTP 头的机制）。`httpsRemote()` 改写成 HTTPS，GitHub 的只读 token 绑在 sidecar 上 —— 私有仓库能 clone，而容器里依旧什么凭据都没有。

`ORCH_SANDBOX_API_KEY` 走环境变量：`config/default.yaml` 是提交进仓库的，密钥写那儿就是泄漏。

`bun test test/` 468 pass（带 key），466 pass + 2 skip（不带）。

### 镜像为什么自己做，以及沙盒里能不能上网 —— 都量了

**自己做 vs 裸 ubuntu**，每个沙盒：

```
orch/agent:1                     3.8s 就能用
ubuntu:24.04                     2.4s 建出来
  + git/node/npm (apt)         297.9s
  + claude + codex (npm)        40.6s
                               ------
                               340.9s，而且每个组都要再付一次
```

裸镜像是「小的那个成本，付一次」，工具链是「大的那个成本，每组付一次」。1.5GB 磁盘换每个需求开头省下五分半。写进 `docker/agent.Dockerfile` 的注释里了。

**web research 能用**（`defaultAction: allow`）：`bun.sh/docs` / `api.github.com` / `registry.npmjs.org` 全 200；`api.anthropic.com` 无凭据回 401 —— 说明网络通到了，是 API 拒的不是网络拒的。**黑名单是真拦**：配了 `denyDomains: [example.com]` 之后 example.com 直接不通，同一个沙盒里 bun.sh 照样 200。

镜像刷到最新：`execd v1.0.22`、`egress v1.1.6`，agent 镜像 `--pull` 重建。468 pass。

preflight 那条改准了：本地留着旧 egress 不再误报 —— server 用哪个 tag 写在它自己的 toml 里，我们看不到，所以报「有没有够新的」并把「记得把 [egress] image 指过去」写进修法。

### 凭据：两边都是 OAuth，都在 web 里点，都不进沙盒

**claude** —— `claude setup-token` 的一年期 token，贴进设置页，真值只进 egress sidecar。

**codex** —— 之前以为订阅走不通 vault，因为它的凭据是一对会自己刷新的 access/refresh token。查了官方 CI 文档（`learn.chatgpt.com/docs/auth/ci-cd-auth`）：官方做法就是「把 auth.json 放到 runner 上，让 codex 自己刷新，刷完存回去」—— 和我第一版做的一样。但同一篇里还有一句直接打在这个设计上：

> Do not share the same file across concurrent jobs or multiple machines.

一支车队正好是十个并发。所以改成：**refresh token 留在宿主，orchestrator 一家负责刷新**（`auth.openai.com/oauth/token` + client id `app_EMoamEEZ73f0CkXaXp7hrann`，两个都是从 codex 二进制里读出来的，不是猜的），沙盒拿到的是形状对、值是假的 auth.json，真 access token 由 sidecar 出站时换上。和 claude 完全同一个形状。

**都不用你敲命令了。** 设置页每个 runtime 一个「点这里登录」：服务端在这台机器上跑一次官方 CLI 的登录，把它打印的链接推到界面上、顺手替你打开浏览器，你批准完凭据自己存下。不重实现 OAuth —— 两个 CLI 本来就会「打印链接、等浏览器、交出凭据」，重写一遍只会得到一份和上游脱节的实现。

顺带修的：`vaultFor` 里 `chatgpt` 模式的跳过写在了 push 之后，于是整份 auth.json 被当成 bearer token 绑上去了 —— 测试抓到的。

`bun test test/` 474 pass。

### 设置收进一个 dialog，用量只算订阅账号

**两页并一个 dialog。** 『设置』（齿轮）和『配置』（tab）是两个作用域 —— 这台服务器 vs 这个仓库 —— 但它们由同一套 `Pane + 2 列网格 + H2 + Field` 拼出来，长得一模一样，谁也没说自己管到哪。而且视图有 76rem 宽、内容只有十来个字段，四版页面每一版都是右下角一片死白。

现在是一个 dialog：左栏两组（`服务器` / `这个项目 · <名字>` + repo 路径），右栏一节内容。作用域由分组说，不由每页自我介绍。`#v=settings` 和 `#v=config` 都还能开，各自落在原来那一节；`配置` 从头部 tab 条摘掉了。DESIGN.md 的 modal 禁令加了这一条例外的来由 —— 这是第五版，不是第一想法。

**闸门看得出是开关了。** 之前按 `resource` 表的字母序渲染、却给每行标运行序号，屏幕上是 4/1/3/2。现在开的排上面、按运行序编号、有拖拽手柄，关的在一条 rule 底下没有序号。拖拽是原生 HTML5 DnD（手柄 draggable，不是整行 —— 整行是那个开关，drag 结束还会当成 click 把闸门关掉），键盘 `Alt+↑/↓`。没加依赖。

**用量条只对订阅账号拉了。** `subusage.ts` 读的是宿主机自己的 Claude Code keychain，跟设置页存的 `runtime_auth` 是两回事 —— Claude 配成 API key 而你本机登着 Claude Code，头部显示的是你个人订阅的额度，不是舰队在烧的那张 key。Codex 只是碰巧对（api_key 的 rollout 文件里没有 `rate_limits`）。现在两家都过 `subscriptionAccount()`：模式是订阅 **且** base_url 为空或官方 host（自建网关后面是另一个账号），否则连行一起删掉。头部永远不出现钱 —— `spent_usd` 在 migration 023 就删了，要出美元只能写死单价。

顺带修的：存下按钮挂在「API 地址」行上却存 token 且 `disabled={!secret.trim()}`，于是只改自建网关地址存不下去；存失败也照样清空输入框，被拒的 token 直接没了只剩一个 toast。

`bun test test/` 475 pass。

### 容器化留下的旧防线，扫掉；顺手堵上信箱开的窟窿

**先说结论：没有一层安全措施是重复的。** 容器 / 凭据 / `orch` 校验三层各管各的，容器之前那套宿主补偿（`clearance.ts`、`confine()`/srt、`setupRefusal`、`handleDenials`、`postGit`）在 005 那轮就删干净了。这轮扫出来的是**残骸**，加一个反向的发现。

**窟窿：信箱把老板的路由也送进了沙盒。** `serve()` 拿请求文件里的 path 原样重放给本机 server，而 `/api/*` 不做 token 检查 —— 它本来只有 127.0.0.1 上的浏览器够得着，信箱让沙盒也成了 127.0.0.1。于是沙盒里的 agent 可以 `POST /api/draft/<id>/approve` 自己批自己的卡、`/api/slices/<id>/accept` 自己查收自己的切片、`/api/auth` 覆盖老板的凭据 —— 三道闸门从边界内部整个绕过去。**换传输的时候信任边界跟着换了，没人跟上。** 现在 `serve()` 只放 `/orch/`，其余回 403（不是丢掉：丢掉的话 agent 永远等回信）。`test/mailbox.test.ts` 两条守着。

**删掉的残骸**：`denyOutsideOwns`（005 的记录里写着删了，其实只有测试在引用它，53 行）、`worktree.ts` 里六个函数早没了、说明还在的孤儿注释块（76 行）、`api.ts` 的 `installDomains`、`settingsPath`（永远是 `""`，两个 adapter 都不读，却还进 prefix hash）、`test/sandbox-probe.sh`（探的是 Claude 内置 seatbelt）、`--allowedTools`（`--dangerously-skip-permissions` 之下它管的事不存在了；`--tools` 才是省 46k 前缀的那个）。

**两个从来没被写过的列**（migration 022 DROP）：`clearance` 每行都是默认 `'L1'`，工位墙照着它显示「权限 L1」—— 一个没有权限等级的系统在给老板看权限等级；`denial_turns` 数的是权限拒绝的连续次数，而容器里不会再有权限拒绝。

**文档扫尾**：PLAN.md 的 §2/§4/§5/§8/§10/§12 还在写 Seatbelt、`--settings <clearance-profile.json>`、「Runner 跑在 host 上有真权限」、`denyWrite` 挡住越界写；decisions 003/004 重新标了 status（004 的三条决定有两条被 005 取代）；005 的 header 说 vault 还开着，其实早落了，Ceiling 里补上信箱这条。**不扫的话，下一个人照着 PLAN.md 会把 clearance 那套建回来。**

`bun test test/` 498 pass。

## 技能进沙盒（决策 006）

**`--disable-slash-commands` 的 help 原文是 "Disable all skills"。** 002 用它省前缀，省下来的那部分是拿整个技能功能换的 —— 打给 agent 的 `/impeccable` 一直什么都不发生，而 PLAN.md 把这件事写成「技能不走 slash 命令」，读起来像个设计选择。剩下的那条注入路径（老板在输入框提到技能名 → 宿主读 SKILL.md → 塞进那一个 turn 的 delta）是好的，但只有老板能发起：agent 干到第 20 个 turn 时，不知道有哪个技能能帮它。005 之后还更糟 —— 技能正文里指的 `reference/*.md` 是宿主 home 里的路径，容器里根本不存在。

现在两条路并存：

- **挂的**：勾中的全局技能，宿主解引用复制到 `<dataDir>/skills`，每个沙盒只读挂在 `/root/.claude/skills` 和 `$CODEX_HOME/skills`，CLI 自己发现。
- **塞的**：不变，没勾选的技能照样能这么给。

**必须是复制不是挂原目录**：`~/.claude/skills` 和 `~/.codex/skills` 两边全是符号链接（本机 93 + 89 个，指向 `.agents/skills` 和 plugin cache），直接挂进容器是一目录断链。`cpSync({dereference:true})` 一步解决，去重顺手就完成了。**暂存目录必须原地增量改** —— 容器挂的是 inode，重建再 rename 会让所有在跑的沙盒盯着旧的。

**勾选存的是关掉的那些**（`setting` 表，migration 023），所以明天装的技能明天就能用，不用回去勾。设置页把「勾了几个 · 每 turn 前缀约多少」摆在勾选框旁边 —— 这是老板自己的账单，硬约束 5。输入框的 `/` 面板照旧列全部技能，点到没勾的先问一句：去设置勾上，还是取消这次插入。

**顺手**：主题从 nav 挪进设置的「偏好」（三态 Segments，比原来那个循环图标说得清；`startTheme()` 在 `main.tsx` 里先跑，避免首屏闪一下别的主题）。`bunfig.toml` 加 `[test] root = "test"` —— `bun test` 不加路径会把 `data/` 里别人的 `*.test.ts` 当成我们的（一直有 27 个无关失败，加上技能暂存目录只会更多）。

**后来实测出来的三条**（少一条整套就是摆设）：`--tools` 不带 `Skill` 时技能目录根本不加载（问 agent「你有哪些技能」答 NONE）；`--setting-sources project,local` 下 CLI 不看 `$HOME/.claude/skills`，而挂载点就在那儿 —— 容器里 HOME 是 `/root`，`user` scope 就是我们挂的那个目录，195k 那个数是在宿主上量的；暂存目录不能放 `dataDir` 底下，sandbox 服务端只挂 `allowed_host_paths` 里的路径（默认只有 `/var/tmp/orch-cache`），所以走 `skillsDir` 配置，挂不上时先不挂技能把组开起来并明说要放行哪条路径。

**还没验的**：codex 读不读 `$CODEX_HOME/skills` 只有目录约定，没有文档；`test/sandbox-live.test.ts` 要补三条 —— 挂载可见、只读（`touch` 失败）、摘掉 flag 前后各跑一个 haiku turn 记前缀差值。沙盒服务端的 `allowed_host_paths` 必须包含 `<dataDir>/skills`，preflight 会把这条路径原样说出来（服务端自己的 TOML 不是我们能读的，所以只报要求，不假装检查过）。

`bun test` 504 pass。

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

**接 GitHub 是一次登录 + 一次安装，两件事**（`c11f702` `1060b6d`）。设备流，`client_id` 不是机密所以进仓库（`Iv23liUP6a00TszuLZvc`，app 在 Pamin-Labs 名下，slug `orchestrator-connect`，Public）。**授权 ≠ 安装**：GitHub App 的 user token 只够得到 app 装过的仓库，所以「授权了但没装」是一个看起来像成功、实际一个仓库也列不出来的状态，面板单独一态。App 本身可以在设置里换，存 `setting` 表不存 yaml —— yaml 是提交进仓库的，自托管的人改了下次 pull 就丢。

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
