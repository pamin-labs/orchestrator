# PROGRESS

开发断点文件。换 session 或被 compact 之后，读 `CLAUDE.md` → 这个文件 → `PLAN.md` 就能接着做。

**更新时机**：每完成一个**可验证单元**就更新（不是每改一个文件）。可验证 = 有一条 runnable check 变绿，或手动端到端走通一步。

---

## 当前里程碑

**M0 — 落盘与断点续开**（进行中）

## 已完成且已验证

- [x] `git init`（main 分支）+ 目录骨架 `src/ test/ docs/decisions/`
- [x] `PLAN.md` —— plan 的权威副本已进 repo。**后续设计变更改这里，不改 `~/.claude/plans/`**
- [x] `PROGRESS.md` —— 本文件
- [x] `CLAUDE.md` —— 给未来 session 的项目常识
- [x] `.gitignore`

## 进行中

- [ ] M0 验收：开一个**全新** Claude Code session，只说「继续开发这个项目」，看它能否只靠 `CLAUDE.md` + 本文件 + `PLAN.md` 搞清现状并接着做。搞不清 = 本文件写得不够。

## 下一步（M1 顺序）

按依赖排，前三条互不耦合，可用 agent teams 并行：

1. [ ] `src/db.ts` —— sqlite schema + 迁移（表见 `PLAN.md` §3）→ `test/schema.test.ts`
2. [ ] `src/scheduler.ts` —— job 队列、并发槽、准入检查 → `test/job-queue.test.ts`
   **单线做，不并行** —— 正确性核心
3. [ ] `src/runtime/claude.ts` —— `claude -p` 子进程 + stream-json 解析（含 partial message 边界）
4. [ ] `src/prompt/assemble.ts` —— **唯一** prompt 组装入口，delta 一律追加到消息末尾 → `test/cache-position.test.ts`
   **单线做，不并行** —— 写错了功能正常但成本翻 3-5 倍，最隐蔽的故障
5. [ ] `src/orch/cli.ts` —— unix socket 连 server；先实现 `ask-boss` / `lease` / `journal add` / `task`
6. [ ] `src/server.ts` + `web/` —— HTTP + SSE + 切片泳道主视图 + DRAFT 卡 + 待查收列
7. [ ] `roles/` 三个 yaml（PM / Engineer / QA）+ `profiles/L1.json` `L2.json`
8. [ ] M1 端到端手动验收（步骤见 `PLAN.md` §12）

## 已知偏离 PLAN.md 的地方

（无）

## 卡住的地方 / 待决策

（无）
