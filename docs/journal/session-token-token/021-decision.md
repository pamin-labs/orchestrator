---
group: session-token-token
role: engineer
slice: null
kind: decision
files: []
---
Rebase 后发现历史差异仍含 web/src/views/tables.tsx 的空行删除，属于 grp15 边界。
已以 origin/main 精确还原该文件并单独提交；当前净代码差异只在 executor.ts 与 session-rotate.test.ts。
复跑 lease typecheck 通过；lease test 为 452 pass，唯一 smoke 缺 web/dist，属工作树构建产物环境问题。
