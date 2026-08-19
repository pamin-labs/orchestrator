# 027 Rebase nudges ask the remote once per project, not every container every tick

**Status**: implemented, as part of 007.
**Date**: 2026-08-15
**Split from**: [007](007-github-is-the-source-of-a-project.md) on 2026-08-19,
which carried seven decisions in one file against this directory's own rule. The
shared context — why the host stopped being a git participant, what it deleted,
and the measured path-scoping the whole thing rests on — stays in 007, which
is now the index. This was decision *4. Stay proactive about rebase; stop paying for it per group per tick* there; the text is unchanged.

Watchdog rule 15 runs `git fetch` + `merge-base --is-ancestor` inside **every**
group container on **every** tick. The behaviour is right and was bought with an
incident — its comment: *"Six groups spent a day building on a base fifteen
commits stale, and every one of them would have found out at PR time, one conflict
at a time."* Waiting for GitHub to say `CONFLICTING` is that same late news.

Keep the nudge, change where the fact comes from: **one `GET /repos/{o}/{r}/branches/{main}`
per project per tick**, compared against `grp.rebase_seen`. Same rule, N execs
become one HTTP call, and it removes M9 — a sandbox clone that never fetched makes
`merge-base` exit non-zero, which the current code cannot tell apart from "genuinely
behind".

Conflict resolution stays in the group container: it needs a working tree and an
agent. Linear history is enforced by branch protection (require linear history,
rebase-merge only), set once when the repo is connected — not produced by rebasing
every thirty seconds.

`landGroup`'s serial merge queue stays. That ordering is ours; GitHub does not
know about it.
