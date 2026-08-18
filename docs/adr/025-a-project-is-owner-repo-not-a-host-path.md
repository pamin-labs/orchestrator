# 025 A project is `owner/repo`, not a path on this machine

**Status**: implemented, as part of 007.
**Date**: 2026-08-15
**Split from**: [007](007-github-is-the-source-of-a-project.md) on 2026-08-19,
which carried seven decisions in one file against this directory's own rule. The
shared context — why the host stopped being a git participant, what it deleted,
and the measured path-scoping the whole thing rests on — stays in 007, which
is now the index. This was decision *2. `project.repo_path` becomes `owner/repo`, and `/api/v1/dirs` goes* there; the text is unchanged.

Add `project.default_branch`. Delete the host-filesystem browser — it is also one
of the things a mailbox escape could read.

**Cost to state plainly**: `detect.ts` guesses gates, install and shared paths by
reading the host checkout (`api.ts:2792`). With no local checkout it cannot run at
add time. It moves to **after the first group's clone**, writing its guess into
project config — which is already its own stated rule (*"whatever it guesses is
written into project config, where it can be corrected"*). Adding a project says
so instead of silently guessing nothing.
