---
group: src-mech-watchdog-ts
role: architect
slice: null
kind: decision
files: []
---
第十三次 rebase 退回不成立：切片不改、边界不重切、不丢弃。实测 origin/main=48e4dfe 已是 HEAD 祖先，规则15 的基线检查此刻就是满足的，本轮一行代码不改。
本轮不许 rebase，与前几轮的建议相反：本地 main=2ee1600 比 origin/main 多一笔未推的 web 提交(notes/progress/tables.tsx)，rebase 到它会把这三个 web 文件塞进本组 PR diff，变成越界；PR 基线是 origin/main，已干净。
冲突面为零且可证：那一笔只碰 web/src/views/{notes,progress,tables}.tsx，本片只有 src/mech/watchdog.ts + test/watchdog.test.ts，零重叠。
S1 前提在今日 main 上逐条仍成立：main:src/mech/watchdog.ts:625 照旧硬编码 `fetch origin main`/`rebase origin/main`，main 的 test/watchdog.test.ts 全文无 "checks defaultBase" —— 真交付，不 drop。
三条验收对上：:608 baseRef=defaultBase，:626-628 rejection 与 :636 中文 finding 与 :617-618 fetchStep 印同一个 baseRef，段内无硬编码；新用例 test/watchdog.test.ts:679。净 diff = watchdog.ts 16 行 + test 44 行 + 本组 journal。
根因仍是规则8(main:watchdog.ts:412-437)：它取最新 agent_turn 的 payload.conflict + 队列空即上抛，注释自认不看退出码；那标记是规则15 下指令时打的意图不是结果，无人清。属另一张卡，不并入本片。
