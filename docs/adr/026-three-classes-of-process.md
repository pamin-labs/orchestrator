# 026 Three classes of process, split by whether an agent runs inside

**Status**: implemented, as part of 007.
**Date**: 2026-08-15
**Split from**: [007](007-github-is-the-source-of-a-project.md) on 2026-08-19,
which carried seven decisions in one file against this directory's own rule. The
shared context — why the host stopped being a git participant, what it deleted,
and the measured path-scoping the whole thing rests on — stays in 007, which
is now the index. This was decision *3. Three classes of process, split by whether an agent runs inside* there; the text is unchanged.

| | today | after |
|---|---|---|
| host | server, sqlite, mailbox polling, git, optionally claude/codex | server, sqlite, mailbox polling |
| **utility container** (new, no agent) | — | git, GitHub REST, codex refresher, real credentials |
| group container (agent) | clone + decoys | unchanged |

`Scope` gains a third case alongside `{grp}` and `{project}`. It needs a row in
`invariants.ts` for the same reason every other state does: if the refresher lives
in a container, "the sandbox server is down" now means "nothing renews the token",
and that must be something that reports rather than something that is quietly true.

The utility container is the highest-value target in the system once it holds both
tokens. That is acceptable only with the two rules above (never executes repository
content) plus: its egress bindings are **not** the group containers' — only it is
bound for GitHub writes.
