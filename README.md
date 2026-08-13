# orchestrator

一人公司的 AI 员工调度系统。你丢想法，一组 AI 分工接管拆解 / 架构 / 编码 / 测试 / 审阅 / PR。

**你只做三个动作**：批 DRAFT 卡（20 秒）→ 查收切片 → merge。

```
你: "greet 加个可选语言参数，zh 返回「你好 X」"
                    ↓
  Dispatcher 读代码 + 查黑板 + 问 Architect，交一张 ≤12 行的卡
                    ↓
  ┌──────────────────────────────────────┐
  │ 目标 : ...        验收 : 2-3 条可执行 │  ← 你在这儿花 20 秒
  │ 不做 : ...        切片 : 1-5 片       │     批准 / 改完批准 / 打回重拆
  │ 风险 : ...        反对 : Architect 的 │
  └──────────────────────────────────────┘
                    ↓ 你批了
  建 branch + worktree，Engineer 干活
                    ↓ 每一片
  self-review → gate（退出码说话）→ QA（独立 session）→ 通知你查收
                    ↓ 全片查收完
  reconcile → Auditor（组外，不共享 context）→ PR → 你 merge → 组解散
```

中途你随时能插话、打断、回滚。它卡住了会通知你。

## 为什么不是「再一个 agent 框架」

因为值钱的部分是那些 `if`，不是编制：

- **拆解质量由一张阻塞你的卡兜住** —— 卡片硬性 ≤12 行，超长 `orch` 拒收。你批的是方向和验收标准，不是实现
- **一次大查收拆成多次小查收** —— 每片独立可验收，白干的单位是一片而不是整个需求
- **凡能用 `if` 拦的绝不写进 prompt** —— journal ≤6 行、切分重叠检测、file ownership、claim 对账、看门狗 6 条，全部确定性强制。提示词会在第 20 个 turn 被忘掉
- **review 两级且互相独立** —— QA 管切片，Auditor 管 PR，各自独立 session。同一个模型审自己的同类就是审批剧场
- **agent 说的话不算进展** —— 进度显示「过了几道闸」，不显示百分比。LLM 报的百分比是猜的

## 起步

```bash
bun install
bun run src/server.ts        # web 在 http://127.0.0.1:47821
```

Web 上加项目（填本地 git 仓库的绝对路径），然后在输入框丢一句需求。gate 探测、入职包、PR 预检在注册那一刻自动完成 —— 有问题当场告诉你，不会等分支做完才发现。

```bash
bun test                     # 326 checks
```

## 需要什么

| | |
|---|---|
| `bun` | 唯一运行时，无 build step |
| `claude` CLI | agent runtime（`codex` 也支持，换 role 配置即可） |
| `git` | 一组一个 branch + worktree |
| `gh` | 只有开 PR 那步要，登录后需要目标仓库的写权限 |

Claude Max 订阅够用。**不做多账号绕限额** —— 本地单账号 + 并发上限是正当用法。

## 长什么样

```
 group/auth-refactor        RUNNING    owns: auth/**, mw/**     $1.24 / $5.00
 ┌─ S1 token 校验挪到 middleware  [normal]   ●self ●gate ◐QA  ○待查收
 │     engineer ▸ turn 7  改 auth/mw.ts (+31 -8)   ▐ 正在跑 lease build#12
 ├─ S2 legacy header 兼容        [trivial]  ●self ○gate ─QA  ─待查收
 └─ S3 补 middleware 单测        [normal]   ─ ─ ─ ─         ⏸ 等 S1
 ─────────────────────────────────────────────────────────────
 ❓ engineer: 用哪个校验库？  [blocker · 等你 4m]  [回答] [转 Architect]
```

一眼三个问题：整个需求走到哪 / 卡在哪道闸 / 谁在等我。

## 结构

```
src/
  server.ts scheduler.ts db.ts api.ts bus.ts
  prompt/assemble.ts     # 唯一的 prompt 组装入口（cache 约束在这儿）
  runtime/               # claude / codex 子进程 + 执行器
  mech/                  # 那些 if：validate lease clearance gate reconcile
                         # review ownership mergequeue watchdog intercept …
  orch/cli.ts            # agent 的唯一出口
roles/*.yaml             # 8 个角色，加岗零代码
web/index.html           # 单文件，无框架无 build
```

设计文档是 `PLAN.md`，当前状态和**所有实测踩过的坑**在 `PROGRESS.md`，改代码前先读 `CLAUDE.md`。

## 三条硬约束

违反其中任何一条都会得到「功能正常但系统变蠢或变贵」的结果：

1. **注入的 delta 一律追加到最新一条 user message 末尾**。塞进 system prompt 会击穿 prompt cache，成本翻 3-5 倍而功能完全正常 —— 最隐蔽的故障
2. **`orch lease` 永不接受自由命令**。Runner 跑在 host 上有真权限，这是沙盒唯一的缺口
3. **`if` 和 prompt 说的话必须一致**。prompt 给的许可如果校验器不认，就是在教模型撒谎

第四条是「凡能用 `if` 拦的绝不写进 prompt」（见上）。四条各自的实测反例在 `CLAUDE.md` 和 `PROGRESS.md` 里。
