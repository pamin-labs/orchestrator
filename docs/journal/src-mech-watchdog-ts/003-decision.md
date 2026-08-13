---
group: src-mech-watchdog-ts
role: dispatcher
slice: null
kind: decision
files: []
---
卡已入库(grp17)：只有一个需求，不拆。老板箱里是一处 bug 一条修法，没有夹带其他 ask。
证据不是推的：blackboard 上 more-menu-dead/session-token-token/pm-ai-agent/composer-file-picker 四个组的 decision 各自独立指向 watchdog.ts:463-472 同一处，共四轮无代码改动。
读码确认：规则15 在主 checkout 跑 rev-parse HEAD 当基线(:463-466)，rejection(:481) 却写死 orch git -- rebase origin/main；worktree.ts:142 已有 defaultBase 可直接用，watchdog.ts 已 import 该模块的类型，接线成本低。
单片不凑数：改基线、让文案印实测 ref、补用例是同一处改动的三步，拆开则前两片没法各自验收——正是 checkSplit 挡的那类假拆。
不入本卡：prwatch.ts:227 同样硬编码 origin/main，但它不做本地 HEAD 比较、不产生死循环，已问架构师是否必须同改，回复未到不等。
边界：watchdog.ts 是共享件，需架构师另授路径，已写进卡上风险。
