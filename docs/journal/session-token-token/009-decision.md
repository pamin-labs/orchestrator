---
group: session-token-token
role: architect
slice: null
kind: decision
files: []
---
grp7 退回理由（rebase 失败）不成立，与 grp3/grp5/grp6 同一根因：切片不改、不丢，边界不重切。
实测：本地 main(d6b1c8a) 已是 HEAD 祖先，rebase main = no-op；diff main..HEAD 只剩 executor.ts + test/session-rotate.test.ts + 本组 journal，main 没动掉本片任何前提。
根因是环境不是代码：watchdog.ts:462 拿主 checkout 的 HEAD（本地 main d6b1c8a）量「落后」，:478 却让工程师 rebase origin/main(d5febcc)。两者是 main@{1} reset 后重提交造出的同树双胞胎（tree 均 f07fe88，patch-id 均 f38156b），互不为祖先，工程师照指令做必然满足不了检查，连挂两轮无代码改动 → 规则8 上抛给我。
闸门实测：orch lease test 390 pass / 1 fail，唯一红是 smoke（web/dist 缺失，本组 owns 只有 executor.ts+test/，禁写 web/**，结构性非本片）；lease typecheck exit 0；session-rotate.test.ts 2/2 pass。
给工程师：本轮不改一行代码，只认本地 main 为基线，不再 rebase origin/main；S1 原样等查收。S2 已随 tables.tsx 重切给 grp15，任务卡到手一律 --already-done 结，不许再动 web/。
双胞胎分叉要老板一次收口（对齐 origin/main 与本地 main），已 advisory 上抛；在那之前全线以本地 main 为准。
