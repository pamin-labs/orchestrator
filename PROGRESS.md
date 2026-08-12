# PROGRESS

开发断点文件。换 session 或被 compact 之后，读 `CLAUDE.md` → 这个文件 → `PLAN.md` 就能接着做。

**更新时机**：每完成一个**可验证单元**就更新（不是每改一个文件）。可验证 = 有一条 runnable check 变绿，或手动端到端走通一步。

---

## 当前里程碑

**M1 — 单组端到端骨架**（进行中）

## 已完成且已验证

**M0**
- [x] `git init`（main 分支）+ 目录骨架
- [x] `PLAN.md` —— plan 的权威副本。**设计变更改这里，不改 `~/.claude/plans/`**
- [x] `PROGRESS.md` / `CLAUDE.md` / `.gitignore` / `docs/decisions/README.md`
- [ ] M0 验收待做：开一个**全新** session 只说「继续开发这个项目」，看它能否只靠这三个文件接上

**M1**
- [x] `package.json` + `tsconfig.json`（bun，无 build step）
- [x] `src/db.ts` —— 全 schema + 迁移 → `test/schema.test.ts` 5 绿
- [x] `src/scheduler.ts` —— job 队列、并发槽、准入检查 → `test/job-queue.test.ts` 9 绿
- [x] `src/prompt/assemble.ts` —— 唯一 prompt 组装入口 → `test/cache-position.test.ts` 9 绿
- [x] `src/runtime/claude.ts` —— `claude -p` + stream-json → `test/claude-adapter.test.ts` 7 绿

**实跑确认过的 stream-json 字段**（不是猜的）：`permission_denials`、`rate_limit_info{status,rateLimitType,resetsAt,isUsingOverage}`、`modelUsage[*].contextWindow`、`usage.cache_read_input_tokens`、`user.tool_use_result{stdout,stderr,interrupted}`。事件类型：`system(init|status|thinking_tokens|hook_*)` / `stream_event(content_block_*|message_*)` / `assistant` / `user` / `rate_limit_event` / `result`。

## 进行中

- [ ] `src/mech/validate.ts` —— journal ≤6 行、DRAFT 卡 ≤12 行的硬拒收

## 下一步

1. [ ] `src/mech/lease.ts` —— 资源模板解析 + 参数校验（**永不接受自由命令**）+ 结果三段截断
2. [ ] `src/server.ts` —— HTTP + SSE + unix socket；路由即 API，web 和 orch 共用
3. [ ] `src/orch/cli.ts` —— socket 客户端：`ctx query` / `ask-boss` / `lease` / `mail` / `journal add` / `task` / `status` / `git`
4. [ ] `roles/{pm,engineer,qa}.yaml` + `profiles/{L1,L2}.json`
5. [ ] `web/` —— 切片泳道主视图 + DRAFT 卡 + 待查收列 + SSE
6. [ ] M1 端到端手动验收（步骤见 `PLAN.md` §12）

## 已知偏离 PLAN.md 的地方

- `job` 表加了 `slice_id`（PLAN §3 没写）—— 预算按 slice 检查需要它
- `grp` 表加了 `owns_json` / `spent_usd`，`agent` 加了 `total_tokens`/`total_usd` —— file ownership 和成本归因需要
- `slice` 加了 `gates_json`（四层 review 的通过状态）和 `depends_on`

## 卡住的地方 / 待决策

（无）
