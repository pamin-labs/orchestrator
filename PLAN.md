# Orchestrator — 一人公司 AI 员工调度系统

## Context

**问题**：现在的工作方式是「自己整理需求 → 自己写 plan → 一轮轮和 Claude 对话矫正 → 自己验收」。三个环节里有两个是老板不该做的活。

**目标**：建一个本地系统，你只做两件事 —— **丢需求** 和 **验收**。中间的需求提炼、拆解、架构决策、编码、测试、审阅、PR 反馈处理，由不同职责的 AI agent 分组接管。你随时能看到每个 agent 在干什么、随时能插话干预，被卡住时会被通知。

**为什么现有工具不行**：vibe-kanban / Conductor / Claude Squad 做了「kanban + worktree + 并行 agent」，Claude Code 原生 Agent Teams 做了「组内消息 + 共享 task list」。但都没有：角色分化的部门与代答链、可随时插入的三级 intercept、跨组共享受限资源的租约队列、确定性强制的 journal 与对账、非代码领域通用。**这些正是核心需求，所以自建。**

**组的状态机（实现时新增了 `PLANNING`）**：
`PLANNING`（Dispatcher/Architect 在规划，可派发）→ `DRAFT`（卡片已交，**等你批，屏蔽派发**）→ `RUNNING` → `PAUSING`/`PAUSED`/`PARKED` → `PR_OPEN` → `DISSOLVED`。
把这两个状态分开是必须的：Dispatcher 得先跑完才有卡给你批，「在规划」和「等你批」不能是同一个状态。

**三条硬约束（决定了后面所有设计）**：

1. **需求深挖由 AI 做，但开工必须你批。** PM 靠 `orch ctx query`（黑板 + 历史 retro）+ 读代码 + 问 Architect 自行深挖，**只有命中不可代答六条才找你**。
   **`DRAFT` 门阻塞，无自动放行**（卡片由 Dispatcher 用 `orch draft` 提交，提交时校验，所以你永远不会看到一张坏卡）。 但既然阻塞，卡片本身必须硬性精简 —— 否则「必须你批」会退化成「每天读十份需求文档」。见 §7 DRAFT 卡规范（≤12 行，超长 `orch` 拒收）。你批的是**方向和验收标准**，拆解细节与实现不用看，20 秒。
2. **一次大查收拆成多次小查收。** 没有前置门，拆错了必须尽早暴露。PM 必须把需求切成**可独立验收的切片**，每片完成即通知你查收。你的动作不变，但白干的单位从「整个需求」降到「一个切片」。
3. **单项目多组 + 多项目并行都要。** 单项目开多组是主场景 —— 组间边界必须**事先切开**（见 §7 file ownership），不能靠事后解 merge 冲突。

**推论**：你不在中途看任何东西，所以中途质量必须由确定性外壳 + QA 兜住。gate / 对账 / 沙盒 / 看门狗 / file ownership 这些 `if` 是这套系统最值钱的部分，比编制重要。

**产出**：`/Users/jason/Documents/GitHub/orchestrator`（当前空目录，非 git repo，需 `git init`）。

---

## 一、核心抽象：4 个一等公民

不是「IM 系统」，也不是「多 agent 框架」。是 **黑板 + 作业队列**，IM / 看板 / 工位墙都是它的 view。

| 实体 | 是什么 | 渲染成 |
|---|---|---|
| `job` | 一切**将要**发生的事 + 唯一调度器 | 工位墙、队列面板 |
| `event` | 一切**已经**发生的事（append-only） | 频道时间轴 |
| `note` | 黑板静态部分（fact / decision / journal / retro） | journal 流、`ctx query` |
| `task` | 工作单元 + 状态机 + 依赖 | 看板 |

**三个决定性推论：**

1. **`job` 队列是唯一能启动 agent 的东西。** 这是 intercept「随时可用」的唯一原因 —— 存在一个串行派发点，就永远有地方插队。intercept / park / 预算熔断 = 同一机制的三种用法。
2. **turn 即事务**：一个 agent turn = 读黑板 → 想 → 写黑板，有界（`--max-turns` + 墙钟超时 + token 预算）。打断 = 丢弃该事务，黑板停在上一致状态。
3. **agent 不监听频道**，turn 开始时注入 delta，其余按需 `orch ctx query` 自取。ambient chat 变成有界拉取，token 花销与实际需要成正比。

**「组」不是独立重实体** = task 子树 + branch + worktree + roster 引用 + 预算。
**`role` 是配置不是代码** = `roles/*.yaml`（prompt / model / 触发规则 / tool 白名单）。加「作曲」「美术」「翻译」零代码。

---

## 二、技术栈（已定）

| 项 | 选择 | 理由 |
|---|---|---|
| orchestrator | **bun + TypeScript** 单进程 | HTTP + `bun:sqlite` + 进程管理 + SSE 全内置，零依赖起步 |
| agent runtime | **CLI 子进程**，非 SDK | per-turn 换 model 只是 flag；进程崩不带走 orchestrator；codex 同形状；hooks/skills/CLAUDE.md 原样生效 |
| agent↔orchestrator | **`orch` CLI over Bash**，走**文件信箱**（沙盒里写请求文件，宿主轮询回信）+ 每 agent token | 零新 tool schema（Bash 已有）；阻塞 + 真返回值（stdout）；codex 同样能用；终端可手测。**不是 localhost TCP** —— `host.docker.internal` 只有 Docker Desktop 有（`docs/decisions/005`）。信箱只放通 `/orch/*`，`/api/*` 是老板的界面，沙盒够不着 |
| state | **sqlite (WAL)** + journal 落 git | 易变的进 DB；journal 进 repo 跟 PR merge，可 diff 可 grep |
| 沙盒 | **一个组一个 OpenSandbox 容器** | 内置沙盒只有 deny 语义，「只有这个 checkout 可写」压根表达不出来（`docs/decisions/001`）。容器把它反过来：宿主碰不到，宿主只通过 `orch` 暴露有限动作（`docs/decisions/005`）。CLI 在容器里用 `--dangerously-skip-permissions` —— 进程内再自我约束就是那堆静默拒绝的来源 |
| UI | **React + Tailwind v4 + shadcn/ui**（Radix 行为层）+ SSE | 手写组件层试过了，弹窗/菜单/焦点管理自己实现一遍不如用 Radix。视觉语言仍是自己的（`DESIGN.md`），shadcn 只提供行为 |
| PR | GitHub private repo + `gh` | 所有项目（含非代码）统一。注册项目时**预检** remote 和 `gh` 登录，不等分支做完才发现没地方去 |
| gate | 注册时**自动探测** | 从 package.json / Cargo.toml / go.mod / pyproject / csproj / justfile / Makefile 推断，并注册对应 resource 模板。探测不出来就明说「没有 gate」，不瞎猜命令 |

**不用 MCP**：tool schema 每 session 注入 + sentinel JSON 无返回值语义（`lease` 需 mid-turn 返回，否则每次申请编译都要一个 turn 边界）。`orch` CLI 两个问题都没有。

