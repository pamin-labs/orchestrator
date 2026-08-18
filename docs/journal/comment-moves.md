# Comment moves

Measurement, selection rationale and post-mortem narrative lifted out of five
source files, recorded verbatim so it can be written into commit messages or an
ADR. Each heading is the `file:line` the text was removed from, against the
revision before the removal.

## src/mech/git/checkout.ts:30

Re-detected when the stored name no longer exists on the remote: a default
branch that was renamed (master -> main) or repointed otherwise leaves every
clone, rebase and diff resolving against a ref that is not there, and the
symptom is a group that cannot start rather than anything mentioning branches.
Said out loud when it changes, because it changes what every later diff means.

## src/mech/git/checkout.ts:46

`Bun.spawn` throws rather than returning a code when the cwd does not
exist, so the old `rev-parse` here took five callers down with it: the
approval never landed, the DRAFT card was never filed, and the 查收 page
500'd, each with a message saying git was not installed.

Asked every time rather than only when the column is empty, because the drift
this catches was bought with an incident — a default branch renamed on the
remote leaves every clone, rebase and diff resolving against a ref that is not
there.

## src/mech/git/checkout.ts:53

This is the only request that runs on every path — every diff, every group
start, every gate — so it is where the drift is cheapest to notice.

GitHub does redirect `GET /repos/old/name`, which is the only reason this call
still answers at all. Left alone, the panel shows a name that no longer exists
and the failure arrives at the last step of a finished branch.

## src/mech/git/checkout.ts:93

The base branch was a free-text box, which asks the boss to remember and
retype something GitHub already knows — and a typo there is not a typo, it is
every future group cut from a ref that does not exist.

## src/mech/git/checkout.ts:222

Failing is the useful answer — it means the read credential is missing, which
preflight and the settings page can say.

`--progress` and streamed, not awaited in silence: a clone of a real
repository is the longest minute of a group's life and the panel showed a
grey dash for all of it.

`--filter=blob:none`, and never `--depth=1`. Shallow is faster still and
truncates history — `rebaseOntoBase` and `merge-base --is-ancestor` both
need the real thing, and they are what every slice diff and every rebase go
through. Blobless keeps every commit and fetches file contents on demand:
GitHub measures an ~88.6% average reduction in clone time across
repositories using partial clone.

## src/mech/git/checkout.ts:253

The account that authorised this orchestrator is one, it is already connected,
and asking for it again in a yaml would be a second place to keep in step.

## src/mech/git/checkout.ts:263

Here, not per turn on the host: this used to be a host `symlinkSync` against
`/work`, a path that only exists inside the container, guarded by an
`existsSync` that made it a permanent no-op.

## src/mech/git/checkout.ts:277

a repository can arrange for a submodule's checkout to land a `post-checkout`
script where git then looks for hooks, and cloning it is remote code execution.
GitHub's own mitigation leads with *run git against untrusted sources inside
ephemeral, network-restricted containers*, which is what a group container
already is — so this is supported here, and never in the utility container,
which holds the real login and checks out nothing.

A repository with no `.gitmodules` pays one `test -f` and nothing else.

## src/mech/git/checkout.ts:312

This container holds the real GitHub token; RCE in a group container buys the
attacker what that agent already had, and RCE here buys the whole system.
`checkout`, `submodule` and anything else that writes a working tree are not on
the list.

`ls-tree` joined them at step 6, when the repo map lost its host checkout.
It reads names out of the object database and writes nothing anywhere —
the property that matters here is "never materialises a file", and it is
the reason this is a listing rather than a `checkout` plus a `find`.

## src/mech/git/checkout.ts:343

It used to return early whenever the directory existed, and `git clone --bare`
writes **no** `remote.origin.fetch` refspec — `--mirror` does, `--bare` does
not — so even a fetch by hand would have updated nothing. The mirror was
therefore frozen at the moment it was first cloned, and everything read off it
described the repository as it had been that day: the repo map, and the DRAFT
card's check for whether a path exists. A card naming a file added last week
came back "not in the repo", forever, on a project that had been working.

## src/mech/git/checkout.ts:367

how a mirror is laid out is this file's to know. […] leaving exactly the
invisible leftover that removing a project exists to prevent.

every commit in it is on the remote or in a container […] and a removal that
refuses to finish because a container is down would leave the boss with a
project they cannot get rid of.

## src/mech/git/checkout.ts:384

The repo map and the DRAFT card's path check used to read a checkout on the
host — the third job 007 §2 says that checkout was doing, after bundle
staging and the push channel. Those two moved at step 5; this is the third.

## src/mech/git/checkout.ts:396

It guessed in prose, permanently, and the guess named the utility container and
the GitHub login while the actual cause was neither.

That is worth a second return value rather than a better sentence: an
advisory that lists three possible causes is one the reader has to go and
check three of, which is the work the check existed to do for them.

[`origin/main`] is right for a worktree, where it is the remote-tracking ref.
It failed with

    git ls-tree origin/main exited 128: fatal: Not a valid object name origin/main

which is the repo map going permanently stale and saying so once a tick.

## src/mech/git/checkout.ts:416

a failed clone and a failed `ls-tree` both ended green, fifty lines from where
`treeHeads` had the same defect fixed.

## src/mech/git/checkout.ts:462

The index corpus was the third job the host checkout was doing (007 §2).

`summarise` reads the head of every tracked file to compute its signature —
that is the incremental check that makes the whole thing affordable.

## src/mech/git/checkout.ts:515

What used to receive this was a checkout on the host, which is the thing 007 is
removing; the receiver is now the one container that is allowed to hold a git
repository nobody works in.

