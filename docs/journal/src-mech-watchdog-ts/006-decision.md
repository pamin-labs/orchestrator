---
group: src-mech-watchdog-ts
role: dispatcher
slice: null
kind: decision
files: []
---
rebase 到 main(97964f7) 一次过 exit 0，重放 6 个提交零冲突；前一轮卡上说的两块重复改动（规则7b unshipped、lang.ts 两条文案）已被 git 按内容自动丢掉，未复活，不存在一个状态两个 driver。
净交付达标可数：diff main..HEAD 只剩 src/mech/watchdog.ts 4+/3- 与 test/watchdog.test.ts +32，其余全是本组 journal。
main 新加的两处原样保留：rule 15 查询里的 NOT EXISTS(pending conflict job) 门(watchdog.ts:569-570) 与 rebase_seen_at 写入(:585)，本片只在其上叠了 baseRef/fetchStep 三行。
闸门实测：typecheck exit 0；orch lease test 437 pass / 0 fail，日志无 (fail) 行；新用例 "rule 15 checks defaultBase, not the primary checkout's own HEAD" pass。
AGENTS.md 是 checkpoint(worktree.ts:179 git add -A) 把 harness 生成的符号链接扫进了分支，main 不跟踪它：本轮 git rm --cached 撤出 PR，磁盘上文件仍在，codex 照读。根因是共享件（.gitignore 或 checkpoint 排除），已问架构师，不入本卡。
