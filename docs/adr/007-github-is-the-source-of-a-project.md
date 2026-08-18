# 007 GitHub is where a project comes from, and no agent-free container is a sandbox

**Status**: implemented. The path scoping the whole thing rests
on is measured against a live server (see below), and the host is no longer a
git participant — `missingBinaries()` is `[]`, `gitlock.ts` and `makeGitRunner`
are gone, and rule 15 reads the base from the API.

`detectBaseBranch` and `httpsRemote` were **not** deleted despite being on this
document's own list. Both still have live callers: `detectBaseBranch` is the
fallback when `rebaseOntoBase` is given no `baseRef`, which is the unpark path,
running against the group's clone *inside its container* where asking git is
correct; and `httpsRemote` serves rows migration 037 left holding an SSH remote.
A deletion list is a plan, not a fact about the code.

**Step 7 landed too**, and further than planned. The codex refresher runs in the
utility container; so does the ChatGPT login, via `codex login --device-auth` —
codex's own headless flow, printed on the line after the localhost one it
recommends against, so the real client runs the whole thing and the
impersonation objection that kept this on the host does not apply. The usage
poll moved with them, and that one was not a convenience: it was a host `fetch`
carrying the real `runtime_auth` token, the last real model credential leaving
this machine without the sidecar substituting it, which made the vault's stated
premise false in a way reading the premise could not reveal.

`claude setup-token` stays, and the reason is not OAuth. Measured: no callback
listener at all (`code=true`), and without a pty it blocks silently forever —
the browser shows a code the human pastes back into the CLI's **stdin**, and the
exec API is request/response with no stdin channel. That is a transport gap, and
scripting a paste around it is the workaround this decision refuses. The pasted
token covers a headless machine, as the pasted `auth.json` did for codex before
device-auth.

So the host serves HTTP and SSE, owns sqlite, and polls the mailbox, with three
stated exceptions: `claude setup-token` above; preflight's credential
verification, which runs at boot before any container is guaranteed to exist, so
moving it would make "can we open a container" a prerequisite for reporting that
we cannot; and the GitHub REST client, which is not a model credential and which
§1 chose over a binary deliberately.
**Date**: 2026-08-15
**Amends**: 005. That decision said "the container is the boundary". The line is
one word narrower: **a container that runs an agent is the boundary**. A
container with no agent in it is a peer of the server, not something to hand
decoys to.

## Why

A project was added by browsing the host's filesystem (`/api/v1/dirs`) and
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

Seven, each in its own file — this document is the shared context they were
decided against, and splitting them is the only change:

- [024 GitHub login is one device flow in settings, and the host keeps no git](024-github-login-is-one-device-flow-in-settings.md)
- [025 A project is `owner/repo`, not a path on this machine](025-a-project-is-owner-repo-not-a-host-path.md)
- [026 Three classes of process, split by whether an agent runs inside](026-three-classes-of-process.md)
- [027 Rebase nudges ask the remote once per project, not every container every tick](027-rebase-nudges-ask-the-remote-once-per-project.md)
- [028 A branch's home is the remote, not a checkout on this machine](028-a-branch-lives-on-the-remote.md)
- [029 A stale GitHub credential is the boss's problem, and 404 does not say which one](029-a-stale-github-credential-is-the-boss-s.md)
- [030 Clones are blobless, not shallow](030-clones-are-blobless.md)

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
| `/api/v1/dirs` + the host directory picker | finding a repo on this machine | the repo list |
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

**And it is permanent, not a stepping stone.** There is a stronger form of this —
a GitHub App can mint an *installation* token with `permissions` narrowed below
what the app declares, so a group container could hold a token GitHub itself
refuses to let push. It needs the app's private key to sign a JWT, and that key
cannot ship: whoever holds it can act as the app on every installation. Since
this is self-hosted with no service of ours anywhere, the shipped path is a
user-to-server token from device flow, which has exactly one permission set and
cannot be narrowed.

So `paths` is the whole of the read/write split for every user, for good. That
promoted two unknowns from "verify eventually" to **release blockers** — a `paths`
the control plane silently ignores fails *open*, and there is nothing behind it.
Both are now measured against a live server; see below.

### Measured against a live server, not assumed

Both blockers are answered. Technique is 005's: bind a credential to a host that
echoes what it received, and have the container send a **decoy** value for the
same header — so injection shows up as the real value replacing the decoy, and
its absence shows up as the decoy surviving. Both directions are observable, which
is the point; seeing the allowed path get the credential proves nothing on its own.

One credential, `hosts: ["postman-echo.com"]`, `header: "x-probe"`,
`paths: ["/get"]`. Verbatim, from inside a group container:

```
$ curl -s -H 'x-probe: DECOY-NEVER-INJECTED' https://postman-echo.com/get
{"headers":{...,"x-probe":"REAL-INJECTED-BY-SIDECAR",...}}

$ curl -s -H 'x-probe: DECOY-NEVER-INJECTED' https://postman-echo.com/headers
{"headers":{...,"x-probe":"DECOY-NEVER-INJECTED",...}}
```

**1. The control plane honours `paths`.** Same host, same credential, same
request in every other respect: the listed path is injected, the unlisted one is
not. It does not fail open.

**2. Injection is evaluated per request, on that request's own path.** With
`paths: ["/get"]` and a 302 from `/redirect-to?url=…/get`, the *redirected*
request arrives with `REAL` — the first hop was never on the list and the hop that
landed on `/get` was. Reversed (`paths: ["/redirect-to"]`, redirecting to `/get`),
the final request keeps `DECOY`. So GitHub's `/owner/repo` → `/owner/repo.git`
redirect is safe: what matters is where a request lands, and a credential does not
ride a redirect into an unlisted path.

**3. The trap is real, and it is the star.** On a host with a nested echo
(`httpbingo.org/anything/deep/path`):

| binding | request | arrives as |
|---|---|---|
| `paths: ["/anything"]` | `/anything/deep/path` | `DECOY` — exact means exact |
| `paths: ["/anything*"]` | `/anything/deep/path` | `REAL` — **the star crosses `/`** |

Which is upstream's own suggested git shape, measured rather than inferred:
`/owner/repo.git*` would re-admit `/owner/repo.git/git-receive-pack`.
`test/mech/util-container.test.ts` asserts no generated path ends in `*`, and
`test/live/sandbox-live.test.ts` holds the on-list/off-list pair against a real
container so a future SDK or server version cannot take it away quietly.

Not measured: the same trials against the `v1.1.6` tag specifically. These ran
against whatever the running server pulls, which is what the fleet uses.

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

## Amendment: skills, and the last host login (2026-08-15)

Two things §6 left standing, and one bug found on the way.

**A repository's own skills were listed and never delivered.** The comment
claiming otherwise had `.codex/skills` down as codex's project path. Counted in
the binaries in `orch/agent:1`:

```
claude   .claude/skills 93   .codex/skills 0   .agents/skills 0
codex    .codex/skills  3    .claude/skills 0  .agents/skills 0
```

and codex's three occurrences are one sentence — *"I will place it in
`$CODEX_HOME/skills` (or `~/.codex/skills` when `CODEX_HOME` is unset)"*. **codex
has no project-local skills directory at all.** So two of the three conventions
reached neither runtime and the third reached one of two, while the settings page
listed all three.

The reason the one previous attempt failed is worth keeping: it linked repo
skills into `$CODEX_HOME/skills`, which was itself the read-only mount, so every
link was `EROFS` — swallowed by a trailing `; true`, with a test that ran in a
temp directory where no mount existed. Reported success, delivered nothing.

Fixed by moving the mount off the CLIs' own paths. The staged directory mounts
read-only at `/opt/orch/skills`; `SKILL_SYNC` builds `/root/.claude/skills` and
`$CODEX_HOME/skills` as ordinary directories of symlinks into it, then links the
repository's own on top. It rides on the checkout probe that already ran, so it
costs no round trip and is current every turn rather than per container.

The same pass prints the repository's skills back out (`ORCHSKILL <rel>
<base64 head>`), which is what restores the listing the panel and `/name` lost
when `repo_path` became `owner/name`. The head travels rather than a parsed
description because a `description: |` block scalar read by `sed` returns `|`.

**`claude setup-token` moved into the utility container.** It is a TUI: run
without a pty it prints **nothing** and exits 0, which is why this was left on
the host. Under a pty it prints its URL and waits at `Paste code here`. The
container gets a pty (`pty.fork` plus an explicit `TIOCSWINSZ` — a default 80
columns wraps the URL mid-token, and `script` ignores `COLUMNS`) and the pasted
code arrives on stdin through a file the orchestrator appends to, because the
sandbox SDK has no stdin channel. The real CLI performs the whole OAuth exchange;
nothing here builds a URL or calls a token endpoint. `startLogin` and
`/api/v1/auth/login` are gone with it — no login runs a CLI on this machine.

**Found on the way: the sandbox SDK delivers stdout one line per message with the
newline removed.** Measured:

```
printf 'a\nbb\nccc\n'   ->  ["a", "bb", "ccc"]
printf 'a\nb'           ->  ["a", "b"]              a partial last line is unmarked
printf 'a\n\n\nb\n'     ->  ["a", "\n", "\n", "b"]  a blank line arrives AS "\n"
printf '1%\r42%\rdone\n'->  ["1%", "42%", "done"]   CR splits too, and is eaten
300 KB, no newline      ->  one message             a long line is never split
```

`join("")` therefore ran every line together: `git status --porcelain`, `ls`, and
the skills inventory all arrived as a single line, and every caller splitting on
newlines matched nothing — without throwing. On the streaming path it is worse:
with no terminator the splitter holds an entire turn's NDJSON and emits it once,
concatenated. The last row is what makes re-joining with `\n` a fact rather than a
guess.

**Also found: the repo map has had no symbols since this decision landed.**
`buildMap` read `join(repo_path, rel)` off this machine, and `repo_path` is an
`owner/name`. Every read threw, every throw was caught as "a file git knows about
and the disk does not", and the map rendered paths only while still reporting
`repo map refreshed`. The symbol source is now a parameter; the watchdog supplies
it from the project's own container.