**曾经不用 OpenSandbox**（v1 的判断）：macOS 上它是 Docker/Linux VM，而受限资源恰是 macOS 原生的（Unity/Xcode/原生编译）。这条已被 `docs/decisions/005` 推翻 —— 内置沙盒的 deny-only 天花板比跨平台的代价贵。macOS 原生工具链的项目现在是「这台机器跑不了」，不是「放开边界」。

---

## 三、数据模型

```sql
-- 项目与组
project(id, name, repo_path, remote, config_json)
grp(id, project_id, name, branch, worktree, status, owns_json, budget_tokens, spent_tokens, spent_usd)
  -- status: DRAFT | RUNNING | PAUSING | PAUSED | PARKED | PR_OPEN | DISSOLVED
  -- no channel_id: `channel.grp_id` is the only link, a reverse pointer would be
  --   a second source of truth for the same edge

-- agent 身份持久，session 一次性
agent(id, project_id, grp_id, role, model, session_id, session_tokens, cwd, activity, state)
  -- state: idle | running | waiting_lease | blocked | retired

-- 四个一等公民
job(id, kind, grp_id, agent_id, payload_json, priority, state, enqueued_at, started_at, ended_at, pid)
  -- kind: agent_turn | lease | watchdog | digest | notify | gate | reconcile
  -- state: pending | running | done | failed | cancelled
event(seq, channel_id, grp_id, author, kind, intent, body, wake_json, meta_json, at)
  -- kind: say | boss_say | tool_summary | lease_result | commit | escalation | state_change | digest
note(id, project_id, grp_id, task_id, kind, lang, body, frontmatter_json, export_path, at)
  -- kind: fact | decision | journal | retro | handoff | risk | onboarding | lesson
  -- onboarding: 项目级入职包（Librarian 维护）；lesson: retro 归纳出的教训清单（≤20 条）
slice(id, grp_id, title, accept_spec, difficulty, status, budget_tokens, spent_tokens, seq)
  -- 可独立验收的交付单元。difficulty: trivial | normal | hard → 决定跑它的 model（E）
  -- 预算按 slice 而非按组（token 经济学 #9）；session 在 slice 完成时轮换（#2）
task(id, grp_id, slice_id, title, status, owner_agent_id, depends_on_json, claim_json)
  -- claim_json: agent 声称的产出，供 reconcile 对账

-- 支撑
channel(id, project_id, grp_id, kind, status)      -- kind: group | project | boss
member(channel_id, agent_id, mode)                 -- mode: full | rep
cursor(agent_id, channel_id, last_seq)             -- 有界 delta 注入的关键
lease(id, resource, grp_id, agent_id, template, args_json, state, exit_code, log_path, result_digest)
resource(name, concurrency, template, arg_schema_json, error_regex)
escalation(id, grp_id, agent_id, severity, question, chain_state, answered_by, answer, ref_note_id, checkpoint_sha)
```

**四张表吃掉的东西**：`mail`（合入 `event`）、`facts`/`journal`/`decision`/`retro` 四表（合入 `note`）、常驻岗与临时组两套调度路径（合入 `job`）。

---

## 四、`orch` CLI —— agent 的唯一出口

```bash
orch ctx query "<问题>"              # 按需拉黑板切片（note + event + journal + diff）
orch ask-boss --severity {blocking|advisory} "<问题>"   # 阻塞，走代答链，stdout = 答复
orch lease <resource> [--arg k=v]…  # 阻塞，stdout = result_digest；资源模板预定义
orch lease log <id> [--grep RE]     # 取全量日志（不进 context）
orch mail <target> --intent {ask|request|inform|note|decision} [--severity …] [--in-reply-to …] "…"
orch journal add --kind <k> -        # stdin 读；≤6 行硬校验，不合规拒收
orch task list                       # id status slice owner title，一行一条（不是 JSON 数组）
orch task claim <id> / done <id>     # 只能是 list 里的**数字 id**
orch draft <group_id> -              # Dispatcher 交 DRAFT 卡（stdin），交时校验
orch owns <group_id> --path <glob>…  # Architect 切边界
orch review <slice_id> --verdict …   # QA 判决（值，不是散文）
orch audit <group_id> --verdict …    # Auditor PR 级判决
orch answer <esc_id> --answer … | --abstain --why …
orch status "<一句话>"               # 工位墙上的当前意图
orch git -- <cmd>                    # repo 级 git 写锁，串行化
```

**技能（skill）不走 slash 命令**：agent 带 `--disable-slash-commands` 且不继承用户级设置（实测技能目录 + slash 命令 = 每 turn ~46k 缓存前缀；继承老板全局设置让一个 haiku turn 涨到 ~195k）。老板在输入框里 `/` 选技能时，**orchestrator 在 host 上读 SKILL.md，把正文追加进那一个 turn 的 delta**（消息末尾，不进 stable 半边）。于是：用一次付一次、缓存前缀不动、`~/.claude/skills` 里的技能也能给到看不见该文件的 agent。

**`lease` 永不接受自由命令**：以前的理由是「Runner 跑在 host 上有真权限，这是沙盒的唯一缺口」；现在它跑在组自己的沙盒里，理由反过来 —— **`orch` 是 agent 唯一的接口，它的校验就是整条边界**（`docs/decisions/005`）。资源是 `resource` 表里**预定义的命令模板**，agent 只能选资源名 + 传经 `arg_schema` 校验的参数，**永远不能传自由命令**。agent 确实需要新命令时发 escalation，你在 UI 上看完整命令行点批准，批了可选存成新模板。

**`lease` 返回只给三段**：exit code + 尾 200 行 + `error_regex` 抽出的失败行。全量日志落盘。几 MB 的编译日志一次能炸掉半个 context。

---

## 五、agent 运行时

**spawn（每 turn 一个进程）：**
```bash
claude -p --output-format stream-json --include-partial-messages \
  --resume <session_id> --model <role.model> --add-dir /work \
  --dangerously-skip-permissions \
  --setting-sources project,local --strict-mcp-config \
  --tools "Bash,Read,Edit,Grep,Glob" --disable-slash-commands --max-turns N
```
在容器里跑。`--dangerously-skip-permissions`：容器已经是边界，进程内再自我约束就是那堆静默拒绝的来源。`--tools` 是省前缀的（~46k/turn），不是权限 —— 权限已经被上一行关掉了。
codex 走 `codex exec resume <id> -m <model>` + `--dangerously-bypass-approvals-and-sandbox`，同一个 adapter 接口。

**边界 = 一个组一个容器**（`docs/decisions/005`，取代本节原来的 clearance 设计）。

原来的设想是「按组生成一份 sandbox settings profile」。001 实测把它否掉了：**内置沙盒只有 deny 语义** —— `allowWrite` 无法在更宽的 `denyWrite` 里开口子，所以「只有 worktree 可写」根本表达不出来，只能反向一条条 deny，而天花板写在 001 里：**一条没人想到去 deny 的路径就是可写的**。

换成容器后命题反过来：**agent 碰不到宿主机，宿主机只通过 `orch` 暴露有限动作**。于是：

