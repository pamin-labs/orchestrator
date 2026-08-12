# PROGRESS

开发断点文件。换 session 或被 compact 之后，读 `CLAUDE.md` → 这个文件 → `PLAN.md` 就能接着做。

**更新时机**：每完成一个**可验证单元**就更新（不是每改一个文件）。可验证 = 有一条 runnable check 变绿，或手动端到端走通一步。

---

## 当前里程碑

**M3 — Intercept 与看门狗**（未开始）

## 已完成且已验证

### M0 — 落盘与断点续开 ✅
`git init` / `PLAN.md`（权威设计文档，**改这里不改 `~/.claude/plans/`**）/ `PROGRESS.md` / `CLAUDE.md` / `docs/decisions/`。
待你做的验收：开一个**全新** session 只说「继续开发这个项目」，看它能否只靠这三个文件接上。

### M1 — 单组端到端骨架 ✅（133 checks 绿 + live 跑通）

| 模块 | 文件 | check |
|---|---|---|
| schema + 迁移（3 个） | `src/db.ts` | `test/schema.test.ts` |
| job 队列 / 并发槽 / 准入 | `src/scheduler.ts` | `test/job-queue.test.ts` |
| prompt 组装（cache 唯一防线） | `src/prompt/assemble.ts` | `test/cache-position.test.ts` |
| `claude -p` adapter | `src/runtime/claude.ts` | `test/claude-adapter.test.ts` |
| 硬校验（journal / DRAFT / self-review） | `src/mech/validate.ts` | `test/journal-validate.test.ts` `test/draft-card.test.ts` |
| lease 模板 + 三段截断 | `src/mech/lease.ts` | `test/lease-args.test.ts` |
| clearance profile（按组生成） | `src/mech/clearance.ts` | `test/clearance.test.ts` + `test/sandbox-probe.sh`（live） |
| worktree / repo 锁 / checkpoint | `src/mech/worktree.ts` `src/mech/gitlock.ts` | `test/worktree.test.ts`（真 git） |
| API（web + orch 共用） | `src/api.ts` `src/bus.ts` | `test/api.test.ts` |
| turn / lease 执行器 | `src/runtime/executor.ts` | `test/executor.test.ts` |
| roles / config | `src/config.ts` `roles/*.yaml` | `test/config.test.ts` |
| server + web UI | `src/server.ts` `web/index.html` | `test/smoke.test.ts` |
| `orch` CLI | `src/orch/cli.ts` | `test/orch-cli.test.ts` |

**live 端到端已跑通**（真 `claude -p`，haiku）：丢想法 → 建 DRAFT → 批准 → 建 worktree+branch → 雇 engineer → 沙盒内 agent 经 **localhost TCP 调到 `orch`**（`task claim` / `journal add` / `task done`）→ journal 校验通过并导出 `docs/journal/<group>/` → 文件写对 → 成本记账。

## 实测得到的、和原设计不同的事实

两份决策记录，都是**实跑测出来的**，别凭直觉改回去：

- **`docs/decisions/001`** —— 沙盒只有 deny 语义（`allowWrite` 无法在 `denyWrite` 里开口子）；不加 `denyWrite` 时写 cwd 之外是允许的；`allowUnixSockets` 无效；`allowAllUnixSockets: true` 会连带打开 `/var/run/docker.sock`（一行逃逸）；`excludedCommands` 会让**整条命令行**脱离沙盒。结论：**localhost TCP + 每 agent token**，`failIfUnavailable: true` 必须开（每种配错都是静默失效）。
- **`docs/decisions/002`** —— `--allowedTools` 只管权限，不裁 tool 定义。加上 `--tools` + `--disable-slash-commands` + `--setting-sources project,local` 后，同一任务前缀 46k → 17.6k tokens、成本 $0.117 → $0.059。

### M2 — 安全边界与两级 review ✅（163 checks 绿）

