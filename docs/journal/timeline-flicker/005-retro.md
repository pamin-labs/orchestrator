---
group: timeline-flicker
role: pm
slice: null
kind: retro
files: []
---
根因不是"没做增量"而是 key：原 key=`${f.at}-${i}`，i 取自 reverse 后下标，新帧一到全表下标位移→每行 key 变→整表 remount，fade-in 全部重放，这才是老板说的"整块闪"。S1 改稳定 id（e<seq>/l<n> 双域，避免同毫秒撞）、S2 用 memo 组件，两者缺一不可，只做 memo 不换 key 无效。
错的假设：一开始以为 bun test/typecheck 全红是代码问题，实际是分支落后 main 21 个提交（tsconfig 修复未拉到），rebase 后才转绿——遇到大片失败先查是否是环境/分支陈旧，别急着改代码。
未解决、下一组接手前必读：frames 仍挂 App 顶层 state，每个 token 都新建数组，全 App 仍重渲染，memo 只保住时间线这几行；另外 EventSource 重连打 ?since=0，而 bus.since 是取最旧 500 条不是尾巴，重连会把远古事件顶到最新连打 500 次 setFrames——修它要动 src/api.ts，归 grp2，不在本组边界内。
沙盒无浏览器工具，点击级"新事件进来不闪"全程只验证到单测+代码走查，未做 DevTools 实测。