- **clearance 这个概念没了。** L1/L2 的三样东西各自去处：deny-list profile 删掉；worktree 内的文件归属退回 `reconcileOwnership`（事后 git revert）；工具白名单进 `roles/*.yaml` —— 它本来就不是安全，是「这个角色给多少工具」。
- **L3 不变**：secrets、花钱、merge to main 永不授予 agent。secrets 现在由 Credential Vault 保证 —— 真 token 在 egress sidecar 里，沙盒里是假值；merge 由「沙盒没有能写远端的凭据」保证 —— 代码用 git bundle 出来，宿主 push。
- **代码不是 worktree 是 clone。** worktree 的 `.git` 指向主仓库，要在容器里 commit 就得把主仓库也 mount 进去，边界当场又开。
- **失败必须响。** 001 那句「每一种配错都是静默失效，看起来和成功一模一样」现在的形态是 preflight：docker / opensandbox-server / 每个 runtime 的凭据，缺哪个说哪个、附上修法，**绝不静默降级回宿主模式**。

**每个角色都需要只读 shell**（`ls`/`cat`/`find`/`grep`/只读 git）。实测：只给 `Bash(orch *)` 时，规划岗的 `ls`、`cat` 全被拒，而 headless 下拒绝是**静默的**，它们只是看起来很困惑并白烧 turn。`orch` 仍是唯一能改变世界的通道。
**管道要把 `orch` 放最前面** —— 权限检查读命令行开头，`orch journal add <<'EOF'` 过，`cat f | orch journal add` 不过。

**session 主动轮换（不做这条，跑到第三天开始鬼打墙）**：
**主触发是「切片完成」**，不是 token 阈值 —— 切片是天然语义边界，交接最干净且最省（见 §7 token 经济学 #2）。token 过上限 60% 作为兜底触发。
轮换流程：写交接 journal → `--session-id <new>` 开全新 session → 开场 = 任务卡 + 入职包 + 教训清单 + 交接 + `ctx query` 提示（**全部放在消息末尾**）。
**agent 身份持久（角色/归属/累计成本），session 一次性。**

**沙盒违规这一节没了**：内置沙盒的静默拒绝连同 `SandboxViolationStore`、`handleDenials` 一起删掉了。容器里 agent 想干什么就干什么，越界的形态变成两条：写到 owns 之外（`reconcileOwnership` 事后 revert 并说出来），和想要一个不存在的 resource（`orch lease` 直接拒，agent 发 escalation）。

---

## 六、编制（`roles/*.yaml`，11 行配置）

| 层 | 岗 | model | 触发 |
|---|---|---|---|
| 常驻 | **Chief of Staff** | opus | 你说话 / escalation 积压 |
| 常驻 | **Architect** | opus | 建组前切边界 / 设计变更 / env_suspect |
| 常驻 | **Dispatcher** | opus | 新想法进来 / `respec` 退回 |
| 常驻 | **Auditor**（不给 Write/Edit） | sonnet | PR 级审查（跨组，不共享 context） |
| 常驻 | **Librarian** | haiku | 定期 / log 超阈值 |
| 小队 | **PM** | sonnet | 组的唯一对话入口；自行深挖 |
| 小队 | **Engineer**（唯一有 Write/Edit 的角色） | sonnet | 唯一写方 |
| 小队 | **QA**（不给 Write/Edit） | sonnet | 切片级审查（独立 session） |

**降级为纯代码，不用 agent**（确定性逻辑，用 LLM 是浪费且不可靠）：
- **Integrator** → file ownership 重叠检测 + 串行 merge queue，都是 `if`
- **PR-watcher** → `gh pr view --json comments,statusCheckRollup` 轮询，有新评论才唤醒 PM
- **Runner** → lease 执行器，本来就不是 LLM

**关键定位：**
- **常驻 ≠ 常跑**：全部事件触发，idle 成本为零
- **CoS 是你和系统之间唯一的接口**：收你的碎片去重归类、打包 escalation、分诊你的不满（`patch`/`respec`/`reject`）、有先例时代答、你不在时按 park 规则处置
- **Architect 在单项目多组场景下的头号职责是切模块边界**（不是审设计）—— 边界切不干净，多组并行必然互相踩
- **PM 深挖的对象是黑板和 Architect，不是你**
- **QA 管切片级 review，Auditor 管 PR 级 review**，两者独立 session、独立 context —— review 是这套系统的质量主轴，不能省，也不能让同一个 agent 兼任
- **Runner/Integrator/PR-watcher 之所以不是 agent**，是因为它们的判断是确定性的；review 之所以必须是 agent，是因为它的判断不是

**拒掉的岗**：Requirements Analyst（Dispatcher 已做）、Security Reviewer（该是门禁不是人）、FinOps（预算熔断是 `if`）、Historian（折成 retro 产物）、Composer/Writer/Designer（Engineer 换 role prompt，零代码）。

---

## 七、关键机制（凡能用 if 拦的，绝不写进 prompt 求 agent 自觉）

### Intercept 三级
| 级 | 机制 | 延迟 | 代价 |
|---|---|---|---|
| L1 插队 | 你的话入 event，下个 `agent_turn` job 注入 | 一个 turn | 零 |
| L2 栅栏 | 停止 dequeue，等在飞 job 落地 → `PAUSED` | 数十秒~数分钟 | 零 |
| L3 硬打断 | kill running job 的 pid | 立即 | 丢一个 turn |

L3 两个按钮：**打断并保留**（脏改动留着，下个 turn 告知「你上次被打断，先看未完成改动」）/ **打断并回滚**（`git checkout` 回 turn 起点 checkpoint）。默认保留。
**每个 turn 前自动打 `wip:` checkpoint commit**，PR 前 squash —— 这是 L3 回滚和代答撤销的前提。
你打字默认「下个 turn」生效，下拉可选栅栏后 / 立即打断。

### 代答链
`PM`（组内技术细节、范围内取舍）→ `Architect`（技术选型、架构边界）→ `CoS`（**仅有先例**，须引 decision note，标 `answered_by: cos`）→ **你**。任一级可弃权，**全弃权立刻通知你**（不进批处理）。
每条代答带 **「撤销并接管」**：回滚到该 escalation 的 `checkpoint_sha`，你重答，从那里重跑。没这个按钮你不敢开代答。

### 不可代答硬清单（写死在 `orch`，六条）
花钱 / merge to main / 读写 secrets / 不可恢复操作（force push、drop table、rm 出 worktree）/ 对外发布 / 需求范围变更。

### 看门狗（`watchdog` job，零 LLM 成本）
| 条件 | 动作 |
|---|---|
| turn 墙钟超时（默认 10min，按 role 配） | 硬打断 + escalate |
| 连续 3 个 turn 零黑板写入 | 掐断 + escalate |
| 同一 agent 连续 5 turn 反复改同一文件 | 疑似绕圈 → Architect |
| 同一 lease 连续 2 次失败且 diff 未变 | 标 `env_suspect` → Architect |
| 组预算 > 80% / 100% | 通知 / 挂起全组 |
| 组 `PAUSED` > 2h | **park** |

### park（自动，不需你审批）
PM 写交接 journal → 退休全部 session → 撤销该组 pending job → 释放并发槽 → `PARKED`。**worktree + checkpoint 原地不动，工作零丢失。** 你答了问题点「唤醒」，开新 session 接上。
**你的批准点只有三个**：`DRAFT`（20 秒批 12 行）、切片查收、PR merge。其余时候你只是「丢想法」和「不满意就说」。

