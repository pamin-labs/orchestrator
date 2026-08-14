---
group: session-token-token
role: architect
slice: null
kind: decision
files: []
---
退回不成立，切片保留、边界不重切、不丢弃。origin/main==main==1fb3ef1，`orch git -- rebase origin/main` 一次过（exit 0），git 自动跳过 d6b1c8a（与 main d5febcc 同 patch-id，逐字同 diff）。
切片仍是要的：main 里没有 session_tokens 修复；080ba13 干净落在 main 上（patch --dry-run 先验、rebase 后坐实），diff 只剩 executor.ts + session-rotate.test.ts + 3 篇 journal。
边界不必重切，反而自愈：重复提交被跳过后 src/api.ts、src/server.ts、test/config.test.ts 退出 diff，原先那处越界随之消失，符合 grp7 既定边界。
真正的阻塞是环境不是代码：agent 沙盒内 git 写对象一律 Operation not permitted（`git hash-object -w` 实测复现），故任何直接 `git rebase` 必败，必须走 `orch git --`。
闸门：typecheck 0 error；397 pass / 1 fail。唯一 fail 是 smoke 缺 web/dist——HEAD 与 origin/main 都不跟踪它（本分支 add+remove 净零），main 上同样失败，与本片无关。
误报源已定位：watchdog 规则15 在主 checkout 取 `rev-parse HEAD` 当 main 基线，文案却让 rebase origin/main，两个 ref 不是一回事；已属 grp17，本组不动。
