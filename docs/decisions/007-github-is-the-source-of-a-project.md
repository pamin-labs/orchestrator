# 007 GitHub is where a project comes from, and no agent-free container is a sandbox

**Status**: proposed
**Date**: 2026-08-15
**Amends**: 005. That decision said "the container is the boundary". The line is
one word narrower: **a container that runs an agent is the boundary**. A
container with no agent in it is a peer of the server, not something to hand
decoys to.

## Why

A project is added today by browsing the host's filesystem (`/api/dirs`) and
storing an absolute path in `project.repo_path`. Three things follow, and all
three are load-bearing in ways nobody chose:

- Only repositories already cloned on the host can be used at all.
- `missingBinaries()` demands `git`; `prwatch` shells out to `gh`; `login.ts` and
  `chatgpt.ts` shell out to `claude`/`codex`. A machine with docker, the image
  and a pasted token still cannot run.
- The host checkout is doing **three unrelated jobs at once** — staging area for
  bundles, push channel, and index corpus. That is the only reason `gitlock.ts`
  exists: its own header says the host writes the same `.git` from three
  concurrent places.

## Submodules, first, because they decide where a clone happens

CVE-2024-32002 and CVE-2025-48384: cloning a repository with submodules is remote
code execution, via symlink confusion that lands a `post-checkout` script where
git later looks for hooks. GitHub's own mitigation list leads with *"run git
operations against untrusted sources inside ephemeral, network-restricted
sandboxes or containers"*.

So the answer is not "we do not support submodules". It is **which container**:

| | what it does | submodules | why |
|---|---|---|---|
| group container | full clone, working tree, agent inside | **supported** | already ephemeral, already network-restricted, already holds only decoys. RCE here buys what the agent was given anyway |
| utility container | `fetch` / `push` / `bundle` only, never checks out | **never** | holds the real GitHub token and the real ChatGPT refresh token. RCE here is the whole system |

Concrete, as `if`s rather than prompt text:

- group container: `git clone` **without** `--recursive`, then read `.gitmodules`,
  then `git -c protocol.file.allow=user submodule update --init`. Two steps is
  the mitigation itself, not caution.
- utility container: `core.hooksPath=/dev/null`, `--bare`/`--no-checkout`, never
  `submodule`.
- the image's git version becomes a preflight check. These were fixed in git; an
  old image is the exposure.

This is also the answer to "use something off the shelf rather than hand-rolling":
the mitigation is off the shelf (GitHub wrote it), and git is off the shelf. The
only hand-written part is *which container does what*, and no library decides
that for us.

## What the boss actually does

1. connect GitHub once, in settings; switch org; pick a repo and its main branch
2. open a requirement → container + group + clone of main + install + work
3. done → PR
4. stay rebased on main, linear history
5. resolve conflicts when they happen
6. PR merges → container goes away

## Decisions

### 1. One login in settings, no git and no `gh` on the host

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

### 2. `project.repo_path` becomes `owner/repo`, and `/api/dirs` goes

Add `project.default_branch`. Delete the host-filesystem browser — it is also one
of the things a mailbox escape could read.