### 对账（`reconcile` job，比整个 Auditor 都值钱）
PR 前自动比对 `task.claim_json` 声称的产出 vs `git diff` 真实改动 + deterministic gate 结果。对不上直接打回，计入重试计数（默认 2 轮），**不进审批环节**。

### 一个输入框 ≠ 一个需求
老板往一个框里丢十几个问题加三四件不相关的事，是常态。**需求是 PR 和验收的单位**，所以不相关的活不能共用一张卡 —— 挤进一个 `目标` 和五片切片，最后会变成一个谁也没法分开验收/打回的 PR。

Dispatcher 第一步是**数有几件事**：不相关就先 `orch task split`，每件各自一张卡、一个 branch、一个 PR；相关的留在一个需求里当切片；**不是活的问题不是需求**（从黑板答，或 `ask-boss`）。

### DRAFT 卡规范（阻塞你，所以必须硬性精简）
`orch` 校验，**总计 ≤12 行，超长拒收**让 Dispatcher 重写：

```
目标 : 一行
不做 : 一行
验收 : 2-3 条，每条一行，必须可执行
切片 : 1-5 片，每片一行「标题 [难度] — 验收方式」（**下限 1 不是 3** —— 实测下限为 3 时 Dispatcher 会为凑数补出老板没要的切片，其中一片还会改变现有调用方的输出）
风险 : ≤2 行
反对 : Architect 的反对意见，≤2 行，无则写「无」
```

**切分质量现在有一条确定性防线**（`checkSplit`，实现时新增）：两片验收标准相同、验收标准嵌套、纯「补测试」片，三种拒收。故意做窄 —— 误伤会卡住你整条流程，比漏判更糟，所以「bun test 全绿」这类通用断言不算重叠证据。**但它只能拦「切重了」，拦不住「切错了」**，后者仍然只有你在 DRAFT 那 20 秒。

**难度标签是 Dispatcher 的产出，直接决定成本（E）**：`trivial` → Engineer 用 haiku、`normal` → sonnet、`hard` → opus。真公司不会让 senior 去改文案。你在 DRAFT 上能直接改这个标签 —— 这是你控制单次需求成本最直接的旋钮。

三个按钮：**批准** / **改完批准**（直接编辑卡片）/ **打回重拆**（一句话理由，进黑板当 fact，退回 Dispatcher）。
你批的是**方向和验收标准**，拆解细节与实现不用看。

### Review 分两级（每级都含确定性层，顺序不可换）

**切片级** —— 每个切片跑一遍，`orch task done` 触发：

| 层 | 谁 | 怎么防走过场 |
|---|---|---|
| 1. **self-review** | 同一 agent、同一 session | prompt 强制**对照验收标准逐条列出结论 + 引用自己的 diff 行**。禁止「看起来没问题」这类无信息回答；发现的问题自动变成新 task |
| 2. **gate** | 非 LLM | build / test / lint / typecheck / secrets 扫描 / 依赖审计，**退出码说话** |
| 3. **QA** | 独立 agent、独立 session | 按该切片的 `accept_spec` 独立验证，**不看 Engineer 的自评**（避免锚定）。**tool 白名单只给 `Bash(git diff*)` + `Bash(orch *)` + 定向 Read，不给无约束 Read/Grep** —— 硬性禁止重读全库（token 经济学 #3，单条最大节省） |
| → | **你查收** | 过完三层才进 `待查收` 列 |

**PR 级** —— 整组收尾时跑一遍：

| 层 | 谁 | 查什么 |
|---|---|---|
| 4. **reconcile** | 非 LLM | `task.claim_json` 声称的产出 vs `git diff` 真实改动，对不上直接打回 |
| 5. **Auditor** | 独立 agent，**跨组、不共享 context** | 需求覆盖度、架构一致性、journal 是否如实。**不查 gate 已经覆盖的东西** |
| → | **你 merge** | |

**self-review 必须有确定性锚点**（diff + 验收标准 + gate 结果），否则就是自我表扬。
**Auditor 必须独立于开发组**，否则是同一个模型审自己的同类 = 审批剧场。
**LLM 层不做确定性层能做的事** —— Auditor 不查语法、不查测试通过，那是 gate 的活。

### Gate 与审批顺序
deterministic gate（build / test / lint / typecheck / secrets 扫描 / 依赖审计）**先跑，退出码说话**。过不了的 PR 根本进不到 Auditor。LLM 只审它擅长的：需求覆盖度、架构一致性、journal 是否如实。打回 2 轮仍不过 → escalate 给你。

**打回重做必须开新 session，不 fork 原 session**（token 经济学 #4）：原 session 历史巨大且大半是失败路径。新 session 只带四样 —— `accept_spec` + gate 的失败行 + reviewer 的具体指摘 + 当前 diff。**全部放在消息末尾**（#1）。

### file ownership（单项目多组的前提，纯 `if`）
**merge queue 解决「都做完了怎么进 main」，太晚了。** 单项目开多组，冲突必须在开工前拦住。

1. Architect 建组时切出**路径所有权**（glob 列表），写进 `grp.owns_json`
2. orchestrator 检测与其他 `RUNNING`/`PAUSED`/`PARKED` 组的重叠
3. 重叠 → **不许并行**：要么串行排队（后者等前者 merge），要么退回 Architect 重切边界
4. Engineer 写到 owns 之外的路径 → 容器不知道文件归属，所以是**事后**的：`reconcileOwnership` 按 `git status` 回滚越界文件并在频道里说出来（`docs/decisions/005` §Ceiling）
5. 组开工时和 park 唤醒时都 rebase 到最新 main，避免基线漂移

**公共文件**（`package.json`、schema、共享 types）永远不进任何组的 owns —— 需要改就走 escalation，你或 Architect 决定谁改。

### 交付节奏：可独立验收的切片
没有前置审批门，所以拆错必须尽早暴露。
- PM 必须把需求切成**可独立验收的切片**，每片是一个 task 子集 + 一条验收方式
- 每片 QA 过 + gate 过 → **立刻通知你查收**（不等整个需求做完）
- 你查收不满意 → 走下面的反馈回路
- **白干的单位是一个切片，不是整个需求**

### 反馈回路：你的不满意怎么生效
你在频道里直接说，或跟 CoS 说。CoS 分诊三种：

| 分诊 | 含义 | 动作 |
|---|---|---|
| `patch` | 局部改 | 你的原话写进 `note(kind=fact)`，PM 建修正 task，继续跑 |
| `respec` | 方向错了 | **退回 Dispatcher 重新深挖**，原话作为最高优先级 fact；已有代码保留在 branch 上待 Architect 判断复用 |
| `reject` | 作废 | 组解散（仍必须写 retro），branch 保留不 merge |

关键：**`respec` 必须存在**。否则你的不满只会被理解成「改一行」，而拆解方向的错误永远得不到纠正。

