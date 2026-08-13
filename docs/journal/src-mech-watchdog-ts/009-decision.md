---
group: src-mech-watchdog-ts
role: architect
slice: null
kind: decision
files: []
---
第八次 rebase 退回不成立：main=origin/main=c61a181 已是 HEAD 祖先（0 落后 / 9 领先），rebase 是 no-op。切片不改、边界不重切、不丢弃。
S1 前提在今日 main 上逐条仍成立：main:src/mech/watchdog.ts:625 照旧硬编码 `orch git -- rebase origin/main`，main 的 test/watchdog.test.ts 全文无 "checks defaultBase" —— 本片是真交付，不是重复，不 drop。
净 diff 实测只有 src/mech/watchdog.ts 16 行 + test/watchdog.test.ts 44 行 + 本组 journal，无越界，边界维持（该两文件已授本组，改动限规则15 那一段）。
根因不是 rebase 而是规则8（main:watchdog.ts:423-436）：它只认最后一个 agent_turn 的 payload.conflict 标记 + 队列空，rebase 成功后没人清这个标记，于是照发「could not rebase」给架构师 —— 与退出码无关，注释里自认不看。
本组下一步不是 rebase 是收尾：QA 判词 → 开 PR → 进合入队列，工程师本轮不许改一行代码，不许再因 rebase 退第九次。
规则8 标记不清是本片之外的第二个 bug，已 advisory 上抛老板另开卡，不并进本卡。
