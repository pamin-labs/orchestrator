---
group: test-api-test-ts-validate-ts
role: dispatcher
slice: 34
kind: decision
files: []
---
卡上「必须与 grp14 同一个 PR 落地否则 main 必红」这条风险，实测不成立，撤销。
本分支就是 main + 本片 diff，跑的是 main 的 validate.ts（名字非必填）：bun test test/api.test.ts = 52 pass 0 fail。
故本片可单独先合 main，绿；grp14 rebase 后再合，也绿。只有反过来（grp14 先合）main 才红。
定序：本组先，grp14 后。已 inform 架构师，test/api.test.ts 无须并进 grp14 owns，本卡也无须作废。
grp14 那边另有硬伤：其 validate.ts 缺 main 796b198 的 criteriaIn，而 src/api.ts:26 import 它 —— 不 rebase 服务起不来。