### merge
**串行 merge queue（纯代码）**：一个 PR 进 main 且 gate 全绿才放下一个。跨组语义冲突时拉两个 PM 的**代表**进来（file ownership 已经挡掉大部分，这里只剩语义冲突）。
**repo 级 git 写锁**：所有 git 写操作走 `orch git --`（多 worktree 共用一个 `.git`，并发 fetch/rebase/写 ref 会打架）。只读的 status/diff/log 不加锁。

### journal（确定性强制）
```markdown
---
group: auth-refactor
task: T-3
kind: decision          # fact | decision | journal | retro | handoff | risk
files: [auth/mw.ts]
gate: pass              # orchestrator 自己填
---
Token 校验挪到 middleware。原位置每请求查两次 DB。
风险: 老 client 带 legacy header，加了兼容分支。
```
- **正文 ≤ 6 行，`orch` 硬拒收**（不是提示 —— 提示会在第 20 个 turn 被忘掉）
- 风格 **caveman lite**（去冠词去客套，技术名词原样），规则注入 role prompt
- frontmatter 结构化，正文只写「做了啥 + 为啥 + 风险」；过程在时间轴，要看去 `ctx query`
- 语种由 `output.language` 定，注入全部 agent system prompt
- **`kind: retro` 是硬要求，不写不许解散组** —— 系统唯一的长期记忆

### 通知
**立刻**：`blocker` / 命中不可代答清单 / 代答链全弃权 / 看门狗触发 / 全组 PAUSED > 15min。
**批处理**：一般 escalation，CoS 攒够 N 条或超时 T 一次给你。
**去重退避**：同一问题 5m → 15m → 1h 递增。
通道：web 收件箱 + macOS 通知；ntfy 一行配置开关。

### intent（5 种 + 正交字段）
不是 IM，所以不需要 11 种 intent —— 原来那 11 种只是**四个布尔值的命名组合**，且用不全。

| intent | 唤醒收件人 | 阻塞发送方 | 建 task | 进 note |
|---|---|---|---|---|
| `ask` | ✅ | ✅ | — | `severity=blocker` 时 ✅ |
| `request` | ✅ | — | ✅ | — |
| `inform` | ✅ | — | — | — |
| `note` | — | — | — | — |
| `decision` | — | — | — | ✅ |

**正交字段**（不是新 intent）：`severity: advisory|blocker`、`in_reply_to`（`inform` 带上即自动解阻塞）、`transfer_owner`（`request` 带上即交接）。
折叠掉的：`blocker`/`escalate` = `ask`+severity；`answer` = `inform`+in_reply_to；`handoff` = `request`+transfer_owner；`status` = `note`；`review`/`fyi` = `request`/`inform`。**role prompt 里的解释少一半。**

**唤醒原语：显式 `target`，不解析文本 `@`**
- agent 侧：`orch mail <target> --intent <i>`，收件人是参数不是文本里的符号 —— 省掉解析代码和误唤醒
- 你侧：web 上下拉选收件人
- 唤醒的真实含义就是「orchestrator 给该 agent enqueue 一个 `agent_turn` job」，没有别的魔法。不需要 speaker-selection 模型

**组的唯一对话入口是 PM**（你说一句话花一个 turn，不是五个）。拉别组只拉 **PM 代表**（`member.mode = rep`）。你可以直接指定 Engineer 为 target，标 `bypass=true` 并自动 `note` 给 PM 和相关组代表。
**问状态类提问不唤醒任何 agent** —— 黑板上已有答案，web 直接渲染。

### 组织闭环（对照真实公司补的四件事）

**① 入职包（onboarding）** —— 摸索是最贵的 token 花法。
`note(kind=onboarding)`，项目级，Librarian 维护：怎么 build / 怎么测 / 代码规范 / 已知坑 / 目录地图。**每个新 agent 第一个 turn 免费拿到**，不用自己摸。省 token 和提质量的双赢项。

**② retro → 教训清单 → 注入 role prompt（最重要的闭环）**
现在 retro 写完就是死档案。➡️ Librarian 定期把多份 retro 归纳成项目级 `note(kind=lesson)`，**注入后续组的 role prompt**。
**这是系统随时间变强的唯一机制** —— 没有它，第 20 个组和第 1 个组一样蠢。
**教训清单硬上限 ≤20 条**，Librarian 负责淘汰。否则治病的药会长成新的 context 负担。

**③ 你的重复反馈沉淀（和 ② 同一机制）**
CoS 检测你反馈里的重复模式（例如三次都说「测试写得太浅」），达阈值升级成项目规约，进教训清单。否则你的不满只产生 N 个孤立 fact，永远改不了 agent 的行为。

**④ 确定性 standup 扫描（纯 `if`，零 LLM）**
砍掉定时汇报是对的，但 standup 的真实功能是**发现重复劳动和长期卡住**：两个组在改相似路径 / 某 task 停滞超 N 小时 / 同一 gate 失败模式重复出现 → 报给 Architect 或你。

**⑤ 成本归因（F）** —— 按需求 / 切片 / 角色三个维度聚合 token 与花费（`slice.spent_tokens` + `agent` 累计，数据已有，只是没聚合）。UI 上一个「成本」面板：这个需求花了多少、哪个角色最贵、哪个难度标签最不划算。**这决定你以后怎么下需求、怎么给切片打难度标签。**

### Token 经济学（10 条硬约束，前四条是大头）

| # | 约束 | 为什么 |
|---|---|---|
| **1** | **注入的 delta（任务卡 / unread / 教训清单）必须放在最新一条 user message 末尾** | 塞进 system prompt 或历史前部会击穿整个后续 prompt cache，成本翻 3-5 倍。**硬性实现约束，不是优化建议** |
| **2** | **session 轮换与「切片」对齐**，不等 token 到 60% | 60% 时每 turn 都在读 600k 缓存，0.1x 单价但基数大。切片是天然语义边界，交接最干净 —— 顺带降低「交接 lossy」风险 |
| **3** | **QA 只看 diff + 验收标准 + gate 输出，禁止重读全库** | 单条最大节省（预估省 30-40% review 成本）。review 的信息量在 diff 里不在全库里。用 role config 的 tool 白名单硬性限制，不给无约束 Read |
| **4** | **打回重做用新 session + 结构化失败原因**，不 fork 原 session | 原 session 历史巨大且大半是失败路径。新 session 只带：验收标准 + gate 失败行 + reviewer 具体指摘 + 当前 diff |
| 5 | `orch ctx query` 返回**带 `file:line` 定位**，agent 用 offset/limit 精读 | 不整文件读 |
| 6 | `ctx query` 返回值 **token 硬上限 4k**，超了先摘要 | 否则一次吐 50k，比 agent 自己读还贵 |
| 7 | **格式化/压缩类工作全下放 haiku**（DRAFT 卡压 12 行、journal 压 6 行、log 摘要） | 让 opus/sonnet 反复自我重写是浪费 |
| 8 | **不需要推理的岗关掉 extended thinking**（Librarian / PR-watcher / 格式校验） | role config 加 thinking 档位 |
| 9 | **预算按切片而非按组** | 按组超支时已经晚了 |
| 10 | **task 级难度分派 model** —— Dispatcher 给每个切片打难度标签，简单切片用 haiku 跑 Engineer | 真公司不会让 senior 去改文案 |

