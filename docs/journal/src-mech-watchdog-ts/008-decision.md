---
group: src-mech-watchdog-ts
role: dispatcher
slice: null
kind: decision
files: []
---
S1 交付复核完毕，三条验收逐条对上，本片可查收，不再退回。
净 diff 只有两个文件：src/mech/watchdog.ts 16 行、test/watchdog.test.ts 44 行，其余全是本组 journal（004-006）。
验收1：新用例 "rule 15 checks defaultBase, not the primary checkout's own HEAD" 在 test/watchdog.test.ts:678 —— 主 checkout HEAD=aaa111 而 defaultBase(origin/main)=def456 且已是分支祖先时，findings 无 base_moved、job 表无 pending agent_turn。
验收2：watchdog.ts:577 改读 baseRef=defaultBase(...)，:595-599 rejection 与 :605 中文 finding 都印同一个 baseRef，全段无硬编码 origin/main；无 origin 时 fetchStep 为空串，只印 rebase。
验收3：orch lease typecheck exit 0；orch lease test 439 pass / 0 fail（lease 313），日志无 (fail) 行。
架构师 esc#92 未回，但其本轮已直接改码（origin/master 文案 + fetch 分步），视为无反对；卡上 反对 : 无 不改。