## src/mech/git/checkout.ts:589

This is what makes a container disposable without the host holding anything:
a replaced container is `clone` plus `git checkout <branch>`, because the
branch is where every other feature branch lives. The stated cost is that
work-in-progress commits are visible on the remote before the PR opens, which
is how every feature branch already works.

[the lease] was rejected `(stale info)` on every branch that already existed.
Measured.

## src/mech/git/checkout.ts:624

`createCheckout` returns early when `.git` is already there, so this is one
cheap exec on the ordinary path.

All of them used to `return` silently, and the group then ran a whole turn
against an empty `/work` — RUNNING, an agent on the roster, nothing anywhere
reporting a problem. Same family as `reconcileOwnership`'s silent skip.
`executor.ts` already turns a thrown clone failure into a failed turn.

There were four; there are three. The fourth was "the host has no git", which
stopped being a way this can fail when the remote stopped being read out of a
host checkout.

## src/mech/sandbox/sandbox.ts:22

That is the whole point: decision 001 measured that the host sandbox is
deny-only, so "only this checkout is writable" was never expressible and every
path nobody thought to deny stayed writable. A container inverts it. […] hard
constraint 2 turned from the sandbox's only gap into its only interface.

See docs/adr/005 for what was measured, including the several places where
the observed behaviour contradicts that project's docs.

## src/mech/sandbox/sandbox.ts:34

The second is what makes local development and debugging work.

The reason for the rule at all: this image is where an agent runs, and an
agent runs with your code in front of it. Pointing the fleet at somebody
else's image hands over the whole boundary — and it is invisible, because a
container built from a hostile image behaves exactly like one that is not.

Refused rather than corrected. A project that names an image we will not run
is a project whose owner meant something, and quietly substituting a different
one is worse than saying no.

## src/mech/sandbox/sandbox.ts:49

the sandbox server pulls what it can pull, and nothing can pull a bare tag.

## src/mech/sandbox/sandbox.ts:70

`opensandbox-server` is Linux-only — its egress mode is `dns+nft` — so on a
Windows machine it runs under WSL, next to the Docker Desktop daemon.

Both end with every skill the boss ticked silently absent, which is this
project's oldest failure shape.

A path that is already absolute-POSIX is somebody who has thought about this,
and a UNC path (`\\wsl$\...`) is one the daemon cannot use either way.

## src/mech/sandbox/sandbox.ts:97

Two layers now, narrowest first: this project, then the machine's answer.
That second one used to be three — a `sandbox_image` row read here, with the
yaml under it — and it is one since the settings table holds every config
path: `cfg.sandbox.image` already *is* the row when there is one and the
shipped default when there is not.

## src/mech/sandbox/sandbox.ts:113

Generating one here and asking the boss to copy it into the server's file is
how a whole night went: the panel had a key, the server had another, and every
turn, gate and diff came back 401 as "Authentication credentials are invalid",
which reads as a model problem.

## src/mech/sandbox/sandbox.ts:191

Measured the hard way: a shell whose argv contained
`pkill -f opensandbox-server` was matched as the server itself, so the caller
reported "already running" and never started one — on a machine with no server
at all.

## src/mech/sandbox/sandbox.ts:207

No subprocess, no allocation: the whole check is one `kill(2)`, against the
30.6ms `runningServer()` spends forking `ps`.

There is no library for this. The maintained ones (`ps-list`, `find-process`)
enumerate processes and therefore fork `ps` themselves; the ones that check a
single pid (`is-running` 2016, `process-exists` 2021, `ps-node` 2017) are
abandoned wrappers around exactly the two lines below.

## src/mech/sandbox/sandbox.ts:228

Measured the hard way: a shell whose argv contained
`pkill -f opensandbox-server` was matched as the server itself, and the
caller then reported "already running" and never started one. Anything
that mentions it as an *argument* — pkill, grep, kill, an editor, a
terminal title — is a process talking about the server, not the server.

## src/mech/sandbox/sandbox.ts:298

That is why the deliberate one is a button with hard constraint 5's evidence
beside it, and the automatic one below is narrow.

## src/mech/sandbox/sandbox.ts:383

`util` is the third, and it is not a sandbox in the 005 sense. 007 narrows
that decision by one word: **the boundary is a container that runs an agent**.
[…] it is a peer of the server that happens not to occupy the host's PATH.
One per orchestrator, not per project: what it holds is the login, and there is
one of those.

## src/mech/sandbox/sandbox.ts:462

Preflight reports all three — and only as a console warning, so the fleet still
finds out the expensive way: every group dispatches, `ensureSandbox` throws, the
turn fails, the watchdog requeues it once and then files a blocker. Ten
groups, ten blockers, one fact.

[Short] because a failure that was actually about one project's config should
not hold everyone for long.

## src/mech/sandbox/sandbox.ts:533

[`sandbox.create`,] whose span measures 34s at p50 — so until this one
existed the cost of the failed attempt was charged to the creation it
caused, and nothing said a reconnect had been tried at all.

## src/mech/sandbox/sandbox.ts:663

Folded together — or worse, folded into the checkpoint that happens to call
this first — the boss sees "the checkpoint took four minutes" and learns
nothing.

[Neither span opens on the warm path:] a reconnect built nothing and filled
nothing, and a zero-duration span every turn would bury the cold ones.

## src/mech/sandbox/sandbox.ts:740

007 step 7: the ChatGPT login was the last thing that needed a binary on the
boss's own machine, and codex is already in the agent image because turns run
`codex exec`. So the weekly renewal runs where every other credential already
lives, and a host with docker and a pasted token needs nothing else.

