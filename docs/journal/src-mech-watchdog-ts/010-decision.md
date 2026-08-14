---
group: src-mech-watchdog-ts
role: architect
slice: null
kind: decision
files: []
---
第九次退回：这次 main 真动了（main=origin/main=fb20f2d，本分支 1 落后 / 10 领先，merge-base 不再是 main），但判定仍是切片不改、边界不重切、不丢弃。
冲突为零且可证：新 main 那一笔 fb20f2d 只碰 config/default.yaml、src/api.ts、src/config.ts、test/{config,panel-text}.test.ts、web/{lib/attach.ts,ui/attachments.tsx,ui/composer.tsx,views/{evidence,notes,requirement}.tsx}，与本片两个文件零重叠；`git merge-tree` 无 "changed in both"、无冲突标记。
S1 前提在新 main 上复核仍成立：main:src/mech/watchdog.ts:625 照旧硬编码 `orch git -- rebase origin/main`，main 的 test/watchdog.test.ts 全文无 "checks defaultBase" —— 真交付，不作废。
注意别用两点 diff 判本组改动：`git diff main HEAD` 会把 fb20f2d 的 api.ts -110、attachments.tsx -95 印成本组在删 main 的活，是幻影；本组净改动只有 watchdog.ts 16 行 + watchdog.test.ts 44 行 + 本组 journal。
rebase 必须走 `orch git -- rebase main`（沙盒内直接 git 写对象一律 Operation not permitted），main 与 origin/main 此刻同为 fb20f2d，一次即过。
rebase 后只剩收尾：跑闸门 → 开 PR → 进合入队列。规则8 那个 conflict 标记不清的老问题仍在（main:watchdog.ts:423-436），不并进本卡。