### `ctx query` 的实际实现（`src/mech/ctx.ts`）
BM25 式打分：idf 让罕见词主导、饱和让重复不再加分、长度归一让 6 行的 decision 能压过 300 行的 journal，再加一点温和的时间偏好（但旧 decision 仍压过新 journal）。中文**按字**切词，否则中文笔记根本搜不到。
**无论问什么，先返回本组切片和验收标准** —— 那是切片内一切提问的框架，agent 要是得自己去找就会改成猜。预算是硬上限，被截断时明说丢了几条（静默截断读起来像「就这些了」）。
**没上 embedding**：要在 turn 内毫秒级回答、语料只是一个项目的笔记。§13 风险④说先量再上，这就是值得拿去量的基线。

### 上下文经济
Librarian（haiku）把长 event 流压成 `note` + digest，压缩过程本身进 event（你看得见它压了什么）。turn 默认只注入（且**放在消息末尾**）：任务卡 + 教训清单 + unread 摘要 + 一行「详情用 `orch ctx query` 自取」。

---

## 八、Web UI（主操作面）

**两个客户端，一套 API。** orchestrator 暴露一套 HTTP + SSE（本地 unix socket 亦可）：
- **web —— 你的主操作面**：批 DRAFT、查收切片、发话、intercept、看进展、改难度标签、审批临时 lease 命令、撤销代答、park/唤醒
- **`orch` CLI —— 主要给 AI 跑**：agent 在 turn 里通过 Bash 调用。你偶尔也能用

**任何 web 能做的操作 `orch` 都有对应子命令，反之亦然** —— UI 只是 API 的一层壳，不做第二份逻辑。

### 首页抽象：决策队列 + 每需求一条流水线（**不是看板**，实现后修正）

看板被否掉了，理由是实测的：看板的核心动作是拖卡，而老板从不拖 —— 列是系统写的，拖拽这个 affordance 是死的且误导；五列里四列都在说「不用你管」却占同等视觉重量；而且列丢掉了顺序，而一个需求是有序流水线（切片有序、闸门有序）。

替代：**上半是能清零的决策队列**（等你的东西一行一个，动作按钮在行内；空状态是「都处理完了」这个成就，看板永远半空、会训练人忽略它），**下半是每个需求一条轨道**（切片是有序的段，闸门是段内三个离散刻度）。点进去才是下面的切片泳道。见 `DESIGN.md`。

### 钻取视图：切片泳道 + 闸门进度（不是聊天流）

**「进展」的可信来源是确定性闸门和文件改动，不是 agent 说的话。** 主视图由 `slice` / `task` / `gate` 状态驱动，聊天降为侧栏。
**进度不显示百分比，显示「过了几道闸」** —— LLM 报的百分比是瞎猜，闸门是确定的。

```
 group/auth-refactor        RUNNING    owns: auth/**, mw/**     $1.24 / $5.00
 ┌─ S1 token 校验挪到 middleware  [normal]   ●self ●gate ◐QA  ○待查收
 │     engineer ▸ turn 7  改 auth/mw.ts (+31 -8)   ▐ 正在跑 lease build#12
 ├─ S2 legacy header 兼容        [trivial]  ●self ○gate ─QA  ─待查收
 ├─ S3 补 middleware 单测        [normal]   ─ ─ ─ ─         ⏸ 等 S1
 └─ S4 清理旧调用点              [trivial]  ─ ─ ─ ─         ⏸ 等 S1
 ─────────────────────────────────────────────────────────────
 ❓ engineer: 用哪个校验库？  [blocker · 等你 4m]  [回答] [转 Architect]
```

一眼能答三个问题：**整个需求走到哪 / 卡在哪道闸 / 谁在等我**。

### 其余视图
- **工位墙** —— 每个 agent：当前切片 / turn 数 / 正在跑什么工具 / 实时输出最后一行 / token / 花费 / model
- **看板** —— `DRAFT` 列（≤12 行卡片，三按钮：批准 / 改完批准 / 打回重拆；可直接改难度标签）+ `待查收` 列
- **事件流侧栏**（可折叠）—— 原来的时间轴，现在是补充不是主角
- **所有权视图** —— 各组 `owns` glob 与重叠状态（多组并行看冲突）
- **成本面板** —— 按需求 / 切片 / 角色三维归因，含每 turn 的 cache 命中率（监控 §13 风险⑧）

**实时性免费**：`--include-partial-messages` 逐 token 出流 → SSE。工位墙字段全部由 orchestrator 解析 stream-json 得到，**agent 不需额外汇报，零 token 成本**。
**叙述由 orchestrator 免费代笔**（改了哪些文件、跑了什么命令、闸门状态变化）；agent 只主动发 5 种 intent 的消息。效果是「话不多但事情清楚的团队」，不是「互相道谢的客服群」。

**主动汇报只在四个点**：**DRAFT 待批** / **切片待查收** / PR 待 merge / 命中不可代答的 escalation。加一条兜底：组 30 分钟零进展自动发 `note` 到 `#boss` 说明卡在哪。不做定时日报。

---

## 九、里程碑（范围一个不砍，分阶段可验）

### M0 — 落盘与断点续开（第一步，10 分钟）
**目的：这个 plan 本身要能跨 session / compact 存活。** 换 session 或被 compact 之后，新 session 读三个文件就能接着开发。

1. `git init` + `.gitignore` + 初始 commit
2. **`PLAN.md`** —— 把本 plan 文件原样复制进 repo，成为唯一权威设计文档。后续设计变更改这里，不改 `~/.claude/plans/`
3. **`PROGRESS.md`** —— 开发断点文件，每完成一个可验证单元就更新（不是每个文件）：
   ```markdown
   ## 当前里程碑
   M1，进行中
   ## 已完成且已验证
   - [x] sqlite schema + 迁移（test/schema.test.ts 绿）
   - [x] job 队列并发槽（test/job-queue.test.ts 绿）
   ## 进行中
   - [ ] claude adapter 的 stream-json 解析 —— 卡在 partial message 的边界处理
   ## 下一步
   - [ ] orch CLI 的 unix socket 连接
   ## 已知偏离 PLAN.md 的地方
   - （无）
   ```
4. **`CLAUDE.md`** —— 给未来 session 的项目常识：技术栈、目录约定、`bun test` 怎么跑、**「先读 PLAN.md 和 PROGRESS.md」**、caveman/ponytail 约定
5. **`docs/decisions/`** —— 开发期的设计变更记录（和系统运行期的 `note(kind=decision)` 不是一回事）

**这四个文件就是 orchestrator 系统自己的 dogfood** —— 它要给 agent 提供入职包和断点续传，那它自己的开发也该用同一套。

**开发方式**：可以用 Claude Code 的 agent teams（你 settings.json 里 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 已开）并行开发独立模块 —— schema / adapter / orch CLI / web UI 之间耦合弱，适合分头做。**但 `prompt/assemble.ts` 和 `scheduler.ts` 建议单线做**，它们是正确性的核心，并行改容易出隐蔽 bug。