## src/mech/sandbox/sandbox.ts:774

Measured on this machine: `/var/tmp/orch-cache/skills` holds 179 skills,
`docker run -v` on that exact path sees 0, and inside the container the mount
shows as an overlay with `lowerdir=/` rather than the host directory.

So every agent ran with no skills at all, `skillMounts` returned two correct
mounts, creation succeeded, the degrade path never fired, and preflight
reported "179 staged" — because it counts them on the host, which is the one
place they definitely are. Nothing anywhere was wrong.

## src/mech/sandbox/sandbox.ts:819

The one previous attempt at repo skills linked into it and got `EROFS`,
swallowed by a `; true`, so the feature reported success and delivered nothing.

## src/mech/sandbox/sandbox.ts:829

[the listing reaching the host] is the half that has been missing since
`repo_path` became `owner/name` and the checkout stopped existing on this
machine.

parsing a block scalar in `sh` is the version of this that is wrong in a way
nobody notices.

## src/mech/sandbox/sandbox.ts:855

Measured against the two binaries in `orch/agent:1` (`claude 2.1.232`,
`codex-cli 0.147.0`), by counting the paths each one actually contains:

  claude   .claude/skills 93   .codex/skills 0   .agents/skills 0
  codex    .codex/skills  3    .claude/skills 0  .agents/skills 0

and codex's three are all one sentence — *"I will place it in
`$CODEX_HOME/skills` (or `~/.codex/skills` when `CODEX_HOME` is unset)"*.
The delivery matrix that leaves:

  repo ships .claude/skills   claude: native   codex: nothing
  repo ships .codex/skills    claude: nothing  codex: nothing
  repo ships .agents/skills   claude: nothing  codex: nothing

Two of the three conventions reached nobody, and the third reached one of two
runtimes. The old comment in `skills.ts` had `.codex/skills` down as codex's
project path; it is its home path, and that one word is the whole reason this
looked delivered.

Symlinks rather than copies: codex has a `skills_watcher`, both directories on
a real machine are already symlink farms, and a link costs nothing to redo.

`.claude/skills` is deliberately **not** linked into claude's own directory:
claude already reads it from the checkout, and a second entry would bill the
same skill's name and description twice on every turn of that session.

[Never fails its caller.] It is folded into the checkout probe […] — the
old `; true` was wrong because it hid a real error, not because it degraded.

## src/mech/sandbox/sandbox.ts:981

`projectSkills` serves a repository's skills from a cache only `SKILL_SYNC`
can write, because `repo_path` is `owner/name` and the checkout exists only
inside a container. That cache was refreshed on a turn's checkout probe and
nowhere else, so 重新扫描 — the one control whose entire purpose is "something
changed outside this process" — could not touch half of what it listed.

