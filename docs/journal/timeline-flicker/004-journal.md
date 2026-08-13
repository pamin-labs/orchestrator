---
group: timeline-flicker
role: engineer
slice: null
kind: journal
files: []
---
S1 落地：Frame.id 分域稳定 id（e<seq>/l<n>），timeline key 从 at+index 改成 id。
bun test/typecheck 之前全红是分支落后 main 21 个提交（tsconfig allowImportingTsExtensions 修复未拉到）——已 rebase 到 main，两项转绿（393 pass, 0 type error）。
web/dist 是 deny-write 共享路径，本地无法 bun run build:web；改用 bun build 出到 $TMPDIR 验证 web/src 编译通过。
无浏览器/截图工具，"新事件进来已有行不闪" 只做了代码+单测验证，未做 DevTools 实测，判词里已如实标注留给 QA 层。
