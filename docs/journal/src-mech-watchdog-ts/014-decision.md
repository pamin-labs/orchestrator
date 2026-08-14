---
group: src-mech-watchdog-ts
role: architect
slice: null
kind: decision
files: []
---
第十四次 rebase 退回：这次 main 真动了（origin/main=main=8bb20d2，4 落后/13 领先，非 HEAD 祖先），但判定不变：切片不改、边界不重切、不丢弃。
冲突为零且文件级可证：新 main 四笔只碰 src/api.ts 与 web/** 十一个 tsx（composer/picker/tables/requirement 等），本片只有 src/mech/watchdog.ts + test/watchdog.test.ts + 本组 journal，交集为空。
S1 前提逐条复核过 8bb20d2 仍成立：main:watchdog.ts:625 照旧硬编码 `fetch origin main`/`rebase origin/main`，main 的 test/watchdog.test.ts 全文无 "checks defaultBase"（grep 计数 0）——真交付，不 drop。
边界维持不重切：owns 限 watchdog.ts 规则15 那一段 + test/watchdog.test.ts；main 这四笔全在 web/api 面，不碰本组任何前提。
本轮必须真 rebase 不是空转：只走 `orch git -- fetch origin main` 再 `orch git -- rebase origin/main`。沙盒内 git 写对象一律被拒（本轮实测 `git hash-object -w` → Operation not permitted），直接 `git rebase` 必败，这就是工程师失败的头号嫌疑。
rebase 后净 diff 应仍是 watchdog.ts 16 行 + test 44 行 + 本组 journal；跑完 typecheck/test 闸门直接收尾开 PR，不许再因 rebase 退第十五次。
