# PROGRESS

开发断点文件。换 session 或被 compact 之后，读 `CLAUDE.md` → 这个文件 → `PLAN.md` 就能接着做。

**更新时机**：每完成一个**可验证单元**就更新（不是每改一个文件）。可验证 = 有一条 runnable check 变绿，或手动端到端走通一步。

---

## 当前状态

**M0–M6 全部落地，237 checks 绿，live 端到端跑通。**
`bun test` 全绿；`bun run src/server.ts` 起服务，web 在 `http://127.0.0.1:47821`。

剩下的都是「用起来之后才知道要不要做」的，见最后两节。

## live 验证过什么（真 `claude -p`，不是 mock）

丢想法 → Dispatcher 拆 → 你批 DRAFT → 建 worktree+branch → 建 task → 雇 engineer（haiku，因为切片标了 `trivial`）→ 沙盒内 agent 经 **localhost TCP 调到 `orch`**（`task list` / `task claim` / `journal add` / `task done`）→ **reconcile pass → gate pass → QA pass** → `awaiting_boss`。
journal 是中文、导出到 `docs/journal/<group>/`，成本记账到 agent / slice / group 三层。
**整片含独立 review 共 $0.055**（engineer $0.019 + qa $0.036）。

## 里程碑

| | 内容 | 关键文件 |
|---|---|---|
| **M0** ✅ | 落盘与断点续开 | `PLAN.md` `PROGRESS.md` `CLAUDE.md` `docs/decisions/` |
| **M1** ✅ | 单组端到端骨架 | `db.ts` `scheduler.ts` `prompt/assemble.ts` `runtime/claude.ts` `api.ts` `bus.ts` `server.ts` `orch/cli.ts` `web/index.html` |
| **M2** ✅ | 安全边界 + 两级 review | `mech/{validate,lease,clearance,gate,reconcile,review,worktree,gitlock}.ts` |
| **M3** ✅ | 三级 intercept + 看门狗 6 条 + 通知 | `mech/{intercept,watchdog,notify}.ts` |
| **M4** ✅ | 代答链 + 撤销接管 + 反馈分诊 | `mech/chain.ts` + `roles/{cos,architect,librarian}.yaml` |
| **M5** ✅ | file ownership + 串行 merge queue + PR-watcher | `mech/{ownership,mergequeue,prwatch}.ts` |
| **M6** ✅ | standup 扫描 + 成本归因 + codex adapter + 归档 | `mech/{standup,cost}.ts` `runtime/codex.ts` |

8 个 role 全在 `roles/*.yaml`（dispatcher / pm / engineer / qa / auditor / cos / architect / librarian）。加岗仍是零代码 —— `test/config.test.ts` 用一个临时 `composer.yaml` 断言这一点。

## 实测得到的、和直觉相反的事实（**别凭直觉改回去**）

- **`docs/decisions/001` 沙盒**：只有 deny 语义（`allowWrite` 无法在 `denyWrite` 里开口子）；不加 `denyWrite` 时写 cwd 之外是**允许**的；`allowUnixSockets` 无效；`allowAllUnixSockets: true` 会连带打开 `/var/run/docker.sock`（一行逃逸）；`excludedCommands` 会让**整条命令行**脱离沙盒（`orch && 越界写` 实测成功）。→ **localhost TCP + 每 agent token**，`failIfUnavailable: true` 必开，因为每种配错都是**静默**失效。
- **`docs/decisions/002` 前缀**：`--allowedTools` 只管权限、不裁 tool 定义。加 `--tools` + `--disable-slash-commands` + `--setting-sources project,local` 后前缀 46k → 17.6k tokens、成本 $0.117 → $0.059。
- **reconcile 要比工作树，不能比 `sha..HEAD`**：它在 `task done` 那一刻就跑，那轮改动还没 commit。比 commit 会让**每一次首次尝试**都假失败，而且第二次「通过」只是因为下一轮 checkpoint 顺手提交了上一轮的活。
- **批准 DRAFT 必须同时建 task**：没东西可 claim，写方会自己编一个 id（实测它把 task 标题当 id 传了），于是 `task done` 永不落地、整条 review 流水线**静默不触发**。
- **`orch task list` 不能返回 JSON 数组**：那等于邀请 agent 把 title 当 id 用。返回 `id status slice owner title` 的行。
- **`git -C <path> rebase` 会绕过 repo 写锁**：`isWrite` 跳过 flag 时必须连它的值一起跳，否则值被当成子命令。
- **`staticPrefix` 对无通配符路径不能回退到目录**：`package.json` 会变成空前缀，而空前缀「与全仓库重叠」。
- **`\b其实\b` 永不匹配**：汉字之间没有 word boundary，中文 filler 规则全是死的。
- **PR 的失败 check 只能在状态变化时报**：否则同一条红 check 每 30 秒唤醒 PM 一次。

## 用之前你要做的三件事

1. **项目要配 gate**，否则每个切片都会以「没配 gate」失败 —— 这是故意的：没有确定性底座，上面的 LLM review 就是空的。
   `UPDATE project SET config_json = '{"gates":["test"]}'`，并往 `resource` 表插一条同名命令模板。
2. **多组并行前让 Architect 切 `owns_json`**。单组不用（没有可碰撞的对象）。
3. **M0 那条验收还没做**：开一个全新 session 只说「继续开发这个项目」，看它能否只靠 `CLAUDE.md` + 本文件 + `PLAN.md` 接上。接不上就说明本文件写得不够。

## 剩下的（都不阻塞使用）

1. [ ] **`ctx query` 还是关键词计分 + 4k 硬上限**。`PLAN.md` §13 风险④说这是最弱的一块。**先量「agent 反复问已经答过的问题」的频率**再决定要不要上 embedding —— 现在上等于凭感觉优化。
2. [ ] **CoS 的 escalation 聚合**只在它的 prompt 里，没有代码兜底（`Notifier` 的 batched 档已经能用）。
3. [ ] **入职包只在 Librarian 被触发时才写**，所以第一个组开工那次仍要自己摸索仓库。
4. [ ] **`denyOutsideOwns` 只到 worktree 顶层**（代码里标了 `ponytail:`）。owned 目录内部的越界写靠 reconcile 和 diff review 兜。
5. [ ] **codex adapter 只在 fixture 上验过**，没跑过真 codex 成功路径（探针那次账号不支持我指定的 model）。
6. [ ] **PR 流程没在真 remote 上跑过** —— `openPr` / `pollPrs` 的单测用注入的 gh runner。第一次真用大概会撞 `gh` 认证或缺 remote，那时会以 escalation 形式报出来。
7. [ ] 工位墙偶尔显示裸 `Bash`：`stream_event` 的 `content_block_start` 早于 input 到齐。要更好的文案就从 `assistant` 消息取，不从 partial 取。

## 已知偏离 PLAN.md

- `grp` 无 `channel_id`（`channel.grp_id` 是唯一那条边）；增加 `owns_json` / `spent_usd` / `paused_at` / `merge_seq` / `pr_number` / `pr_seen_at` / `pr_checks_sig`
- `agent` 增加 `token` / `stable_hash` / `idle_turns` / `loop_file` / `loop_count`
- `slice` 增加 `gates_json` / `depends_on` / `base_sha` / `retries`；`job` 增加 `slice_id` / `checkpoint_sha`；`lease` 增加 `head_sha`
- 传输层从 unix socket 改成 **localhost TCP**（决策 001）
- `profiles/` 不是静态文件，按组生成
- **intent 只有 5 种**（`ask`/`request`/`inform`/`note`/`decision` + 正交字段）
- 迁移共 8 条，全部 append-only