[the project's own container first because] that is the state a stale entry
sits in longest — asking only its groups asks nobody. The indexer clones into
the project container (`indexHeads` → `createCheckout({ project })`), so a
checkout is there whether or not any group exists.

[`sandbox.create`,] measured at ~34s p50. A container that has gone away
answers null and the next scope is tried; the first checkout that answers
wins, so the usual cost is one reconnect. Serial for the same reason — the
answer is the same from any of them, and a fan-out would pay for every
container to agree.

[Null means nobody could answer] — `cacheProjectSkills` writes an empty list as
a real answer, so the caller must not turn silence into one.

## src/mech/sandbox/sandbox.ts:1006

Live, from the boss's terminal:

  error: The socket connection was closed unexpectedly.
    path: "http://127.0.0.1:51394/proxy/44772/files/upload", code: "ECONNRESET"

No stack, because nothing was awaiting it — and bun treats an unhandled
rejection as fatal, so one flaky local socket to one container took the whole
fleet down. The backstop in `server.ts` is what stops that being fatal; this is
what stops it happening.

Fixing it at the four call sites instead would leave the fifth one somebody
adds next month.

## src/mech/sandbox/sandbox.ts:1065

[a trailing wildcard is] the shape the upstream guide suggests,
`/owner/repo.git` plus a star — [and] is useless here, because a prefix does
not stop at `/`.

## src/mech/sandbox/sandbox.ts:1130

Measured against the running server, twice, because the consequence is
enormous and the shape is not documented anywhere:

  printf 'a\nbb\nccc\n'   ->  ["a", "bb", "ccc"]      three messages, no "\n"
  printf 'a\nb'             ->  ["a", "b"]              a partial last line is not marked
  printf 'a\n\n\nb\n'      ->  ["a", "\n", "\n", "b"]  a blank line arrives AS "\n"
  printf '1%\r42%\rdone\n' ->  ["1%", "42%", "done"]   a CR splits too, and is eaten
  300 KB with no newline    ->  one message                a long line is never split

`join("")` therefore ran every line together. `git status --porcelain` came
back as one string, `ls` came back as one string, and **every caller that
splits `out` on newlines was reading a single line** — which does not throw,
does not warn, and mostly yields "nothing matched". That is the shape this
codebase keeps paying for: a wrong answer that looks like an empty one. It
surfaced because a skills inventory of two lines came back as one.

The last row is what makes `join("\n")` safe rather than a guess: the server
splits on line boundaries and nothing else, so one message is never half a
line. The blank-line row is why each message is stripped first — a bare "\n"
joined with another "\n" would double every blank line in a diff.

## src/mech/sandbox/sandbox.ts:1177

`Promise.withResolvers()` is the platform's answer to the thing this used to
be: a nullable `let` that the executor of a `new Promise` reached out and
assigned, cleared again after every await.

## src/mech/sandbox/sandbox.ts:1407

Every caller reads `.code` — `sandboxGit`, `resourceExec`, and through the
first, every helper in `worktree.ts`.

The consequence was not a wrong answer, it was a **stopped agent**. A lease
whose exec rejected skipped `finishLease`, which is the only thing that
resolves `ctx.waiters.get('lease:N')` — so the route awaited a promise with no
timeout while the agent's `orch` polled a reply that would never be written.
The guard for exactly this (`126: the gate could not run`) could not fire,
because reaching it required a return. Every way to get there is ordinary: a
TTL reap, Docker restarting, the 60s hold expiring mid-gate.

The hold is still set by `ensureSandbox` on its way through, so the fleet still
stops dispatching — this only changes what the call already in flight gets
back.

## src/mech/sandbox/sandbox.ts:1417

[a NULL `project_id`] is the defect `turnScope` had. One primary-key lookup
against a round trip measured at ~1s.

## src/mech/sandbox/sandbox.ts:1455

[…] and `maxGroups` can be raised from the panel while the server runs.

The throughput this costs is small and measured against the two callers: the
skill relink is a settings click and the session sweep is hourly against a
seven-day window. Both are round-trip overhead rather than work, and the sweep
is disk-bound on a host with one disk queue, so ten at once was never ten
times faster than four.

## src/mech/sandbox/sandbox.ts:776

[only when the host directory has something in it:] a boss who has ticked no
skills gets no noise.

## src/mech/sandbox/sandbox.ts:856

[Never fails its caller:] a container whose skills did not link should still run
its turn.

## src/mech/sandbox/sandbox.ts:1404

Here, not in `realExec`, so the fake driver's failures land the same way.

## src/mech/ops/watchdog.ts:68

`ps -Ao` measured at 30.6ms a call, which a CPU profile of sixty ticks
attributed 92% of all samples to.

## src/mech/ops/watchdog.ts:160

365 files had grown to 59 MB.

## src/mech/ops/watchdog.ts:189

Nothing ever removed them: 78 rollout files and 110 MB in two days, next to a
turn-log directory that has had gzip and a retention window since the
beginning.

The 110 MB grows in the sandboxes, and `sweepSandboxSessions` below is what
reaches it.

## src/mech/ops/watchdog.ts:331

The fleet's own rollouts live in the sandboxes now; the host copy is only as
fresh as the last weekly refresh nudge.

## src/mech/ops/watchdog.ts:347

That is what happened: `Bun.spawn` throws when `cwd` does not exist,
`repo_path` stopped being a directory, and the tick died at the first project
row.

The silence was the other half. `Scheduler.settle` writes `state='failed'` on
the job row and emits nothing, and the server enqueues a fresh tick regardless
— so it failed every thirty seconds with nothing anywhere saying so.

The throw itself is fixed at its source (`makeGitRunner` returns a code now).

## src/mech/ops/watchdog.ts:361

[without `emit`] the guard written because the watchdog died silently would
otherwise make it die loudly — 120 blocker lines an hour — which is the same
dedup bug this file fixed in three other places.

## src/mech/ops/watchdog.ts:384

The tick is straight-line async, so before this a `throw` anywhere skipped
every rule after it — and `invariants.ts` names the watchdog as the `driver`
for about twelve states, so one bad rule meant twelve drivers silent for
thirty seconds with nothing saying which one broke.

[dedup] a rule that throws every tick reports twice an hour rather than 120
times.

[the span] is also the answer to a question the panel could not previously
answer: the tick reported a p50 of 50s as a single number, and "which rule"
was a guess. A rule that reaches into a container or asks GitHub costs a round
trip; one that reads a table costs nothing; and only the spans say which is
which.

## src/mech/ops/watchdog.ts:398

This replaces a module-level `lastSweep` and a hand-written
`now() - lastSweep >= SWEEP_EVERY_MS`, which was invariant 11's mutable
singleton and — being process memory — reset on every restart and was shared
between two watchdogs if ever two ran at once.

## src/mech/ops/watchdog.ts:425

The id is the number the codebase has always used — ADR 007 cites "rule 15"
four times, two production comments cite "rule 6" — so renumbering would
invalidate written decisions to no benefit. The name is what the panel
shows: a span reading `watchdog.7d2` answers nobody's question, and the number
was never going to grow into an answer.

The table would have to thread `ctx`, `cfg`, `now`, `t` and `findings` through
twenty-four closures to gain enumeration we have no reader for yet; this gets
the readable span, the per-rule cadence, and the pairing of id to name.

## src/mech/ops/watchdog.ts:748

Ten requirements produced 123 MB of raw NDJSON, median 324 KB a turn and 3 MB
at the tail, because a turn's transcript is mostly tool output and all of it is
written verbatim. […] NDJSON gzips about ten to one, and nothing reads a turn
from a week ago without unzipping it first anyway.

## src/mech/ops/watchdog.ts:755

The first version ran one `execIn` per live sandbox on every 30s tick,
serially: `commands.run` is ~1s, so ten groups meant ten seconds of every
thirty spent deleting nothing, competing with the agents for the CPU their own
containers are capped at.

The hour is now `HOURLY` […] rather than a module-level `lastSweep` this body
checked itself.

## src/mech/ops/watchdog.ts:770

`test/watchdog.test.ts` ran it for real: the endpoint hung on its
10s timeout inside a gate sandbox, the test blew bun's 5s limit, and the
slice was rejected for a red test that had nothing to do with its change.
Two slices lost to it, on two different requirements.

## src/mech/ops/watchdog.ts:792

This used to name two possible causes in prose — the utility container, or the
GitHub login — […] it was wrong in the first case anyone hit, and being wrong
it sent the reader to check two things that were both fine.

## src/mech/ops/watchdog.ts:832

[the group] stays RUNNING, its slice stays `running`, `startNextSlice` counts
it busy, and the desk wall reads 在跑 0 with no error anywhere. A
`claude --settings` path bug took six groups down this way; a Dispatcher that
finished without filing a card left a seventh in PLANNING the same afternoon.

## src/mech/ops/watchdog.ts:849

Reading the flag alone turned every successful rebase into a
design escalation the moment the queue went quiet: pm-ai-agent got the same
"The Engineer could not rebase this branch onto main" eight times, all eight
false, and its Architect burned a turn refuting each one.

## src/mech/ops/watchdog.ts:992

[a group that waited long enough to be parked] stayed parked even once the
boss answered the very thing it was waiting for — the boss answers, and
watches nothing happen. […] 唤醒 is a button and nothing else.

## src/mech/ops/watchdog.ts:1034

DISSOLVED means the work is either merged or dropped, so nothing in there is
wanted; what is left is memory, CPU and disk held against every group that
comes next.

## src/mech/ops/watchdog.ts:1055

[exactly one of the two ways to store a credential killed the sandboxes.]
A login from the panel saved the token and stopped, so every group kept a
sidecar bound to the credential that was still missing and every turn came
back `Authentication credentials are invalid` against a token that was
perfectly good.

## src/mech/ops/watchdog.ts:1098

This walked `grp` only, and the project containers had to be added when the
index moved into one.

## src/mech/ops/watchdog.ts:1121

Three states look identical from the panel and want three different answers:
**absent** (restart it), **present but refusing** — a bad key, a crash loop —
where a restart only makes a restart loop, and **present and healthy on stale
config**, which is not a restart problem at all and is reported by preflight's
`allowed_host_paths` check.

How the boss starts it (uvx, a venv, a wrapper, extra flags) is theirs, and a
composed command line would start a second, differently-configured server
beside the wedged one. Never seen it up means we say nothing — preflight
already reports a server that is not there, and guessing is worse than
reporting.

## src/mech/ops/watchdog.ts:1161

Live: src-mech-watchdog-ts had an open blocker and a merge-ready PR on the same
requirement, in the same list.

## src/mech/ops/watchdog.ts:1200

[emitting every time] filled the timeline with the same line dozens of times
over — "perf-rewrite is at 102% of its budget", every few seconds, until the
feed was worthless.

leaving it unfiltered meant the timeline was deduplicated while the
notifications were not — one stalled group produced a push every thirty
seconds, all night.

## src/mech/ops/watchdog.ts:1236

the park timer files it away and the boss finds a fleet to restart by hand once
the connection is back.

That is the whole of "pause" and "resume": no new state, nothing to remember.

## web/src/features/telemetry/model.ts:25

The server sends `turn;turn.provider` with a total, which is the format
flamegraphs have taken since the original Perl ones; this is the one place
that turns it back into `{name, value, children}`. Doing it here rather than
in SQL is deliberate — it is a reshaping of rows the browser already holds,
not a reduction, and it is the part worth having a unit test on.

## web/src/features/telemetry/model.ts:69

Three outcomes, and the middle one exists because of a bug this shipped with.
The first version had two: name the slow stages when the fold found a gap, and
otherwise assert 「各阶段耗时接近，没有特别慢的。」 That second branch was
false on real data and the table under it said so — `splitStages` cuts at the
largest *adjacent* ratio, so a smooth ramp from 41.9s down to 8.7s has no
single fourfold step in it and folded nothing, while being a fivefold spread
end to end. The page asserted an absence its own rows contradicted one line
below, which is worse than having no summary at all.

["the slowest of one thing" is not a finding, and] a sentence reading
「是第二名的 1.0 倍」 is noise dressed as a result.

## web/src/features/telemetry/model.ts:115

The boss runs a company. `sandbox.create`, `GET /api/v1/auth/github` and
`watchdog.repo_map` are instrumentation keys — the names the code calls
itself — and a page built out of them asks the reader to be a debugger before
it will tell them where four hours went. `ui.md` sets the register: 「白干的
单位」, 「去合并 PR」. This is that rule applied to the one place the interface
was still speaking to the compiler.

[a pattern's] first one it got wrong would be indistinguishable from a name
somebody chose.

[the raw identifier is reachable] on hover in the aggregate views, and plainly
in the waterfall, which is the drill-down somebody debugging is already in.

## web/src/features/telemetry/model.ts:154

The set of names grows every hour — `github.request`, `index.ask`, `lease.run`,
`gate.run`, `pr.poll`, `sandbox.reconnect` all landed today.

## web/src/features/telemetry/model.ts:244

Eleven rows at equal weight is eleven rows nobody reads, and it is what the
data looks like when two stages take seconds and the other nine take under a
handful of milliseconds. Those nine are not an answer to "is anything slow",
they are the absence of one, and `docs/design/ui.md` is explicit that absence
gets a sentence rather than equal billing.

## web/src/features/telemetry/model.ts:278

Its own function because it is policy rather than event handling, and it was
six branches inlined in a `Brush` callback where nothing could reach it.

## web/src/features/telemetry/model.ts:307

Every profiler does this — DevTools, Grafana, speedscope — and the reason is
that the frame you are pointing at stays under the pointer while everything
else spreads away from it.

## web/src/features/telemetry/model.ts:367

Three lines lifted from `d3-zoom`'s `wheelDelta`, not the package: it is not
installed, `d3-flame-graph` brings seventeen d3 subpackages and not that one,
and its last publish is 2022 — and what we would use of it is these three
lines, since the drag-pan, scale extents and transition interpolation are all
things this does not need and `zoomAt` already clamps.

A Chrome mouse click at `deltaY: 100` becomes a 13% step; a trackpad's
`deltaY: 3` becomes 0.4%. Same formula, no branch.

[`ctrlKey`:] browsers set it on a trackpad pinch, the one gesture
distinguishable from a two-finger scroll, and ×10 is what makes it feel like
one.

## web/src/features/telemetry/model.ts:415

one `<path>` per series, so a day at one-minute buckets is 1,440 line segments
and costs nothing worth measuring.

## web/src/features/telemetry/model.ts:425

[this is] the whole fix for 「选其他的单位渲染不出东西」. There is no honest way
to *draw* 1,440 points when only 81 fit.

## web/src/features/telemetry/model.ts:451

[the end it is taken from] is where this was wrong. It was capped at
`MAX_BUCKETS * 2` counted *forward* from `window.from`, on the stated
assumption that a window needing more had already been given a wider bucket.
True while the bucket is derived; false the moment the reader pins one, which
is the only reason the picker exists. Pinning a minute on a day therefore drew
the first eighty minutes of twenty-four hours — a stretch that on a fleet
started this morning has no rows in it at all, so the chart went blank and the
control looked broken.

## web/src/features/telemetry/model.ts:479

[the bucket deciding precision] is the half this was missing — the minutes were
hardcoded to `:00`, so pinning a fifteen-minute bucket labelled four
consecutive points `02:00` and the axis claimed the same instant four times.

## web/src/features/telemetry/model.ts:116

The raw identifier stays reachable everywhere it is replaced.

## web/src/features/telemetry/model.ts:365

`ctrlKey` is the trackpad pinch.

## web/src/features/telemetry/view.tsx:45

The waterfall and the trend are `recharts` […] so they cost nothing new: a
Gantt is a stacked bar with a transparent first segment. The flamegraph is
`d3-flame-graph`, 22KB, which is the one thing here that is genuinely somebody
else's algorithm — partitioning a hierarchy into frames and zooming into one.
`@grafana/flamegraph` was measured at 6.16MB and a second React instance for
the same picture, and is not here.

[render states:] empty, one trace, deep nesting, a failed span.

The accent appears once in this feature and nowhere else: on a frame the
reader searched for by name. `ui.md` reserves it for "needs you", and a frame
somebody just asked for is the nearest a timing view comes to that. Failure is
`bad`, the same vocabulary a failed gate uses.

The flamegraph is the one place on this page with more than one hue, and it
earns them: a frame's colour is the only thing saying "this is the same
function you saw two levels up", which is why `setColorMapper` replaces the
library's palette rather than removing colour from it. There is no orange —
the classic flamegraph ramp is exactly the category reflex `ui.md` refuses —
and no hue that `ui.md` has already given a job to.

## web/src/features/telemetry/view.tsx:72

They were 3.5rem/3.5rem/3rem, sized for the widest duration anybody imagined,
and in the right-hand column of a split that left the name column too narrow to
hold a name — every one of 巡检…, 代码…, 容器…, 接口…, prefl…, 合并… was an
ellipsis, so the column saying *what* was the one column that could not be read
while three numeric ones sat at full width.

## web/src/features/telemetry/view.tsx:82

one at `text-ink-3` and `0.75rem` where the others were `font-medium` at
`0.8125rem`, and the flamegraph's had no rule at all.

[blocks sized by contents:] a 7.5rem chart beside a 380px table beside a
flamegraph as tall as its tree.

## web/src/features/telemetry/view.tsx:93

The stage table's heading read 每一段花了多久 directly above columns of names
and durations, which is the same fact twice — and deleting it was faster than
finding better words for it.

## web/src/features/telemetry/view.tsx:110

[the anchor was] about 40px to the left of where the reader was pointing, which
is 11% of a half-width column: the trend drifted under the cursor while the
flamegraph stayed put, and that difference between two charts on the same page
is what got reported.

## web/src/features/telemetry/view.tsx:124

It used to read every wheel as a zoom at a fixed 1.2 per event, which on a
trackpad is fifty events per gesture and three orders of magnitude in a flick:
"太灵敏" was an accurate description of multiplying by 1.2 fifty times.

## web/src/features/telemetry/view.tsx:171

[the lookup is] guarded by `typeof record[name] === "function"` […] and the
only module in the library that named `scalePoint` was `cartesian/Brush.js`.
Deleting an unused `<Brush>` from this file therefore deleted a function the
live chart resolves, leaving the export record pointing at a binding that no
longer existed: `scalePoint:()=>ij0` with no `ij0` anywhere. Reading the
property throws, so 耗时 died on mount with a minified name as its only
evidence.

Two other fixes were tried and are worth recording, because both look
plausible and neither works. Passing the instance through `scale={...}`
bypasses the library's own axis setup: the axis came back with no ticks and
the area started a fifth of the way across the plot. Making the x axis
numeric — which it now is, and for better reasons — does not remove the
lookup either; `test/governance/bundle-boots.test.ts` still reproduced the
crash against a bundle built that way.

## web/src/features/telemetry/view.tsx:188

A menu rather than the segmented strip it was. Seven segments — 跟随 plus six
widths — do not fit the half-width column this sits in, so every label broke
mid-word into two lines (`1 分` over `钟`) and the strip took three rows under
the chart. A strip is the right shape for two or three choices that are worth
seeing at once; six units of time are a list, and a list belongs behind one
click with the current one named on the trigger.

## web/src/features/telemetry/view.tsx:233

speedscope's minimap at the smallest size that answers the question. Both
charts on this page zoom, so both need one, and they had different answers —
the flamegraph had this and the trend had a `recharts` `Brush`.

「底下的 bar 没任何用，没有随着滚动同步」 is a precise description of a control
whose only possible state is "all of it".

[Shown only once there is something to be lost,] which is Grafana's restraint
and the same rule the reset button follows: no control on screen until there
is state to undo.

## web/src/features/telemetry/view.tsx:350

Not p50 and p95. Those are the names of the statistics; these are what
the reader wanted to know, and nobody has to have read a percentile
to use them.

This was left empty on the argument that a column of `开一个新环境`
and `连 GitHub` does not need to be told it holds names. True about
the *values*, wrong about the *row* […] and the blank sat at the left edge
where a header row starts, so it was the first thing the eye hit.

## web/src/features/telemetry/view.tsx:365

A flat column put 24 watchdog rules, six routes and four container
operations in one list sorted only by time, with unrelated kinds
interleaved and names truncated mid-word.

[a list would have dropped each of them into nothing:] six new span families
landed in one afternoon.

## web/src/features/telemetry/view.tsx:421

There was one under every row, and it was the same mistake the
flamegraph made in its own way: a mark drawn before anybody decided
what it encoded. […] neither explained the other. The fold above […]
answers "which of these is the big one" by leaving nine rows out rather
than by drawing eleven widths. Two or three rows of numbers compare fine on
their own.

## web/src/features/telemetry/view.tsx:447

Truncation was cutting identifiers mid-word — `GET /api/v1/san…` names
nothing.

## web/src/features/telemetry/view.tsx:532

20px against Grafana's 22. The reference is right that a flamegraph wants
compact rows — the whole value of the view is seeing depth at a glance, and
every pixel of row height is a level that fell off the bottom — and this page
is denser than Grafana everywhere else, so matching its number exactly would
make the one chart on the page the loosest thing on it.

## web/src/features/telemetry/view.tsx:538

27 is a failed gate, 74 is a warning, 156 is a passed gate, 285 is "needs you".

Grafana varies hue by frame identity for exactly that reason. The grey ramp
this replaces encoded nothing at all — a chart where every mark is the same
colour is a chart carrying one variable, and this one has two.

## web/src/features/telemetry/view.tsx:563

`d3-flame-graph`'s default is the hot-orange palette every flamegraph has, and
`docs/design/ui.md` is explicit that the category reflex is the thing to
refuse: this page is warm paper read in daylight beside an editor, and an
orange chart in it would be the one element that belongs to another product.

`--color-paper` is 0.985 in light and 0.185 in dark, so a frame lands at
roughly 0.73 on paper and 0.49 in the dark — always moving toward the ground
the page is already drawing on. `ui.md` says the dark variant is the same
design in dark ink, and this is what that means for a chart. Fixed OKLCH
literals were the previous version's bug in the other direction: a frame that
stayed mid while the page flipped, with a label on it that went from readable
to invisible.

[chroma:] `paper` is a near-neutral (chroma 0.005), so mixing toward it pulls
chroma down exactly as lightness approaches either extreme — which is the
rule, and it holds here because the mix does it rather than because a formula
remembered to.

A searched frame takes the accent, and that is the one place the accent
appears in this feature: `ui.md` reserves it for "needs you", and a frame the
reader has just asked for by name is as close to that as a timing view gets.

## web/src/features/telemetry/view.tsx:574

That is the same bargain every flamegraph palette makes, Grafana's included.
What is checked is the case that would be visible: the sibling pairs this fleet
actually produces all come out distinct.

## web/src/features/telemetry/view.tsx:589

[React has registered wheel listeners passively] since React 17, deliberately,
so that scrolling cannot be blocked by a slow handler. Both charts here had
that call and it had never taken effect. The zoom worked anyway, because
zooming does not need the default suppressed; what needed it was everything
the browser does *instead*.

A two-finger horizontal swipe over a chart is a pan to the reader and a
history navigation to macOS, and losing the page mid-gesture is the worst
outcome available — the panel state, the zoom and the window all go with it.

## web/src/features/telemetry/view.tsx:611

Extracted because this is the part that is easy to get wrong and it had been,
twice: once by clearing the container instead of calling `destroy`, and once
by measuring the element the zoom had already scaled. Four effects that only
ever talk to a library instance, sitting in the same function as a minimap and
a breadcrumb, is a component where neither half can be read on its own.

[the detached-node leak] is the leak this library is known for.

[toggling `selfValue`] on a live chart leaves the old widths in place.

## web/src/features/telemetry/view.tsx:650

measuring `host` measures viewport ÷ zoom — which was then divided by zoom a
second time, giving viewport ÷ zoom². And because the observer watched the
scaled element, setting the width resized what was being measured: a feedback
loop that left the frames occupying a fraction of a wrapper several times too
wide, with the minimap disagreeing with the screen.

## web/src/features/telemetry/view.tsx:667

Opening 设置 from 耗时 does it: Radix locks body scroll, the scrollbar goes,
the pane gains its width back, the observer fires — and the flamegraph blinks.

## web/src/features/telemetry/view.tsx:706

It wrote `search: 0 of 11271164.521939998 total samples ( 0.000%)` […]
English, fifteen decimal places, and "samples" for something this page calls
耗时.

## web/src/features/telemetry/view.tsx:719

[every wheel notch on the trend re-reads the endpoint, so a new `flame` array
arrived on each one] — 「一移动每次运行的耗时图表的位置，下面 flamegraph 就会闪
一下」.

The size itself comes off a ref for that reason — a dependency would put the
rebuild back, and the argument with the linter with it.

## web/src/features/telemetry/view.tsx:734

It used to be handed the reader's *search term*, and after that term grew to
match kind labels as well, selecting 巡检规则 sent the library a Chinese
label its frames have never carried: `search: 0 of 11271164.5 total samples`.

## web/src/features/telemetry/view.tsx:750

That is the outcome we want (they are `#eee` strokes, `Verdana`, a black
tooltip and the hot-orange palette, none of which belong on warm paper).

Untouched [the label] inherits the page's `ink` on top of an `ink`-coloured
frame, which is the colour on itself.

## web/src/features/telemetry/view.tsx:847

the question a flamegraph is opened to answer — "which frame is the one
burning the wall clock" — is the self-time reading.

Frames too narrow to see are dropped by `minFrameSize`, so depth costs rows
rather than nodes.

## web/src/features/telemetry/view.tsx:863

This one drew its own heading with no rule under it while the three around it
had one, which is the drift that comment three hundred lines up was written
about and then reproduced.

## web/src/features/telemetry/view.tsx:935

The test used to be `trend.length < 2` — a count of rows the endpoint found
anywhere in its own window.

## web/src/features/telemetry/view.tsx:941

It sat at the top of the section reading like the whole view's empty state,
stacked on a stage table that had data in it — one chart having nothing yet
said as "nothing here yet".

## web/src/features/telemetry/view.tsx:965

And it is what stops `scalePoint` from being needed at all.
`recharts` resolves a scale by string — `"scale" + type` looked up
on the `d3-scale` namespace — so a category axis depended on
something else in the graph importing `scalePoint` statically, which
until this file dropped its `Brush` was `recharts`' own Brush module.
Handing the instance over instead was tried and is worse: it bypasses the
library's own category setup, and the axis came back with no ticks and a curve
starting a fifth of the way in.

## web/src/features/telemetry/view.tsx:1018

`telemetry.ts:186` echoes the query's own `from`/`to` straight back […] From
there `zoomAt` clamped every widening to the span it already had and
`panBy` clamped every slide to zero: scrolling back out did nothing, and a
horizontal swipe did nothing, which is exactly how it was reported. The two
symptoms were one bug wearing two coats.

## web/src/features/telemetry/view.tsx:1039

The hand-written version was already right about the race — it carried a
`live` flag and dropped a reply the reader had moved on from. What it could
not do is remember: every remount, and every trip back to a scope, paid for
the read again from a blank pane.

[returning `null`] would blank a correct stage list because a trace aged out,
which is the page punishing the reader for clicking.

## web/src/features/telemetry/view.tsx:1075

[On `Telemetry`:]
Two views of the same spans, and they answer different questions rather than
being two skins on one. The **flamegraph** is the aggregate: every run in the
scope folded together, so it says where the time goes. The **waterfall** is
one trace: what happened, in what order, and what was waiting on what. A
project asks the first question and a single requirement usually asks the
second, but both are on every surface, because "this project is slow" and
"this run was slow" are asked from the same page ten seconds apart.

The heading is the caller's: the same block is a tab panel in two places and a
section of a longer page in the third, and a heading inside a tab repeats the
tab's own label.

[On `TrendBlock`:] Rendering them from `Telemetry` put its own cognitive
complexity over the threshold — 16 against 15 — and the branches it was
counting were all about the window rather than about the page.

## web/src/features/telemetry/view.tsx:1138

[`Telemetry`'s] cognitive complexity was over the threshold and every branch
this hook takes with it was about a set of names rather than about the page.

## web/src/features/telemetry/view.tsx:1146

[a search string] is why the flamegraph never lit up. The selection used to be
the text somebody typed, and `spanMatches` was widened so that clicking 巡检规则
would mark every `watchdog.*` row — but […] it was handed a kind label that
matched none of them and reported `search: 0 of 11271164.5 total samples`.

## web/src/features/telemetry/view.tsx:1181

It was a duration in milliseconds and could only ever shorten from `now`.

## web/src/features/telemetry/view.tsx:1203

[the two windows] disagree completely on stored data whose newest row is older
than N.

## web/src/features/telemetry/view.tsx:1211

[in an empty stretch] the reader gets a blank chart and no way to tell
「这段时间没有活动」 from 「你已经滑出头了」 — which is what 「不让滚动到那个
档」 was asking for.

[using `report.window`] made every clamp in `zoomAt`/`panBy` a no-op.

## web/src/features/telemetry/view.tsx:1231

Everything that stood between them — the heading, the answer sentence, the run
picker, the search box and the single-run waterfall — is deleted, and the
deletion is the point: each of them restated something the four blocks below
already show. The sentence was the clearest case, being a correct summary of a
table sitting two inches under it.

## web/src/features/telemetry/view.tsx:1270

The axis a boss reading a requirement already has in their head — slice 1
sailed through, slice 3 has burned an hour.

[a share of one total] is exactly what the stage table's bar could not claim
and why that one was cut.

## web/src/features/telemetry/view.tsx:1344

It was a shut accordion at the bottom of the landing page, under the queue and
the requirement tracks — a section about the panel's own wall clock, on the
page that answers 谁在等我. Nothing about it belonged there: it is not waiting
on the boss, it is not a requirement. […] 设置 [is] the one surface nobody is
ever *in*, that you come to, fix something, and leave.

## web/src/features/telemetry/view.tsx:606

[re-creates on a shape change] because `selfValue` is read when frames are laid
out.

## src/mech/ops/watchdog.ts:806

a regex did not care where a file was cut, a parser does […] measured at 43 of
494 files here, [and] there is always a last construct.

[a paths-only map is] not a silent one: the count is in the line below.
