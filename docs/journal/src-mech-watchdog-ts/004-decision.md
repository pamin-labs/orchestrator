---
group: src-mech-watchdog-ts
role: engineer
slice: null
kind: decision
files: []
---
Rebased onto origin/main (800815f), fetch+rebase clean except test/watchdog.test.ts had one real conflict (two independent new tests added on both sides).
Resolved by keeping both tests: "stale PR branch...base comes from the remote" (main's) and "rule 15 checks defaultBase, not the primary checkout's own HEAD" (this branch's) — no conflict markers left, verified via grep.
Gates green post-rebase: orch lease test 408 pass/0 fail, orch lease typecheck exit 0. Diff vs main unchanged in shape: watchdog.ts (baseRef var + fetchStep text) + watchdog.test.ts + journal.
Resubmitting task 35 done + review.
