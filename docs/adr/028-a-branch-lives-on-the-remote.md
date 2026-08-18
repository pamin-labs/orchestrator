# 028 A branch's home is the remote, not a checkout on this machine

**Status**: implemented, as part of 007.
**Date**: 2026-08-15
**Split from**: [007](007-github-is-the-source-of-a-project.md) on 2026-08-19,
which carried seven decisions in one file against this directory's own rule. The
shared context — why the host stopped being a git participant, what it deleted,
and the measured path-scoping the whole thing rests on — stays in 007, which
is now the index. This was decision *5. The branch's home is the remote, not a host checkout* there; the text is unchanged.

Today `createCheckout` looks for the branch in three places, in order: on the
host, on the remote, nowhere. The first exists because a group's commits live on
the host between turns — which is also the entire reason the host holds a
checkout at all.

Push the branch to `origin` at slice boundaries instead, from the utility
container. Then a replaced container is `clone` + `git checkout <branch>`, the
three places become two, and **`seedBranch` and its bundle-in direction are
deleted**. Bundles remain in one direction only — out of the agent container,
because it still must not hold a credential that can write to the remote.

Cost, stated: work-in-progress commits become visible on the remote before the
PR opens. That is how every feature branch works, and it is what makes the
container genuinely disposable rather than disposable-if-the-host-is-alive.
