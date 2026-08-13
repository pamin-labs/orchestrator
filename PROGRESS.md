# PROGRESS

开发断点文件。换 session 或被 compact 之后，读 `CLAUDE.md` → 这个文件 → `PLAN.md` 就能接着做。

**更新时机**：每完成一个**可验证单元**就更新（不是每改一个文件）。可验证 = 有一条 runnable check 变绿，或手动端到端走通一步。

---

## 当前状态

**M0–M6 全部落地，324 checks 绿。** `bun test` 全绿；`bun run src/server.ts` 起服务，web 在 `http://127.0.0.1:47821`。

**你现在只需要三个动作**：丢想法 → 批 DRAFT 卡（20 秒）→ 查收切片。gate 配置、入职包、PR 预检都在注册项目时自动完成。

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
- `--allowedTools` 只管权限、不裁 tool 定义。加 `--tools` + `--disable-slash-commands` + `--setting-sources project,local`：前缀 46k → 17.6k tokens、成本 $0.117 → $0.059
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

## 已知偏离 PLAN.md


- 新增状态 `PLANNING`
- `grp` 无 `channel_id`；增加 `owns_json` / `spent_usd` / `paused_at` / `merge_seq` / `pr_number` / `pr_seen_at` / `pr_checks_sig`
- `agent` 增加 `token` / `stable_hash` / `idle_turns` / `loop_file` / `loop_count`
- `slice` 增加 `gates_json` / `depends_on` / `base_sha` / `retries`；`job` 增加 `slice_id` / `checkpoint_sha`；`lease` 增加 `head_sha`
- 传输层从 unix socket 改成 **localhost TCP**（决策 001）
- `profiles/` 不是静态文件，按组生成
- **intent 只有 5 种**（`ask`/`request`/`inform`/`note`/`decision` + 正交字段）
- 迁移共 8 条，全部 append-only
