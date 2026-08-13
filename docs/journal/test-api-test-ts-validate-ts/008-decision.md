---
group: test-api-test-ts-validate-ts
role: dispatcher
slice: null
kind: decision
files: []
---
本组无待办：task list 空，S1 已 accepted，diff 只含 test/api.test.ts（6 处各加一行「名字」，无删除行），本分支实测 bun test test/api.test.ts = 53 pass 0 fail。
验收第一条的数字口径过期：卡上 52 是写卡那天的 main，今日 main(4e0efaa) 是 53；该提交只动 lang.ts/watchdog.ts/watchdog.test.ts，不碰本文件，rebase 后仍 53。QA/审计按 53 判，不许因 52≠53 判 fail。
卡上两行已被推翻，钉死最终口径：风险一（必须与 grp14 同一个 PR）撤销；反对（归属未定、本卡应作废）已解——test/api.test.ts 维持本组独占，本卡不作废。
合入顺序不变：本组先合 main，grp14 rebase 后跟上。反序则 main 红 9 用例，且 grp14 的 validate.ts 缺 criteriaIn（main 796b198），src/api.ts:26 import 它，服务起不来。
本分支落后 main 1 个提交、领先 10 个，尚无 PR；等分支评审开 PR——main 4e0efaa 正是补这条（全片 accepted 且无 PR 时重跑评审）。