### M1 — 单组端到端骨架（最重要，跑不通后面全是废设计）
`bun` 单进程 + sqlite schema + `orch` CLI + `job` 队列 + claude adapter + 一个 worktree + 三个 agent（PM/Engineer/QA）+ 最小 UI（时间轴 + 输入框 + `DRAFT` 卡 + `待查收` 列）。
**验收链**：加项目 → 在 `#boss` 丢一句话 → Dispatcher 拆 → PM 自行深挖并切片 → 落 `DRAFT` 列（≤12 行）→ **你批准** → 三 agent 干活 → `orch lease test` 跑一次 → 第一个切片过 self-review + gate + QA → 通知你查收 → 你说不满意 → 修正后再查收 → 开 PR → 你 merge → 组归档（含 retro）。

### M2 — 安全边界与两级 review
边界（原本是三份 clearance profile，`docs/decisions/005` 之后是一个组一个容器）+ 不可代答硬清单 + session 主动轮换 + repo 级 git 锁 + lease 命令模板与参数校验 + 输出三段截断 + **切片级 review**（self-review / gate / QA）+ **PR 级 review**（reconcile / Auditor）+ DRAFT 卡 ≤12 行硬校验。

### M3 — Intercept 与看门狗
三级 intercept + `wip:` checkpoint + 打断保留/回滚 + 看门狗 6 条规则 + park/唤醒 + 通知分级与退避去重 + 预算熔断。

### M4 — 组织层与反馈回路
`roles/*.yaml` 配置化 + CoS / Architect / Dispatcher / Librarian 四个常驻岗 + 代答链与弃权 + 撤销并接管 + escalation 批处理 + `ctx query` + Librarian 压缩 + **CoS 反馈分诊**（`patch` / `respec` / `reject`，`respec` 退回 Dispatcher 重新深挖）。

### M5 — 多组并行与落地
**file ownership 声明与重叠检测**（Architect 切边界，重叠禁止并行）+ 事后对账回滚越界写 + 并发槽（默认 3）+ 串行 merge queue（纯代码）+ PR-watcher（`gh` 轮询，有评论唤醒 PM）+ 打回重试计数 + 跨组拉 PM 代表 + 开工/唤醒时 rebase 到最新 main。

### M6 — 组织闭环、可观测与收尾
工位墙 + 看板 + 收件箱 + journal 流 + SSE 实时 token 流 + retro 强制 + 组解散归档 + ntfy 开关 + codex adapter
\+ **入职包**（Librarian 维护，新 agent 首 turn 免费拿）
\+ **retro → 教训清单 → 注入 role prompt**（系统随时间变强的唯一闭环）
\+ **CoS 反馈模式沉淀**（同类反馈 3 次升级为项目规约）
\+ **确定性 standup 扫描**（相似路径 / 停滞 task / 重复 gate 失败）
\+ **成本归因**（按需求/切片聚合 token 与花费）

---

## 十、目录结构

```
orchestrator/
  PLAN.md              # 本 plan 的权威副本（M0）
  PROGRESS.md          # 开发断点，换 session / compact 后从这读（M0）
  CLAUDE.md            # 给未来 session 的项目常识（M0）
  docs/decisions/      # 开发期设计变更记录
  src/
    server.ts            # bun HTTP + SSE + 静态
    db.ts                # bun:sqlite schema + 迁移
    scheduler.ts         # job 队列、并发槽、准入检查（预算）
    runtime/
      adapter.ts         # AgentAdapter 接口
      claude.ts          # claude -p 子进程 + stream-json 解析
      codex.ts           # codex exec 子进程
      # 沙盒不在 runtime/ 下：mech/sandbox.ts 是唯一知道 OpenSandbox 存在的地方
      session.ts         # session 轮换与退休
    orch/
      cli.ts             # orch 入口（文件信箱 + x-orch-token；只放通 /orch/*）
      ctx.ts lease.ts journal.ts mail.ts git.ts
    mech/
      intercept.ts watchdog.ts escalate.ts reconcile.ts gate.ts mergequeue.ts park.ts notify.ts
      sandbox.ts          # 一个组一个 OpenSandbox 容器；唯一知道它存在的文件
      mailbox.ts          # 沙盒 ↔ 宿主的文件信箱，只转发 /orch/*
      ownership.ts        # file ownership 重叠检测
      standup.ts          # 确定性扫描：相似路径 / 停滞 task / 重复 gate 失败
      lessons.ts          # retro → 教训清单 → 注入；≤20 条淘汰
      cost.ts             # 按需求/切片/角色的成本归因
    prompt/
      assemble.ts         # 唯一的 prompt 组装入口 —— delta 一律追加到消息末尾（cache 约束 #1）
    views/
      timeline.ts wall.ts board.ts
  roles/                 # 11 个 *.yaml，加岗零代码
  config/
    default.yaml         # 并发、语种、预算、resource 模板、通知
  web/
    index.html app.js style.css
  test/
```

---

## 十一、配置默认值（已确认）

| 项 | 默认 |
|---|---|
| 订阅 | Max 20x。常驻决策岗 opus，执行岗 sonnet，Librarian/PR-watcher haiku |
| 并发组 | 3（可配） |
| `output.language` | 中文（可配）。code / commit / branch / PR title+body / 错误信息**保持英文** |
| journal 正文 | ≤ 6 行硬校验，caveman lite |
| 撞限额 | **挂起等窗口重开**，到点自动继续，不用你动手。不降级：额度是账号级的，换个便宜模型不换池子，只会在你没选的时候悄悄换掉正在干活的模型 |
| session 轮换 | **切片完成时**（主）；累计 token > 该模型上下文窗口的 60%（兜底，窗口取 CLI 实报值） |
| `ctx query` 返回上限 | 4k tokens，超了先摘要 |
| 教训清单 | ≤20 条，Librarian 淘汰 |
| 反馈沉淀阈值 | 同类反馈出现 3 次 → 升级为项目规约 |
| turn 超时 | 10 min（按 role 可配） |
| park | `PAUSED` > 2h |
| `DRAFT` | **阻塞，必须你批**，无自动放行。卡片 ≤12 行硬校验 |
| `autoAdvance` | **默认开**。查收不再挡住下一片开工 —— 「批了」应该买到一夜的活。退回某一片时全组停下并说明 |
| `autoAcceptTiers` | **默认 `["trivial"]`**。四层闸（自评/对账/gate/QA）照跑，省掉的是第五层「你亲自看一眼」，只在最不值钱的那档 |
| 切片粒度 | 由 PM 定，orchestrator 只强制「每片必须可独立验收」 |
| 难度 → model | `trivial` = haiku / `normal` = sonnet / `hard` = opus（可在 DRAFT 卡上直接改） |
| 预算粒度 | 按 slice，不按组 |
| gate 重试 | 2 轮后 escalate |
| 通知退避 | 5m / 15m / 1h |
| unread 阈值 | 30 条后走 Librarian 摘要 |

---

## 十二、验证

**M0（先验证断点机制本身）**
确认 `PLAN.md` / `PROGRESS.md` / `CLAUDE.md` 三件都在且已 commit。**验证方式**：开一个全新 Claude Code session，只说「继续开发这个项目」，看它能否只靠这三个文件搞清现状并接着做 —— 搞不清就说明 `PROGRESS.md` 写得不够。

