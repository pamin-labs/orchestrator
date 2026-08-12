# PROGRESS

开发断点文件。换 session 或被 compact 之后，读 `CLAUDE.md` → 这个文件 → `PLAN.md` 就能接着做。

**更新时机**：每完成一个**可验证单元**就更新（不是每改一个文件）。可验证 = 有一条 runnable check 变绿，或手动端到端走通一步。

---

## 当前状态

**M0–M6 全部落地，278 checks 绿。** `bun test` 全绿；`bun run src/server.ts` 起服务，web 在 `http://127.0.0.1:47821`。

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

**没验过的**：全部切片验收后的 PR 级 review（那次跑到切片 2 就因为切分问题停了）、真 remote 上的 PR、多组并行。

**成本**：全 opus 约 $0.8（Dispatcher 占大头）；`hard` 降 sonnet 后约 $0.45。单切片含独立 review 约 $0.055。

## 实测得到的、和直觉相反的事实（**别凭直觉改回去**）

**沙盒与成本**（`docs/decisions/001`、`002`）
- 沙盒**只有 deny 语义**：`allowWrite` 无法在 `denyWrite` 里开口子；不加 `denyWrite` 时写 cwd 之外是**允许**的
- `allowUnixSockets` 无效；`allowAllUnixSockets: true` 会连带打开 `/var/run/docker.sock`（一行逃逸）；`excludedCommands` 让**整条命令行**脱离沙盒。→ **localhost TCP + 每 agent token**
- `failIfUnavailable: true` 必开 —— 每种配错都是**静默**失效
- `--allowedTools` 只管权限、不裁 tool 定义。加 `--tools` + `--disable-slash-commands` + `--setting-sources project,local`：前缀 46k → 17.6k tokens、成本 $0.117 → $0.059
- **每个角色都要只读 shell**（`ls`/`cat`/`find`/`grep`/只读 git）。只给 `Bash(orch *)` 时规划岗的 `ls`、`cat` 全被拒，而 headless 下拒绝是**静默的** —— 它们只是看起来困惑并白烧 turn
- **管道把 `orch` 放最前面**：权限检查读命令行开头

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

## 剩下的（都不阻塞使用）

1. [ ] **`ctx query` 还是关键词计分 + 4k 硬上限**。`PLAN.md` §13 风险④说这是最弱的一块。**先量「agent 反复问已答过的问题」的频率**再决定要不要上 embedding。
2. [ ] **PR 流程没在真 remote 上跑过**（要在你 GitHub 账号下建仓库，属于对外动作，没擅自做）。注册项目时的预检会先告诉你能不能走通。要验就在一个真项目上注册后看 `PR flow ready` 那条事件。
3. [ ] **codex adapter 只在 fixture 上验过**：探针那次账号不支持我指定的 model。真要用先 `codex exec --json` 手跑一次确认 model 名。
4. [ ] **`denyOutsideOwns` 只到 worktree 顶层**（代码里标了 `ponytail:`）。owned 目录内部的越界写靠 reconcile 和 diff review 兜。
5. [ ] **Dispatcher 用 opus 是成本大头**（一次约 $0.2-0.45）。如果嫌贵，把 `roles/dispatcher.yaml` 的 `tier: hard` 改成 `normal`，先看拆解质量掉不掉。
6. [ ] **多组并行没 live 验过**（file ownership、merge queue、Architect 切边界都有单测）。
7. [ ] **PR 级 review 没 live 验过**：要一次「所有切片都被验收」的完整跑。切分质量修好之后再跑一次就能覆盖。
8. [ ] **切分质量是唯一没有确定性防线的环节**。`--already-done` 兜住了「切重了」的成本，但切错方向仍然只能靠你在 DRAFT 那 20 秒拦。这就是 `PLAN.md` §13 风险①，实测确认它是真的。

## 用之前

1. **注册项目就够了** —— gate、入职包、PR 预检自动完成。探测不出 gate 会明确报「no gates detected」（没有确定性底座，上面的 LLM review 就是空的）。
2. **M0 那条验收还没做**：开一个全新 session 只说「继续开发这个项目」，看它能否只靠 `CLAUDE.md` + 本文件 + `PLAN.md` 接上。
3. 想省钱：`config/default.yaml` 里把 `difficultyModel.hard` 改成 sonnet。

## 已知偏离 PLAN.md

- 新增状态 `PLANNING`
- `grp` 无 `channel_id`；增加 `owns_json` / `spent_usd` / `paused_at` / `merge_seq` / `pr_number` / `pr_seen_at` / `pr_checks_sig`
- `agent` 增加 `token` / `stable_hash` / `idle_turns` / `loop_file` / `loop_count`
- `slice` 增加 `gates_json` / `depends_on` / `base_sha` / `retries`；`job` 增加 `slice_id` / `checkpoint_sha`；`lease` 增加 `head_sha`
- 传输层从 unix socket 改成 **localhost TCP**（决策 001）
- `profiles/` 不是静态文件，按组生成
- **intent 只有 5 种**（`ask`/`request`/`inform`/`note`/`decision` + 正交字段）
- 迁移共 8 条，全部 append-only