| 机制 | 文件 | 要点 |
|---|---|---|
| 切片级 review | `src/mech/review.ts` | `self-review`（写方 turn 内）→ `reconcile` → `gate` → `QA` → 你查收。两层确定性在前，别让模型去判断「声称是假的」或「测试都编译不过」的活 |
| deterministic gate | `src/mech/gate.ts` | 项目 config 里声明 gate 资源名；**没配 gate 算失败不算放行**；第一个失败就停 |
| 对账 | `src/mech/reconcile.ts` | 按 **slice.base_sha** 比，不按 branch 比（否则第二个切片继承前面的 diff，检查就没意义了） |
| QA 判决 | `orch review <slice> --verdict pass\|fail` | 判决是**值不是散文** —— 把 fail 读成 pass 正是这套流水线要防的那个错 |
| 打回 | `sendBack()` | 一律开新 session，只带验收标准 + 失败行 + 当前 diff；超 `gateRetries` 升级为 blocker 并说明「大概率是验收标准写错了，不是代码」 |
| session 轮换 | `handToBoss()` | **主触发是切片完成**（最便宜的交接点），token 上限只是兜底 |
| PR 级 review | `runPrReview()` + `roles/auditor.yaml` | 你验收完最后一个切片才启动（agent 触发不了）；**没写 retro 不许收尾**；Auditor 在所有开发组之外，组检查是反的 |
| 不可代答（git 那几条） | `reservedGitAction()` | push / merge / force / hard reset 全拒，且拒绝会发成 escalation —— 撞了静默的墙，agent 会去找绕路 |

## 下一步（M3，按依赖排）

1. [ ] **`src/mech/intercept.ts`** —— 三级：插队（入 event）/ 栅栏（停派发，等在飞 turn）/ 硬打断（kill `job.pid`）。硬打断两个按钮：**保留**（脏改动留着，下个 turn 告知）和**回滚**（`rollbackTo` 已经有了）。
2. [ ] **`src/mech/watchdog.ts`** —— 6 条确定性规则（turn 超时 / 连续 3 turn 零写入 / 5 turn 反复改同一文件 / 同一 lease 连续 2 次失败且 diff 未变 → `env_suspect` / 预算 80%·100% / `PAUSED` 超时 → park）。用 `watchdog` job 定期跑，它已经绕过组并发槽（否则永远轮不到卡住的那个组）。
3. [ ] **`src/mech/notify.ts`** —— 立刻 / 批处理两档 + 5m→15m→1h 递增退避去重；macOS 通知走 `osascript`，ntfy 一行配置。
4. [ ] **park / 唤醒** —— 撤销 pending job + 退休 session + 释放槽；唤醒时 `rebaseOntoBase`。
5. [ ] web 上加「暂停 / 打断并保留 / 打断并回滚」三个按钮（现在只有暂停/继续/封存）。

## 已知偏离 PLAN.md 的地方

- `grp` 无 `channel_id`（`channel.grp_id` 是唯一那条边）；`grp` 增加 `owns_json` / `spent_usd`
- `agent` 增加 `token`（迁移 002）和 `stable_hash`（迁移 003）
- `slice` 增加 `gates_json` / `depends_on`；`job` 增加 `slice_id`
- 传输层从 unix socket 改成 localhost TCP（决策 001）
- `profiles/` 不是静态文件，按组生成
- **intent 只有 5 种**（`ask`/`request`/`inform`/`note`/`decision` + 正交字段），PLAN 早期版本写的 11 种已折叠

## 卡住的地方 / 待决策

- **前缀现在的大头是 role prompt + 入职包 + 教训清单**（17.6k）。教训清单上限 20 条是 M6 的事，但如果 M2 里 prompt 继续长，先量一下再加内容。
- `activity` 偶尔显示成裸 `Bash`：`stream_event` 的 `content_block_start` 早于 input 到齐。要更好的工位墙文案就从 `assistant` 消息里取，不从 partial 取。