**M1（手动端到端，必须真跑一遍）**
1. `bun install`，`bun run src/server.ts`，开 `localhost:PORT`
2. 拿一个真项目（建议 `DailyExpense` 之类小的）注册进来，指向其 GitHub private remote
3. 在 `#boss` 丢一句真需求，确认 `DRAFT` 卡出现且 **≤12 行**（故意让 Dispatcher 写长一点，验证 `orch` 会拒收重写）
4. 点批准，观察时间轴逐 token 出流、工位墙 state 变化。**另试一次「打回重拆」**，确认理由进了黑板且 Dispatcher 重新深挖
4b. 第一个切片过完 self-review + gate + QA 后必须出现在 `待查收` 列并通知你；在频道说一句不满意，确认 CoS 分诊出 `patch` 并产生修正 task
5. **主动验证阻塞**：让 Engineer 撞一个必须问你的点（或手动发 `blocker`），确认全组 `RUNNING → PAUSING → PAUSED`，你答完回 `RUNNING`
6. **主动验证 lease**：`orch lease test`，确认 stdout 只有三段（exit code / 尾 200 行 / 抽取的失败行），全量日志在磁盘上
7. 确认 PR 开出来，`docs/journal/<group>/` 里有 journal + retro，正文都 ≤ 6 行
8. 你 merge，确认组归档、session 全部退休、worktree 清理

**自动化检查（每个里程碑留一个，不上框架）**
| 里程碑 | 一个 runnable check |
|---|---|
| M1 | `test/job-queue.test.ts` — 并发槽不超限、job 状态机不会卡在 running |
| M2 | `test/sandbox.test.ts` + `test/sandbox-live.test.ts` — 容器创建/重连/回收，后者对真容器跑（server 不在就跳过） |
| M2 | `test/mailbox.test.ts` — 信箱只转发 `/orch/*`，老板路由从沙盒里够不着 |
| M2 | `test/lease-args.test.ts` — 自由命令注入被 `arg_schema` 拒绝 |
| M3 | `test/intercept.test.ts` — L3 kill 后回滚到 checkpoint，工作树干净 |
| M3 | `test/watchdog.test.ts` — 连续零产出 3 turn 触发掐断 |
| M2 | `test/draft-card.test.ts` — 13 行 DRAFT 卡被拒收 |
| M2 | `test/self-review.test.ts` — self-review 只回「看起来没问题」被判无效并重跑 |
| M4 | `test/journal-validate.test.ts` — 7 行正文被拒收 |
| M5 | `test/file-ownership.test.ts` — owns 重叠的第二个组不许并行开工 |
| M2 | `test/cache-position.test.ts` — 断言注入的 delta 出现在最后一条 user message，system prompt 与历史前部逐字节未变（token 经济学 #1 的回归测试，**这条最容易在重构中被破坏**） |
| M2 | `test/qa-tools.test.ts` — QA 的 allowedTools 不含无约束 Read/Grep |
| M6 | `test/lesson-cap.test.ts` — 第 21 条 lesson 触发淘汰 |
| M5 | `test/mergequeue.test.ts` — 第二个 PR 在第一个 gate 未绿前不出队 |
| M5 | `test/reconcile.test.ts` — claim 声称改了文件但 diff 为空 → 打回 |

**冒烟脚本**：`test/smoke.sh` 起 server、注册一个空 fixture repo、跑一轮假 agent（adapter 换成 echo mock）、断言 event/job/note/task 四张表各有预期行数。

---

## 十三、已知风险（诚实记录，实测后回填）

| 风险 | 缓解 | 怎么判断它成立了 |
|---|---|---|
| **① 拆解质量决定一切** —— Dispatcher/PM 拆错，后面全白干 | DRAFT 阻塞门（≤12 行，20 秒可批）+ Architect 反对意见 + 切片交付 | 你「打回重拆」的频率 > 30%，说明深挖能力不够，考虑给 Dispatcher 更强 model 或让它先跑一个探针切片 |
| **② token 成本可能是直接对话的 5-10 倍** —— 一个 PR 背后 5-10 个 turn | 系统买的是「你不在场」；预算熔断 + model 分层 + Librarian 压缩 | 每 PR 成本 / 你自己做同一件事的成本 > 5，且你其实一直在盯着看 |
| **③ 单项目多组可能比串行慢**（Brooks 定律 AI 版） | file ownership 事先切边界 + 串行 merge queue | 组间 `respec`/打回/rebase 返工时间 > 并行省下的时间 |
| **④ `ctx query` 检索质量是隐藏瓶颈** —— plan 里最弱的一块 | Librarian 压缩 + note 结构化 + frontmatter 过滤 | agent 反复问已经在 journal 里答过的问题；此时需要上 embedding + 重排 |
| **⑤ session 轮换的交接是 lossy 的** | 轮换点对齐切片边界（最干净的交接点）+ 交接 journal + 入职包 + 教训清单 + `ctx query` 兜底 | 新 session 重复踩老 session 踩过的坑 |
| **⑧ prompt cache 被击穿而无人察觉** —— 成本翻 3-5 倍但功能正常，最隐蔽的故障 | `test/cache-position.test.ts` 回归测试 + UI 成本面板监控每 turn 的 cache 命中率 | 每 turn 成本突然上跳而 turn 内容没变 |
| **⑨ 教训清单长成新的 context 负担** —— 治病的药变成病 | ≤20 条硬上限 + Librarian 淘汰 | 每个 turn 的固定注入量持续增长 |
| **⑥ 系统自己是最大的那个项目** —— 估 8000-15000 行 + 长期调 prompt | 分 6 个里程碑，每个可独立验证 | M2 之前就开始「为了修 orchestrator 而不用 orchestrator」 |
| **⑦ review 查不了「方法很蠢」** —— gate 绿、QA 过、Auditor 盖章，三周后发现没法维护 | Auditor 审架构一致性 + retro 累积 | 同一模块被反复重写 |

**每个里程碑结束后回来更新这张表** —— 这是决定「加岗还是砍岗」的唯一依据，不靠组织图想象。

## 十四、明确不做

- 不自造权限/沙盒策略引擎（边界是容器，`orch` 是唯一接口）
- 不上 MCP、不上 sentinel JSON（用 `orch` CLI）
- 不做 speaker-selection、不解析文本里的 `@`（收件人是显式参数）
- intent 不超过 5 种（多出来的都是正交字段，不是新 intent）
- 不做两套逻辑：web 和 `orch` CLI 是同一套 API 的两个客户端
- 不做定时日报（有黑板和时间轴）
- 不做 Requirements Analyst / Security Reviewer / FinOps / Historian 岗（理由见第六节）
- Integrator / PR-watcher / Runner 不做成 agent（判断是确定性的，用 LLM 是浪费且不可靠）
- 不让同一个 agent 兼任 review（QA 和 Auditor 必须独立 session、独立 context）
- LLM review 层不查确定性层能查的东西（Auditor 不查语法和测试，那是 gate 的活）
- 不做多账号绕限额（会踩 ToS；本地单账号 + 并发上限是正当用法）
- 组内不并行写（一组一个写方，并行度靠多开组）
