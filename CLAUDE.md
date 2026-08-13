# orchestrator

一人公司 AI 员工调度系统。老板丢想法，AI 分组接管拆解/架构/编码/测试/审阅/PR，老板只批 DRAFT、查收切片、merge。

## 开工前先读（顺序固定）

1. **`PROGRESS.md`** —— 当前做到哪、下一步是什么、有没有偏离设计
2. **`PLAN.md`** —— 权威设计文档。**设计变更改这里**，不改 `~/.claude/plans/`
3. `docs/decisions/` —— 开发期的设计变更记录（和系统运行期的 `note(kind=decision)` 不是一回事）

**每完成一个可验证单元就更新 `PROGRESS.md`**（有 check 变绿，或手动走通一步），不是每改一个文件。

## 技术栈

- **bun + TypeScript**，单进程：HTTP + SSE + `bun:sqlite` + 子进程管理
- **web = React + Tailwind v4 + shadcn/ui**（Radix 行为层），`bun run build:web` 出 `web/dist`。视觉语言是自己的（见 `DESIGN.md`），shadcn 只负责行为：焦点陷阱、Esc、aria、菜单、toast。手写过一遍，不值得
- **页面仍然不 fetch 任何外部资源** —— 字体用本机已有的，脚本样式只从 `web/dist` 出，`test/smoke.test.ts` 守着
- agent runtime = **CLI 子进程**（`claude -p` / `codex exec`），不用 Agent SDK
- agent ↔ orchestrator = **`orch` CLI over Bash**，不用 MCP、不用 sentinel JSON
- 沙盒 = **Claude Code 内置 Seatbelt**（`sandbox` / `denyRead` / `denyWrite` / `autoAllowBashIfSandboxed`），不自造策略引擎

## 命令

```bash
bun install
bun run src/server.ts        # 起 orchestrator
bun test                     # 全部 check
bun test test/xxx.test.ts     # 单个
```

## 四个一等公民（改代码前必须清楚）

| 实体 | 是什么 |
|---|---|
| `job` | 一切**将要**发生的事 + 唯一调度器。intercept / park / 预算熔断都是它的用法 |
| `event` | 一切**已经**发生的事，append-only |
| `note` | 黑板静态部分（fact / decision / journal / retro / onboarding / lesson） |
| `task` / `slice` | 工作单元 + 状态机；`slice` 是可独立验收的交付单元 |

**没有 mail 表**（合入 `event`）。**没有独立的 group 实体**（= task 子树 + branch + worktree + roster + 预算）。

## 不许违反的硬约束

1. **注入的 delta 一律追加到最新一条 user message 末尾。** 塞进 system prompt 或历史前部会击穿 prompt cache，成本翻 3-5 倍且功能完全正常 —— 最隐蔽的故障。所有 prompt 组装必须走 `src/prompt/assemble.ts`，回归测试是 `test/cache-position.test.ts`。
2. **`orch lease` 永不接受自由命令。** 资源是 `resource` 表里预定义的模板，agent 只能选资源名 + 传经 `arg_schema` 校验的参数。Runner 跑在 host 上有真权限，这是沙盒的唯一缺口。
3. **凡能用 `if` 拦的，绝不写进 prompt 求 agent 自觉。** journal ≤6 行、DRAFT 卡 ≤12 行、clearance、看门狗、file ownership、对账 —— 全部确定性强制。提示词会在第 20 个 turn 被忘掉。
4. **组件行为不许自己造。** dialog / menu / toast / 命令面板 一律用 shadcn（Radix + cmdk + sonner）。手写过一遍 confirm、toast、下拉，结果是没有焦点陷阱、Esc 不响应、aria 全缺 —— 视觉语言是我们的（`DESIGN.md`），行为不是我们该发明的。加组件先看 shadcn 有没有。
5. **要老板做的决定必须把证据摆在按钮旁边。** 查收给 diff + QA 判词 + 闸门日志；不可逆动作（确认已合入）先让服务端向 GitHub 核对；被卡住的状态（预算烧穿、退回的 DRAFT、代答）必须有出路按钮。只给标题就让人批 = 橡皮图章，前面三道闸白跑。
6. **`if` 和 prompt 说的话必须一致，不一致时模型听 `if`。** 改校验器时同步改对应的 role prompt，反过来也一样。实测：dispatcher prompt 写着「真的不可分就交一片，凑三片更糟」，而校验器拒收 1-2 片 —— 模型只能凑，还把凑出来的切片当风险写在自己卡上。**prompt 给的许可如果校验器不认，就是在教模型撒谎。**
7. **每个状态都必须有人推。** 加状态 = 在 `src/mech/invariants.ts` 加一行：什么必须成立 / 谁推它出去（`driver`）/ 需要的话一个幂等 repair。`src/mech/states.ts` 是唯一的状态清单，`test/invariants.test.ts` 断言两者对齐 —— 加了状态不填表，`bun test` 直接红。

   为什么：**每一条 watchdog 规则都是一次事故换来的，而它们形状完全一样** —— 某个转移只有一条代码路径会触发，那条路径没跑，状态就永久停住，而且**看起来是健康的**（组 RUNNING、有 agent、哪儿都没报错）。实测过的：六个组卡在过期基线上；六个组卡在一个 `--settings` 路径 bug 上；一个组每片都查收了却没人把分支交出去；一个 PAUSED 却没有 `paused_at` 的组对所有定时器隐形。表把「又发现一个」变成「表里有个空格」。

   **表里只放活性（liveness）：谁推。** 健康检查（turn 超时、原地打转、预算、env_suspect）留在 `watchdog.ts` —— 那是「它还好吗」，不是「有没有人在推它」。两者混在一起，任何一边都会变成垃圾堆。

## 代码风格

- **ponytail**：先问「这需要存在吗」，然后 stdlib / 已有依赖 / 一行 / 最小实现。不加只有一个实现的接口，不为「以后」搭脚手架。deliberate 的取巧用 `ponytail:` 注释标注天花板和升级路径。
- **caveman lite**：注释和文档去冠词去客套。代码、commit message、PR、错误信息**用英文**。
- 非平凡逻辑留一条 runnable check（`bun test`，不上框架、不写 fixture 地狱）。

## 运行期产物的语言

`output.language` 配置（默认中文）管 journal / 频道消息 / 问老板的问题 / 状态摘要。
code / commit message / branch 名 / PR title+body / 错误信息**永远英文**。
