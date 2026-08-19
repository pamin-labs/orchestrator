# 024 GitHub login is one device flow in settings, and the host keeps no git

**Status**: implemented, as part of 007.
**Date**: 2026-08-15
**Split from**: [007](007-github-is-the-source-of-a-project.md) on 2026-08-19,
which carried seven decisions in one file against this directory's own rule. The
shared context — why the host stopped being a git participant, what it deleted,
and the measured path-scoping the whole thing rests on — stays in 007, which
is now the index. This was decision *1. One login in settings, no git and no `gh` on the host* there; the text is unchanged.

OAuth **device flow**: the token exchange needs `client_id`, `device_code` and
`grant_type` — no client secret — so the client id ships in the repo the way
`gh`'s does. `@octokit/auth-oauth-device` handles the poll, including the
`slow_down` backoff that a hand-rolled loop forgets.

Org switching is not a second login: one user token already sees every org the
user belongs to, subject to that org's third-party access policy. A GitHub App
instead scopes per installation and can be read-only, at the cost of the maintainer
registering the app — the tradeoff is recorded here, not decided here, because
only the read-only half depends on it.

Everything else GitHub is eight REST endpoints (orgs, repos, installations, pr
create/view/merge, viewerPermission, user). Plain `fetch`; `Link`-header
pagination is five lines. Not `@octokit/rest` for eight calls — revisit if
GraphQL or rate-limit retry shows up.

Not `isomorphic-git`: its selling point is running git without the binary, which
sounds like this problem and is the opposite of it — we are removing git from the
host, not reimplementing it there. Also measurably slower on large repositories.
