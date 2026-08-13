---
group: test-api-test-ts-validate-ts
role: pm
slice: null
kind: decision
files: []
---
S1 diff 仍不干净：3411c4e 混入 test/smoke.test.ts 无关重构 + web/dist 提交成指向宿主机绝对路径的符号链接（grp7 撞过同坑，非法逃避 gitignore）。
两处均越界，违反验收「diff 只含 test/api.test.ts」。已 mail engineer：git checkout main -- test/smoke.test.ts && git rm web/dist，同一 S1 收尾，不新开切片。
清完后 diff 应只剩 test/api.test.ts + 本组 docs/journal，再判 QA。
