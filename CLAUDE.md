# orchestrator

一人公司 AI 员工调度系统。老板丢想法，AI 分组接管拆解/架构/编码/测试/审阅/PR，老板只批 DRAFT、查收切片、merge。

## 开工前先读（顺序固定）

1. **`PROGRESS.md`** —— 当前做到哪、下一步是什么、有没有偏离设计
2. **`PLAN.md`** —— 权威设计文档。**设计变更改这里**，不改 `~/.claude/plans/`
3. `docs/decisions/` —— 开发期的设计变更记录（和系统运行期的 `note(kind=decision)` 不是一回事）

**每完成一个可验证单元就更新 `PROGRESS.md`**（有 check 变绿，或手动走通一步），不是每改一个文件。

## 技术栈

- **bun + TypeScript**，单进程：HTTP + SSE + `bun:sqlite` + 子进程管理
- **无前端框架、无 build step** —— `web/` 是手写 HTML + vanilla JS + SSE
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

## 三条不许违反的硬约束

1. **注入的 delta 一律追加到最新一条 user message 末尾。** 塞进 system prompt 或历史前部会击穿 prompt cache，成本翻 3-5 倍且功能完全正常 —— 最隐蔽的故障。所有 prompt 组装必须走 `src/prompt/assemble.ts`，回归测试是 `test/cache-position.test.ts`。
2. **`orch lease` 永不接受自由命令。** 资源是 `resource` 表里预定义的模板，agent 只能选资源名 + 传经 `arg_schema` 校验的参数。Runner 跑在 host 上有真权限，这是沙盒的唯一缺口。
3. **凡能用 `if` 拦的，绝不写进 prompt 求 agent 自觉。** journal ≤6 行、DRAFT 卡 ≤12 行、clearance、看门狗、file ownership、对账 —— 全部确定性强制。提示词会在第 20 个 turn 被忘掉。

## 代码风格

- **ponytail**：先问「这需要存在吗」，然后 stdlib / 已有依赖 / 一行 / 最小实现。不加只有一个实现的接口，不为「以后」搭脚手架。deliberate 的取巧用 `ponytail:` 注释标注天花板和升级路径。
- **caveman lite**：注释和文档去冠词去客套。代码、commit message、PR、错误信息**用英文**。
- 非平凡逻辑留一条 runnable check（`bun test`，不上框架、不写 fixture 地狱）。

## 运行期产物的语言

`output.language` 配置（默认中文）管 journal / 频道消息 / 问老板的问题 / 状态摘要。
code / commit message / branch 名 / PR title+body / 错误信息**永远英文**。
