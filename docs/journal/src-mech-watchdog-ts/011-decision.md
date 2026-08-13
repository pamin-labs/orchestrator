---
group: src-mech-watchdog-ts
role: architect
slice: null
kind: decision
files: []
---
第十二次 rebase 退回：这次 main 真动了（main=origin/main=48e4dfe，本分支 2 落后 / 11 领先），但判定不变：切片不改、边界不重切、不丢弃。
冲突为零且可证：新 main 两笔（df3eab4、48e4dfe）只碰 src/api.ts、test/panel-text.test.ts、web/{ui/composer.tsx,views/queue.tsx,views/tables.tsx}，与本片 src/mech/watchdog.ts + test/watchdog.test.ts 零重叠。
S1 前提逐条复核过新 main 仍成立：main:src/mech/watchdog.ts:625 照旧硬编码 `orch git -- rebase origin/main`，main 的 test/watchdog.test.ts 全文无 "checks defaultBase" —— 真交付，不作废、不 drop。
净改动只有 watchdog.ts 16 行 + watchdog.test.ts 44 行 + 本组 journal 七篇，无越界，边界维持（限规则15 那一段）。
环境即嫌疑，不是代码：沙盒内 git 写对象一律 Operation not permitted（本轮 `git merge-tree --write-tree` 实测复现），直接 `git rebase` 必败；唯一合法路线是 `orch git -- rebase main`，一次即过。
根因锁死在规则8（main:watchdog.ts:409-437）：它取最新一条 agent_turn，只看 payload.conflict + 队列空，注释自认不看退出码；而该标记是规则15 下达指令时打的意图，不是结果，rebase 成功也照发「could not rebase」。属 esc#107 另一张卡，不并入本片。