**Cost to state plainly**: `detect.ts` guesses gates, install and shared paths by
reading the host checkout (`api.ts:2792`). With no local checkout it cannot run at
add time. It moves to **after the first group's clone**, writing its guess into
project config — which is already its own stated rule (*"whatever it guesses is
written into project config, where it can be corrected"*). Adding a project says
so instead of silently guessing nothing.

### 3. Three classes of process, split by whether an agent runs inside

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

### 4. Stay proactive about rebase; stop paying for it per group per tick

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

### 5. The branch's home is the remote, not a host checkout

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

### 6. When the credentials go stale

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
| **agent** | rebase conflict, red checks, review comment, failed submodule init | agent | a turn with the failure in hand — exists today for conflict and rejection |
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
cached per token, so rotating the login invalidates them — store them beside the
credential, not beside the project. Read `x-ratelimit-remaining` and hold the same
way `providerHeld` holds for model quota. Same shape a fourth time.

**Git failures that are not credentials.** `createCheckout` throws and
`executor.ts:220` turns that into a failed turn, which is right. But
`ensureCheckout` has **four silent `return`s** before it can ever throw — no
branch, no `ctx.git`, no project row, no remote. Same family as
`reconcileOwnership`'s silent skip: the group then runs a whole turn in an empty
`/work` and nothing says so. Each becomes an event.

Every state above needs its row in `invariants.ts` (hard constraint 7). The held
one especially: a project held on a dead credential is a project whose groups
look perfectly healthy and never move.

### 7. `--filter=blob:none`

Blobless, not `--depth=1`. Shallow is faster (4× vs 1.5× on the kernel) and breaks
`rebase` and `merge-base --is-ancestor`, both of which we use. GitHub measures an
88.6% average reduction in clone time across repositories using partial clone.
Independent of everything else here; can land first.

## What this deletes

Almost none of it is "replace our code with a library". It is **the host ceasing
to be a git participant**, and the hand-written surface that existed only to
coordinate that.

| gone | why it existed | what replaces it |
|---|---|---|
| `gitlock.ts` — 75 lines + a 24-entry write-subcommand table | three concurrent writers on one host `.git` | one writer |
| `makeGitRunner` (`worktree.ts:20`) | running host git under that lock | nothing |
| `httpsRemote` (`checkout.ts:99`) | rewriting `git@github.com:` to https so a sandbox could clone | the API hands back `clone_url`, already https |
| `remoteUrl` (`checkout.ts:106`) | asking the host checkout for its `origin` | the stored `owner/repo` |
| `detectBaseBranch` (`worktree.ts:82`) — 30 lines of heuristics | guessing main vs master vs trunk | `default_branch` from `GET /repos/{o}/{r}` |
| `seedBranch` (`checkout.ts:136`) + the "three places the branch can be" branch in `createCheckout` | the branch lived on the host between turns | it lives on the remote |
| rule 15's `git fetch` + `merge-base --is-ancestor` per group per tick | reading the baseline out of a container | one conditional API request per project |
| the `gh` wrapper + 6 call sites (`prwatch.ts`) | shelling out to parse JSON | 8 REST endpoints |
| `/api/dirs` + the host directory picker | finding a repo on this machine | the repo list |
| `missingBinaries()` → `[]` | | no external binary on the host at all |

What stays in `worktree.ts` is the part that is our workflow rather than git
plumbing, and it all runs against the group's own clone: `checkpoint`,
`squashWip`, `rollbackTo`, `filesAt`, `sliceDiffBase`, `changedSince`,
`rebaseOntoBase`, `abortStaleRebase`. That last one exists because a turn killed
mid-rebase leaves `rebase-merge/` and every later rebase refuses forever — no
library replaces a lesson.

## Order

1. `--filter=blob:none` (independent)
2. device flow login + repo list (independent of the utility container)
3. `gh` → REST, with ETags and the boss/agent/transient split (removes one binary
   on its own, and is where the failure buckets get built)
4. `Scope` third case + utility container + TTL invariant
5. branch pushes to the remote; `seedBranch` goes
6. checkout moves in; `gitlock.ts`, `makeGitRunner`, `httpsRemote`, `remoteUrl`,
   `detectBaseBranch` go; `missingBinaries()` empties
7. codex refresher moves in (last — it is a real credential)
8. rule 15 switches to the API baseline

## Path scoping exists, and step 2 depends on it

`CredentialMatch` takes `paths: string[]`, default `["/*"]`
(`node_modules/@alibaba-group/opensandbox/src/api/egress.ts:518-546`, SDK-facing
type at `dist/sandboxes-vaWpTC_c.d.ts:222-224`). **We send it nowhere today** —
`Credential` (`sandbox.ts:534-540`) has no path field and both bind sites build
`match: { schemes, hosts }` (`sandbox.ts:422`, `:750`), so every credential we
bind sits at the `/*` default.

The matcher is upstream `components/egress/mitmscripts/system.py`:

```python
def _path_matches(path, pattern):
    if pattern.endswith("*"): return path.startswith(pattern[:-1])
    return path == pattern

def _request_path(flow):
    return (flow.request.path or "/").split("?", 1)[0] or "/"
```

**Trailing-`*` prefix, or exact equality. Nothing else** — no `?`, no `**`, no
leading wildcard, and `*` does not stop at `/`. Query string is cut before
matching. Evaluation order is scheme → port → method → **path** → host, all
AND'ed, with path a hard filter ahead of the host check.

git's smart HTTP:

| op | discovery | transfer |
|---|---|---|
| fetch | `GET /{repo}/info/refs?service=git-upload-pack` | `POST /{repo}/git-upload-pack` |
| push | `GET /{repo}/info/refs?service=git-receive-pack` | `POST /{repo}/git-receive-pack` |

The two discovery requests differ **only in the query**, which is stripped before
matching — so no `paths` rule separates them, and `methods` cannot either (GET
then POST for both). The transfer POSTs do differ by path, and those carry the
packfile. So this is expressible:

```
paths: ["/owner/repo.git/info/refs", "/owner/repo.git/git-upload-pack"]
```

**The trap is the shape upstream hands you.** Its credential-vault guide gives one
git example — `"paths": ["/org/private-repo.git*"]` — and it is wrong for this,
because prefix matching does not stop at `/` and that pattern re-admits
`git-receive-pack`. The rule must be an **enumerated exact allow-list generated
per project**, not a prefix written once.

Which invariant survives, stated precisely:

- **Holds by construction**: no write ever completes. The packfile POST is never
  credentialed, so GitHub 401s it before any object transfers.
- **Does not hold**: "the token is never presented on a write path."
  `GET /info/refs?service=git-receive-pack` gets the real token and no path rule
  can stop it. The exposure is an authenticated ref advertisement the sandbox can
  already obtain via upload-pack — small, not zero. The invariant gets reworded,
  not reaffirmed.

**This is a prerequisite, not a nicety.** Classic OAuth has no read-only scope for
private repositories — `repo` is read *and* write. The moment device flow lands
(step 2), the existing github binding would hand every agent container a token
that can push to main, and "no direct push to main" would go back to being a
sentence in a prompt. Hard constraint 3 says otherwise. Step 2 ships with the
binding scoped from the start; the utility container keeps the unscoped one.

Two things that still need a live server, both of which fail badly if assumed:

1. **Does the control plane validate `paths` at all?** The SDK passes strings
   through unvalidated (`src/adapters/egressAdapter.ts:128-129`), and 005 already
   recorded docs-versus-runtime disagreement. A silently ignored `paths` **fails
   open** — a push that works while the design says it cannot.
2. **Redirects.** GitHub 301s `/owner/repo` → `/owner/repo.git`, and again for a
   renamed repo. A redirect changes the path, and an exact allow-list drops
   injection on the redirected request — surfacing as a clone auth failure that
   mentions nothing about paths.

Provenance: the matcher was read on `main`; we pin `egress:v1.1.6`
(`preflight.ts:252`). The one point with independent evidence
(`allow_single_encoded_slash`, dated between v1.1.4 and v1.1.6 in 005) agrees, but
the tag itself was not read.

Noted while in there: `CredentialSubstitution.in` accepts `"path" | "query" |
"header" | "body"` — the sidecar can replace a placeholder outside headers.
`vaultFor` only ever builds header bindings today. Not needed yet; worth knowing
before someone concludes a credential that is not a header cannot be vaulted.

## Open

- Quota does **not** move into the utility container: rollout files are written by
  the codex process that produced them, which lives in a group container
  (`subusage.ts:254` already reads from there). Listed so nobody puts it on the
  migration list.
