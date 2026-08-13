---
group: timeline-flicker
role: pm
slice: null
kind: decision
files: []
---
老板反馈的「新事件进来整块闪」= S1+S2 已经修的问题，不新开工作：key 从 at+下标改成稳定 id（e<seq>/l<n>），事件行抽成 memo 组件，两片均已 accepted。
根因是原 key=`${f.at}-${i}` 的 i 取自 reverse 后下标，新帧一到全表下标位移→每行 key 变→整表 remount，fade-in 全部重放，正是老板描述的症状。
本组分支落后 main 1 个提交，尚未合入；老板现在跑的服务出自未合入本组改动的 main，故仍能看到闪烁，不代表代码没修好。
不新建切片，等老板 merge 本组分支并重启服务后现象应消失；若重启后仍闪，再反馈会重新排查（不排除是另一条已知未解决项：frames 挂 App 顶层 state 导致每 token 全 App 重渲染，另需切片）。
