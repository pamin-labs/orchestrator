# 029 A stale GitHub credential is the boss's problem, and 404 does not say which one

**Status**: implemented, as part of 007.
**Date**: 2026-08-15
**Split from**: [007](007-github-is-the-source-of-a-project.md) on 2026-08-19,
which carried seven decisions in one file against this directory's own rule. The
shared context — why the host stopped being a git participant, what it deleted,
and the measured path-scoping the whole thing rests on — stays in 007, which
is now the index. This was decision *6. When the credentials go stale* there; the text is unchanged.

An expired GitHub token has exactly the signature this codebase has been burned
by four times: **every group fails at once, and each one reports a different
error** — clone failed, push rejected, PR create failed. `handleAuthFailure`
(`executor.ts:1036`) already does the right thing for model credentials — pause,
one escalation, point at settings, never retry — because retrying is the one
thing that cannot help.

GitHub gets the same treatment, per project: a fifth admission gate beside
`providerHeld`, `credentialMissing`, `online` and `sandboxReady`.

| bucket | examples | who fixes | what happens |
|---|---|---|---|
| **boss** | token expired or revoked, org access pulled, repo unreachable, push refused by branch protection | boss | hold that project's turns, **one** escalation with a button, no retries |
| **agent** | rebase conflict, red checks, review comment, failed submodule init, **422** | agent | a turn with the failure in hand — exists today for conflict and rejection |
| **transient** | network, GitHub 5xx, secondary rate limit | nobody | backoff; after N attempts it becomes the boss's |

Only the middle bucket is implemented today. That is the gap.

**The 404 trap.** GitHub answers **404, not 403**, for a private repo a token
cannot see — deliberately, so existence does not leak. So "repo deleted", "org
revoked third-party access", "user removed from the org" and "token lost its
scope" are *the same response*. Never assert which one it was. The message says
*this login can no longer reach `owner/repo`* and lists what to check. Saying
"deleted" when it was an org policy change sends the boss to the wrong page.

**Things that change without failing:**

- default branch renamed — `baseBranch` already detects the drift and emits an
  event (`checkout.ts:38-61`). Keep it; the source becomes `default_branch`.
- repo renamed or transferred — the API answers 301 with the new location. Update
  the stored `owner/repo` and say so once.
- a GitHub App's repo list shrinks — a repo simply stops appearing in
  `/installation/repositories`. Boss bucket for any project pointing at it.

**Polling cost.** 5000 requests/hour authenticated. Send `If-None-Match` with a
stored ETag: a **304 does not count against the primary rate limit**. ETags are
cached per token, so the cache key has to include the token — rotating the login
must invalidate them rather than replay someone else's. In memory is enough: a
restart costs one full poll round, not correctness. Read `x-ratelimit-remaining`
and hold the same way `providerHeld` holds for model quota. Same shape a fourth
time.

422 is the **agent's**, not the boss's: GitHub understood the request and refused
its content ("No commits between…"), which is a fact about the branch rather than
about the login.

**Git failures that are not credentials.** `createCheckout` throws and
`executor.ts:220` turns that into a failed turn, which is right. But
`ensureCheckout` has **four silent `return`s** before it can ever throw — no
branch, no `ctx.git`, no project row, no remote. Same family as
`reconcileOwnership`'s silent skip: the group then runs a whole turn in an empty
`/work` and nothing says so. Each becomes an event.

Every state above needs its row in `invariants.ts` (hard constraint 7). The held
one especially: a project held on a dead credential is a project whose groups
look perfectly healthy and never move.
