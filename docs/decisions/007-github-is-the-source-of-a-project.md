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

### 5. `--filter=blob:none`

Blobless, not `--depth=1`. Shallow is faster (4× vs 1.5× on the kernel) and breaks
`rebase` and `merge-base --is-ancestor`, both of which we use. GitHub measures an
88.6% average reduction in clone time across repositories using partial clone.
Independent of everything else here; can land first.

## What this deletes

- `gitlock.ts` (75 lines + the 24-entry write-subcommand table) — three concurrent
  writers become one
- `gh` as a dependency (6 call sites in `prwatch.ts`, plus its `auth status` check)
- `/api/dirs` and the host directory picker
- `missingBinaries()` → `[]`. No external binary on the host at all.

`worktree.ts` stays. Its 260 lines are real git semantics bought the hard way —
`abortStaleRebase` exists because a turn killed mid-rebase leaves `rebase-merge/`
and every later rebase refuses forever. No library replaces that.

## Order

1. `--filter=blob:none` (independent)
2. device flow login + repo list (independent of the utility container)
3. `gh` → REST (removes one binary on its own)
4. `Scope` third case + utility container + TTL invariant
5. checkout moves in; delete `gitlock.ts`; `missingBinaries()` empties
6. codex refresher moves in (last — it is a real credential)
7. rule 15 switches to the API baseline

## Open, needs a probe before it is a design

- Does the egress binding's `paths` field (mentioned in 005) actually scope by
  request path? If it does, one write token can be bound so `git-receive-pack`
  never sees it, and the two-container split gets cheaper.
- Quota does **not** move into the utility container: rollout files are written by
  the codex process that produced them, which lives in a group container
  (`subusage.ts:254` already reads from there). Listed so nobody puts it on the
  migration list.
