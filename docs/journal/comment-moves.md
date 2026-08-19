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

## src/platform/config/load.ts:16

Measured off the two installations rather than assumed: `claude --help` offers
`--effort (low, medium, high, xhigh, max)`, and every entry in codex's
`models_cache.json` lists the same five under `supported_reasoning_levels`.

## src/platform/config/load.ts:38

Measured: tool results are 90% of everything in a transcript. […] One cap for
both has to be the engineer's, and the reviewers spend it.

## src/platform/config/load.ts:75

This used to be a hand-written `type Config = { ... }` of twenty-six fields
beside a `ConfigSchema` of the same twenty-six, kept in step by whoever
remembered. Nothing checked that they agreed.

The field comments moved there with it: they are the expensive part, every
number is a measurement somebody paid for, and they are still what an editor
shows on hover.

## src/platform/config/load.ts:89

This was the shipped yaml's value while the code default said 2 — the file is
what has been running, so it wins.

## src/platform/config/load.ts:101

models_cache.json records `gpt-5.4 -> terra` and `gpt-5.4-mini -> luna` as its
own upgrade path, and sol is the flagship.

## src/platform/config/load.ts:108

20 minutes. The code default said 10 while the shipped yaml said 20, so
every install has been running 20 and nothing has been running 10.

## src/platform/config/load.ts:120

Accepting a slice was what started the next one, so with this off a group did
exactly one slice and then waited until morning — which defeats the reason the
system exists.

[postSliceDecision pauses the group] rather than quietly fixing the foundation
under finished work.

## src/platform/config/load.ts:125

The code default said `["trivial"]` and the shipped yaml said
`["trivial", "normal"]`, with a comment under each explaining why its own
answer was the careful one. The yaml is the one that has been running, and
two files arguing in comments is worse than either answer.

## src/platform/config/load.ts:129

Measured over the 16 slices in this checkout that spent anything: trivial
averaged 4.0M with one 12.0M runaway, normal averaged 7.3M with a 16.1M tail,
the single hard slice took 4.0M.

## src/platform/config/load.ts:156

Resolving them against cwd meant a server started elsewhere silently found no
roles at all.

  source        `<root>/src/platform/config/load.ts` -> `../../..`
  bundled       `<root>/dist/server.js`  ->  `..`
  compiled      `/$bunfs/root/config.ts` ->  nothing. `bun build --compile`
                puts modules in a read-only virtual filesystem, so `..` is
                `/$bunfs`, and `config/default.yaml`, `roles/*.yaml`,
                `web/dist` and the `orch` CLI copied into every sandbox all
                resolve to paths that do not exist. Measured: the binary
                starts, warns that the config is missing, and then dies trying
                to `mkdir` a data directory on a read-only mount.

[the executable's own directory] makes a single-file binary usable as long as
its assets sit beside it. `ORCH_ROOT` overrides all three, for a layout that is
none of them.

## src/platform/config/load.ts:178

The reason used to be stated as "handed to subprocesses that do not run where
the server does". Since 005 no subprocess sees `dataDir` at all — turns run in
containers and reach the host only through the mailbox — so that sentence
would have had the next reader looking for a boundary that is not here. The
conclusion is unchanged; the reason is that this process can be started from
anywhere.

## src/platform/config/load.ts:188

An empty one […] is fine — preflight reports what it finds either way.

`ORCH_SANDBOX_API_KEY` is the original; `ORCH_SANDBOX_KEY` is the shorter one.
[A 401] reads as a broken server rather than as two names for one secret.

## src/platform/config/load.ts:199

These four are the ones an image cannot know at build time, and nothing else is
settable this way.

## src/platform/config/load.ts:217

editing a file inside the release to say so is worse than one variable in
whatever starts it.

## src/platform/config/load.ts:232

JS has no stdlib deep merge worth hand-rolling around.

That is reachable now that settings are written onto the live config — the
panel changing an image would also have changed what "default" means, so the
"restore default" button would restore the value it was asked to undo.

## src/platform/config/load.ts:259

(the Auditor wants a specific reviewer) […] before this split that is exactly
what a `runtime: codex` role would have got.

## src/platform/observability/span-store.ts:1

The SDK ships spans to a collector when one is configured, and to nothing when
one is not. Neither case leaves anything the panel can read back: a boss asking
where a requirement's wall clock went has no collector to ask.

`SpanExporter` is the documented seam for a destination, and
`BatchSpanProcessor` […] is one the SDK already ships and which the OTLP side
already uses.

Both see every span; an operator who runs a real collector keeps it.

## src/platform/observability/span-store.ts:40

This kept a week, and the row cap then cut that to 2.7 days at the measured
rate of 3,114 spans an hour, so three numbers disagreed: the copy said a day,
the standard said a week, and a reader could reach neither. Days two through
seven were stored and never read by anything.

A rollup table was designed for this and then discarded, which is worth
recording because the design was sound and the problem was not. Folding
expiring spans into per-hour summaries buys long history cheaply — but only
for a page that wants long history, and this one wants "is something slow
right now". Storing a week to serve a day is what made retention look like it
needed a mechanism.

A day is 75k rows at the measured rate and 750k at ten times that; a retry
storm or a hot loop writing 7.5M rows in a day would be 1GB of somebody's
laptop.

## src/platform/observability/span-store.ts:210

[system work is] the scheduler, the indexer, `/healthz`, the retention trim.

A "system" view that also counted every project's turns would report the
fleet's busiest requirement as a property of the host.

## src/platform/observability/span-store.ts:231

Filtering on the column alone found nothing, and an empty panel is
indistinguishable from a panel that was never built — which is exactly how this
was reported.

[without a read-side fix] the project view would be empty until the fleet had
run enough new turns to refill it. […] deriving it on read is both the smaller
change and the one that works on the data that is there.

## src/platform/observability/span-store.ts:244

Two reasons not to use floating point: SQLite is not built with the math
extensions everywhere. […] [truncation] moves a p95 down one sample at exactly
the round numbers a test would pick.

Degenerate inputs land where they should without a special case: n = 1 gives
rank 1 for every percentile, so the only sample is both the p50 and the p95.

## src/platform/observability/span-store.ts:259

It was `(windowMs, now)`. Dragging the handles around 01:30–02:00 could only be
reported as "the last thirty minutes" […] From the outside that reads as the
zoom being broken rather than as the query being unable to say what was asked.

## src/platform/observability/span-store.ts:278

[the obvious version] was wrong for every caller with an injected clock: a test
asking about a fixed instant in the past had its start pulled forward to a week
before *today*.

## src/platform/observability/span-store.ts:296

[a stage is] `turn.provider`, `sandbox.create`, `GET /api/v1/state`, a job kind.
The same query answers all three scopes, which is the reason there is one
endpoint and not three.

## src/platform/observability/span-store.ts:340

The one question the stage table cannot answer. Stages say *what* the time
went on — the provider, a cold container — and this says *which piece of the
work* it went on, which is the axis a boss reading a requirement already has
in their head: slice 1 sailed through, slice 3 has burned an hour.

`slice_id` is written by `turnScope` and indexed as the second column of
`span_scope`, so scoping to a group and grouping by slice is one range scan.

[at project scope] the same query would add up slice 1 of everything.

## src/platform/observability/span-store.ts:372

A requirement's turn is parented to the HTTP request that enqueued it […] and a
root-based measure would either find nothing or wander up into another scope's
time.

## src/platform/observability/span-store.ts:409

A tree built in SQL would be a tree serialised through a text column either
way; folded stacks are that with a format somebody else already defined.

## src/platform/observability/span-store.ts:422

Worth being exact about what this does and does not protect against, because
the obvious reading is wrong. […] a span has one parent column and
`(trace_id, span_id)` is the primary key. A cycle can only exist among spans
that are unreachable from any root, and those are never walked at all.

[a runaway-deep trace is] a recursive tool call, an agent looping through a
stage. […] the deepest thing this system emits is `turn` → `turn.checkpoint` →
`sandbox.create` → `sandbox.init`.

The unreachable-cycle case is a real if unreachable-in-practice gap: those
spans contribute nothing to the flamegraph rather than appearing detached.
Sweeping them in would mean a second pass over the scope to find what the
first missed, which is not worth paying for a shape no correct writer emits.

## src/platform/observability/span-store.ts:433

This is the aggregate, not one trace, and that is the point of having it
beside the waterfall. A waterfall answers "what happened in this one run, and
in what order". A flamegraph over every run in the scope answers "where does
this project's time actually go", which is a question no single trace can
answer and the one somebody asks when the fleet feels slow.

`startChildTrace` gives a job's span a remote parent, so a requirement's own
spans never have a NULL parent.

Percentiles and bucketing belong in the query and are fast there. The version
this replaced joined a CTE to itself once per level and ran a correlated
subquery over the same CTE to find roots — quadratic in the window, measured at
**5,178ms** against 7,382 spans while the flat read that feeds this is 0.1ms.

What this guarantees, asserted rather than assumed: 7,008 in, 7,008 out at
system scope on live data; 374 in, 374 out at project scope. [No path repeating
a name] is what a walk without cycle detection produces when parent ids form a
ring.

A "the query was also losing rows" claim was made here and withdrawn: it came
from comparing the scoped query against an unscoped probe, so the 374 spans
missing from one side were project-scoped rows the system scope excludes by
design. The measurement was wrong; the speed is the whole of the reason.

## src/platform/observability/span-store.ts:459

The old query dropped cycles entirely, and that was recorded as a decision.
It is not one this keeps: […] being unable to say what it hung off is not a
reason to say it never happened. [Counting every span once] is the property the
test asserts and which dropping them would break.

## src/platform/observability/span-store.ts:524

[This block sat above `spanExtent`, describing `trend` below it:]

The sample is one trace, not one span, so a bucket answers "how long did a
unit of work take then" rather than "how long did the average span take" —
the second is a number that moves when the shape of the tracing changes and
nothing about the system does.

Bucketing is `started_at / bucketMs` in integer division, multiplied back out
so each row carries the epoch millisecond the bucket starts at rather than an
index the caller would have to know the divisor to interpret.

## src/platform/observability/span-store.ts:617

`forceFlush` and `shutdown` are the process's shutdown path. […] the only
consumer of `FAILED` is that rejection. [The counter is] the channel an
operator actually watches.

## src/platform/observability/span-store.ts:4

None of [the queue, drop policy, batching, flush timer] is written here.

## src/platform/observability/span-store.ts:43

[age + count, because it is the same problem:] append-only history that nothing
else deletes.

## src/platform/observability/span-store.ts:432

Every span in the scope is counted exactly once, and no path repeats a name.

## src/api/panel/authflow.ts:43

Three flows with the same shape on purpose — a code, a link, and a pending
state that dies with the code — because a second shape for the same
interaction is how a settings page stops being learnable.

## src/api/panel/authflow.ts:90

That separation is the fix, not a tidy-up […] a `!("adopt" in b)` guard further
down does not achieve that — the two branches still meet in one binding, which
is exactly what a taint analysis reports and, more to the point, what one
refactor away from being true again.

## src/api/panel/authflow.ts:126

generating one here and not telling the server made every turn, every gate and
every diff 401 — reported as "Authentication credentials are invalid", which
reads as a model problem.

## src/api/panel/authflow.ts:175

It lives here rather than inline because there are two ways in and only one of
them used to do this: a login from the panel stored the token and stopped, so
every running group kept a sidecar bound to the credential that was missing and
every turn came back `Authentication credentials are invalid`.

## src/api/panel/authflow.ts:191

a group the boss paused by hand restarted itself the moment anyone signed into
GitHub, a budget-burnt group resumed with nothing changed about its budget, and
a rate-limited one came back carrying `rl_resets_at` — which watchdog rule 6
only clears for rows it still finds PAUSED, so nothing cleared it afterwards
either.

## src/api/panel/authflow.ts:347

under `e: any` the fallback `??` handed `bad()` the object itself — a 422 whose
body reads "[object Object]".

## src/api/panel/authflow.ts:402

page one of a hundred repositories to count them is the sort of thing that eats
a 5000/hour budget quietly. Repeats come back 304 from the client's ETag cache,
which does not count against the limit at all.

## src/api/panel/authflow.ts:494

measured, a round trip to api.github.com is 260-630ms, so doing these in series
is a second of blank dialog for no reason.

## src/mech/ops/preflight.ts:17

A missing docker means every group's first turn errors one at a time with the
same message; an egress server in `dns` mode means credential injection quietly
does not happen and the symptom is a 401 from Anthropic, which reads as a bad
token […] Decision 001's lesson, one layer up: every quiet failure looked
exactly like success. […] It does **not** refuse to start, and said it did for a
while.

## src/mech/ops/preflight.ts:49

It used to GET `/openapi.json` with an `x-api-key` header, and both halves of
that were wrong: the doc endpoint is unauthenticated, so a server that rejected
every real call reported `reachable`, and the header it authenticates by is
`OPEN-SANDBOX-API-KEY`. A panel showing a green tick while every turn, every
gate and every diff came back 401 is worse than no check at all.

## src/mech/ops/preflight.ts:82

Existence was the old check […] The failure it missed is the expensive one:
everything looks configured, and every turn dies at the API with a message the
boss sees as an agent problem. […] a preflight that costs two round trips per
glance is one nobody leaves on.

## src/mech/ops/preflight.ts:100

two different credentials shared a cache entry and the second one was reported
with the first one's verdict.

## src/mech/ops/preflight.ts:112

the usage poll was the last one […] So: not an oversight, and not something to
tidy up on sight of a host `fetch` next to a commit that removed exactly that.

## src/mech/ops/preflight.ts:221

there is no docker socket in here, `uvx` is not installed and never will be, and
pulling the sidecar here would put it in the wrong daemon […] every fix they
print (`brew install uv`) is a command for a host this process cannot see.

## src/mech/ops/preflight.ts:476

A blocked loop does not show up as a slow span of its own — it shows up as every
other span being slow, which is the hardest shape to diagnose from a panel. […]
this covers the readiness ticker, which is the path that runs when nobody is
looking.

## src/mech/ops/preflight.ts:499

Measured: with the daemon down — Docker Desktop installed and never launched,
the most common first-run state there is — `docker --version` still exits 0, so
this check reported "running" while every `ensureSandbox` failed. The blocker
the boss got said "多半是 docker 没起，自检那栏会说是哪个", and the self-check then
said it was up: pointed at the right page and told the wrong thing on it.

## src/mech/ops/preflight.ts:512

Only ever consulted when the server is down, but reported always: the fix for a
missing server is `uvx opensandbox-server`, and a machine without uv cannot run
that either. Two failures that look identical from the panel.

[Deleted rather than moved: the check it described now lives inside
`hostToolChecks`, so the comment sat above unrelated code.]

## src/mech/ops/preflight.ts:554

A published one is pulled by the sandbox server the first time it builds a
container, so there is nothing here for anybody to do and nothing that can go
wrong at this level. A row that is always green is a row nobody reads, and this
pane is the one place where a tick has to mean something.

## src/mech/ops/preflight.ts:594

the nudge throws, `renew` returns null, the stored token is kept […] The other
three modes need nothing here: a pasted `sk-ant-oat01-` is good for a year and
an API key does not expire.

## src/composition/server.ts:118

It demanded `claude` until 005 (turns moved into containers) and `git` until 007
step 6 (the checkout, the bundle and the push moved with them) […] which is the
whole point of the decision.

## src/composition/server.ts:143

the browser heuristically cached the bundle and kept showing a UI that had
already been rebuilt — a deleted button stayed on screen through a rebuild and a
restart, and the PM ended up asking the boss to hard-refresh. […] Over loopback
that costs nothing measurable.

## src/composition/server.ts:179

Everything decided here — whether a watchdog is already queued, what the boss is
waiting on, whether the network is worth trying, and whether the last index or
poll has come back — used to be reachable only by starting the process and
waiting thirty seconds per branch.

## src/composition/server.ts:189

Counting only pending was wrong the moment a tick took longer than the interval
that drives it, which telemetry measured at a p50 of 50s against a 30s tick: at
t=30 the first is running rather than pending, so a second was enqueued, and the
queue never emptied again.

## src/composition/server.ts:233

`void` with no `.catch` sent every throw to the process backstop, which emits a
blocker — one per tick, forever, and `bus.emit` has no dedup.

## src/composition/server.ts:310

Closing is a decision — "not like this" — and it can only be made there, so the
system has to read it from there. […] undoing a deliberate act because a poller
disagreed with it is the worst kind of helpful.

## src/composition/server.ts:640

This used to be an event and nothing else — not a row in `escalation`, so it
never reached 待办 — while the group sat at PR_OPEN holding the head of a
strictly serial merge queue with a null pr_number, which pollPrs skips forever.
Everything behind it stopped, and the only trace was one line in the feed.

## src/composition/server.ts:731

See NO_CACHE: /dist/main.js has no hash in its name and Bun sends no validators,
so a rebuilt bundle kept being served from the browser's cache.

[Deleted rather than moved: a restatement of the `NO_CACHE` block it names.]

## src/composition/server.ts:846

Rather than juggle a timer handle from the settings route, the callback notices
its own period changed and re-arms — one place, and it cannot be forgotten by a
new writer.

[The fact this restated — two timers reading one setting, only one noticing a
change — is kept at `reArming` itself, which is the helper it explains.]

## src/composition/server.ts:874

A UI change that is committed, tested and typechecked still shows the old page,
which reads as "the fix did not work" — measured, on a button that had already
been deleted. […] this crashed the container on boot rather than reporting
anything.

## src/composition/server.ts:906

Observed: one `ECONNRESET` on a container's `files/upload` — a socket on this
same machine — and every group stopped, mid-turn, with a two-line error and no
stack. […] `writeInto` retries the upload, `Scheduler.start` and `acceptSlice`
catch their own chains.

## src/platform/observability/span-store.ts:4

A destination is the one piece of the tracing stack that has to be ours — the
library cannot know our database.

## src/platform/observability/span-store.ts:4

[Registered beside the OTLP processor,] never instead of it.

## src/platform/persistence/database.ts:240

`orch` reaches the server over localhost TCP (see
docs/adr/001-agent-transport-and-sandbox.md).

## src/platform/persistence/database.ts:288

without this the PM gets woken every 30 seconds for the same failure.

## src/platform/persistence/database.ts:292

a slice that has waited four hours is a different problem from one that
finished a minute ago, and the queue could not tell them apart.

## src/platform/persistence/database.ts:296

Without the timestamp "wait" meant "wait for the boss", so one 429 at 01:00
cost the whole night.

## src/platform/persistence/database.ts:300

Without this the click was thrown away: the group stayed in DRAFT, nothing
recorded that anyone had said yes, and the boss had to guess when to come
back and click again.

## src/platform/persistence/database.ts:304

A group that hits a defect outside its own paths cannot fix it and cannot ask
anyone to: `orch mail` is a message, not a work item. So it escalated to the
boss and stopped, and the boss got a blocker with no button on it.

## src/platform/persistence/database.ts:313

A slice that keeps failing stops after `gateRetries` and asks the boss
(slice.retries). The branch had no such counter at all: a red branch gate sent
the Engineer round, a rejected audit sent the PM round, and neither loop had
an end.

## src/platform/persistence/database.ts:317

two groups editing package.json is the collision ownership exists to prevent.

[the requirement opened for a shared-file defect] could never start — the
Architect can only cut its boundary to the file itself, and canStart then
refuses it as a shared path. `sweepApproved` retried that forever.

## src/platform/persistence/database.ts:338

Filing one wakes three roles in the chain to think about it — measured, three
turns at ~3M tokens each.

## src/platform/persistence/database.ts:343

three pushes in an hour are three different shas and three rebase turns — the
boss pushing a batch of fixes cost one group three turns of pure rebasing.

## src/platform/persistence/database.ts:358

Rotation divided by a hardcoded 200_000 for every model. [The CLIs report it]
claude in modelUsage, codex in token_count.

## src/platform/persistence/database.ts:363

Pausing only that group left every other group to spend a turn discovering the
same wall, and a standing agent — no group to pause — kept retrying into it.

## src/platform/persistence/database.ts:374

[the figure] was what these turns would have cost at API rates on the half that
reported one, and zero on the other. A column half-populated with a number
nobody is billed for is worse than no column — it invites exactly the ranking
and the totals that were quietly wrong for every codex role.

## src/platform/persistence/database.ts:386

[the first two lines looked like] `S2 "常驻岗独立分段" failed qa 3 times.
Latest: 结构: pass — splitDeskRows(tables.tsx:82-104)…`. Eight of those is a
page of prose.

## src/platform/persistence/database.ts:391

[the same problem twelve times:] the worktree has no playwright, the acceptance
line cannot be verified.

## src/platform/persistence/database.ts:396

standing roles (Architect, CoS, Dispatcher) have no group and still must not
run on the host, so they share one per project.

## src/platform/persistence/database.ts:424

exactly one of the two ways to store one did — a login from the panel saved
the token and stopped, so every group kept a sidecar bound to the credential
that was still missing and every turn came back "Authentication credentials are
invalid" against a token that was fine.

## src/platform/persistence/database.ts:436

`clearance` stayed 'L1' on every row an insert ever made, and the panel printed
it as 「权限 L1」 — a permission level shown to the boss by a system that has no
permission levels. `denial_turns` counted permission refusals, which cannot
happen inside a container the CLI is told to skip its own checks in.

## src/platform/persistence/database.ts:453

[the four paths:] the rollback behind "interrupt and roll back", the rebase on
the way out of PARKED, the rollback behind a revoked answer, and the change set
the reconcile gate scores claims against — that last one silently passed every
claim for as long as the column has existed.

## src/platform/persistence/database.ts:459

It was detected on every call and the detection returned `origin/main` where
four callers then wrote `origin/${...}`.

## src/platform/persistence/database.ts:466

[the old form was] `.claude/skills/<name>/SKILL.md`. That was readable when
turns ran on this machine.

## src/platform/persistence/database.ts:475

so the data stays and one question is raised naming all of them. `repoHref`
still refuses anything shaped like a path, so an unconverted row renders as it
always did.

## src/platform/persistence/database.ts:484

The pull request title was `orch: <group name>`, a slug the dispatcher made
up before any code existed, and the squashed commit carried the whole PR body
under it — headings, gate tables, `Opened by orchestrator`. A reviewer's log
is the least generous place this project shows up in, and it showed up as
eight rows of the same prefix.

## src/platform/persistence/database.ts:497

`sandbox_image` and `sandbox_server_addr` were the first two things the panel
could change about this machine, and each got its own key, its own reader and
its own writer.

## src/platform/persistence/database.ts:512

[the bulk resume is] `credentialChanged`, after the boss signs in [and it
matched] groups stopped for burning their budget, groups blocked on another
group, groups the boss paused by hand. Signing into GitHub restarted work the
boss had deliberately stopped, and the rate-limited ones came back with
`rl_resets_at` still set, which watchdog rule 6 only ever clears for rows it
finds still PAUSED.

## src/platform/persistence/database.ts:553

039 put `trace_id` on jobs and events, which is enough to correlate rows that
already existed but says nothing about where the wall clock went: durations
lived only in the SDK's export queue, and with no `OTEL_EXPORTER_OTLP_ENDPOINT`
that queue was never even constructed.

[system spans are] `/healthz`, the watchdog tick, the retention trim itself.
[A group deleted next week must not] fail to delete because of it.

[`span_scope` leading with group then slice means] aggregating a requirement's
time over a window uses the same index as aggregating a group's.

## src/platform/persistence/database.ts:584

`server.ts`'s `prReopened` was this patched once, for one cause.

## src/platform/persistence/database.ts:664

`test/settings.test.ts` used to [rewind `max(n)`] — and then failed on that
migration's own `ALTER TABLE`, naming a column the test has never heard of.

## src/platform/persistence/database.ts:705

[`open(":memory:")`] runs every migration and every `CREATE TABLE` again per
call, and the suite calls this from 49 files. Measured on this machine:
4.9 ms each, against 0.026 ms to deserialize a snapshot — 190x, and there are
enough calls for that to be most of a test run.

[without re-applying the pragma,] `test/drop-slices.test.ts` would be asserting
on constraints nothing enforces. The mask registration `open()` performs is
not repeated because a fresh database has no `runtime_auth` rows to mask.

## src/platform/persistence/database.ts:721

Nineteen call sites across six files wrote this SQL out by hand — eight copies
of the same upsert, six of the same lookup, five of the same delete — and two
of them had independently arrived at the same "null means remove it" rule.
Nothing was wrong with any one of them; the cost is that a change to how this
table is written is a change in nineteen places, and a project about to take
contributors offers nineteen examples to copy from instead of one.

## src/platform/persistence/database.ts:738

Re-approving a DRAFT rewrites the plan, which means the old slices go. They
are pointed at from four places and the delete only cleared one of them, so
approving a card for a group that had already run failed with the least
actionable message SQLite has: `FOREIGN KEY constraint failed`. Nothing said
which key, and the boss's only move was to click again.

## src/platform/persistence/database.ts:555

a group deleted next week must not take last week's timing with it.

## src/platform/persistence/database.ts:705

[a caller that migrates again] gets a no-op.

## src/platform/persistence/database.ts:738

[the test is] so the next table to grow a `slice_id` cannot reintroduce this
bug quietly.

## src/mech/sandbox/auth.ts:11

Measured (docs/adr/005): the sidecar REPLACES an `Authorization` header the CLI
already set, and `claude` does not validate its token locally — a synthetic one
comes back as a server-side 401 — which together are what make this work at all.

## src/mech/sandbox/auth.ts:22

codex has exactly two non-interactive credential paths: an API key, or an
`auth.json` in `$CODEX_HOME`. A ChatGPT-account login is the second — a pair
of access and refresh tokens that codex itself rotates and rewrites — so it
cannot go in the vault: what you would bind is one access token that expires
in hours with nothing to renew it. claude's `setup-token` works precisely
because it hands over a year-long token instead.

## src/mech/sandbox/auth.ts:71

Git's smart HTTP is four requests:

    fetch   GET  /owner/repo.git/info/refs?service=git-upload-pack
            POST /owner/repo.git/git-upload-pack
    push    GET  /owner/repo.git/info/refs?service=git-receive-pack
            POST /owner/repo.git/git-receive-pack

The difference is worth one paragraph because it is the reason the utility
container exists at all rather than every group simply pushing.

[on the exact-strings rule] the shape the upstream guide suggests would readmit
`git-receive-pack`.

Known gap, stated rather than papered over: […] Adding it would also admit LFS
*uploads*, which share the path — so it waits for a repository that needs it.

## src/mech/sandbox/auth.ts:141

[without `forgetHolds`] a boss who reconnects GitHub watches nothing happen
until the hold's clock lapses, which reads as the fix not having worked.

## src/mech/sandbox/auth.ts:154

[a gateway's quota is] a number about somebody else's subscription, rendered as
if it were the constraint on what to start next.

[no row at all] so a bar sourced from whatever this host happens to be logged
into would be about an account the fleet never touches.

## src/mech/sandbox/auth.ts:179

`codex login` succeeds and the credential is read from a directory it did not
write, so the panel says "finished but produced no credential"; every ticked
skill stages zero files and the mount is empty. Honour the variable the CLI
honours, then fall back to the conventional path. `homedir()` handles the
platform difference; the env vars handle the install-somewhere-else one.

## src/mech/sandbox/auth.ts:251

Four call sites resolved the stored key with `loadAuth(db, SANDBOX_KEY)?.secret
|| cfg.sandbox.apiKey` and sent it to whatever `cfg.sandbox.server` currently
said. […] (`sandbox-server/addr`, and the `sandbox.server` row itself, which is
not in `SETTING_DENIALS`) […] `reachable`'s own suppression asserted the
opposite — "the key sent with it is the key stored for that same address" —
which was an assumption, not something the code arranged.

Compare `modelProbe`: its URL is built from `runtime_auth.base_url`, the same
row the secret is in, so credential and address cannot be substituted for one
another. This gives the sandbox key the same property.

## src/mech/sandbox/auth.ts:360

[the trailer] was a trailer nothing in the panel could reach — on the commits an
agent wrote by hand rather than the ones this orchestrator squashes.

Its own switch, beside the Claude account. It was briefly wired to the git
co-author switch, which is a different question: one is what this project puts
in its history, the other is which tool wrote the diff.

## src/mech/sandbox/auth.ts:385

This is the half that was described and never built. […] With
`GIT_TERMINAL_PROMPT=0` and no helper in the container it stopped at `could not
read Username`, and no token anywhere could have changed that — the vault
*replaces* a header the client already set (005), and git had set none.

[git sends] `Authorization: Basic base64(x-access-token:decoy)`.

## src/mech/sandbox/auth.ts:418

The renewal is done by codex itself rather than by us — see chatgpt.ts for why
that distinction is worth a few hundred tokens a week.

[on the re-entrancy guard] Nothing else in the loop notices, because each step
is doing something reasonable.

## src/mech/sandbox/auth.ts:469

`decoyAuth` stamps `last_refresh` with now for the express purpose of stopping
codex from refreshing it. […] Every sandbox then got `decoy-aaa…` injected and
the whole fleet 401'd, presenting as an expired account.

## src/mech/sandbox/server.ts:21

A user should need an environment, not a runbook. Every container this system
opens goes through one server process, and asking someone to start it by hand
in a second terminal before anything works is a setup step that exists only
because nothing was doing it for them.

The third case is the one worth being strict about. A restart there is
indistinguishable, from here, from a restart of the user's own work. [Killing a
process we did not start] takes down whatever else was using it.

## src/mech/sandbox/server.ts:60

[a second server] just fails to bind, dies, and then the health probe talks to
the first one and reports 401 — which is how a clean machine produced *"起来了
但驱动不了：Unable to connect"*, a sentence describing neither of the two things
that were true.

## src/mech/sandbox/server.ts:87

[sending `Authorization: Bearer`] cost an hour reading a message that said the
key was not accepted when the key was never presented.

## src/mech/sandbox/server.ts:105

The first version was three sentences of reasoning — where the server came
from, why we did not touch it, both ways out — set as a paragraph above the two
controls that are the ways out.

## src/mech/sandbox/server.ts:129

a blanket `^mode =` replaced `[ingress] mode` with `dns+nft` and the server
refused to start — *"Input should be 'direct' or 'gateway'"* — because `mode`
appears in two sections and the first one wins a file-wide match.

The generated example ships `# api_key = "your-secret-api-key"`.

## src/mech/sandbox/server.ts:172

Hand-writing it was wrong and failed the first time it ran on a clean machine:

    pydantic_core.ValidationError: 1 validation error for AppConfig
    runtime.execd_image
      Field required

`init-config --example docker` renders one from the packaged example, so the
parts we do not care about stay correct without anyone tracking them.

## src/mech/sandbox/server.ts:238

[egress image] v1.1.4 403s every scoped package fetch while a credential is
bound (005), and the example may ship it.

Regex rather than a TOML parser, like `keyInConfig` and `allowedHostPaths`
above: six known keys, one line each, and a dependency for that is a dependency
for that.

## src/mech/sandbox/server.ts:348

the first version had the panel spawning a server as a side effect of being
looked at.

## src/mech/skills.ts:10

This half is prefix: every skill in there costs name + description on EVERY turn
of EVERY agent (measured: the boss's whole ~180-skill set plus slash commands
was ~46k cached tokens). That is the bill the tick boxes control, and why the
settings page states it out loud. A repository's own are not tickable —
shipping one is the decision.

`--setting-sources project,local` stays on regardless — that flag governs
settings, not skill discovery, and inheriting the boss's user-level setup
measured ~195k cached tokens on a trivial haiku turn.

## src/mech/skills.ts:64

The replacement for that was 20 lines that folded `>-` the way `|` folds and
could match a `description:` in the body text below the frontmatter — and the
parser was already in use three files over.

## src/mech/skills.ts:137

**Which directories, and why these.** `.claude/skills` is not a universal
convention — it is claude's. Counted as exact strings in each CLI's own binary
(`codex-cli 0.147.0`, `claude 2.1.232`, in `orch/agent:1`):

    claude   .claude/skills 93   .codex/skills 0   .agents/skills 0
    codex    .codex/skills  3    .claude/skills 0  .agents/skills 0

and codex's three are one sentence about `$CODEX_HOME/skills`. […]
`.agents/skills` is the wider ecosystem's (`npx skills add --agent` writes
there) and neither CLI reads it.

## src/mech/skills.ts:170

measured on this machine, every one of `~/.claude/skills`'s 93 entries is a
symlink into `~/.agents/skills`, so scanning it adds **nothing here**. […] (one
CLI installed, or `--agent` pointed somewhere else)

## src/mech/skills.ts:237

[a project skill] is fetched over the files API (1-5ms, not the ~1s an exec
costs).

## src/mech/skills.ts:258

`SKILL_SYNC` prints it on the exec that already probes the checkout; this is
where it lands. […] Stale between a push that adds a skill and the next group's
first turn, which is the honest ceiling of caching a remote directory.

## src/mech/skills.ts:346

Copied, not symlinked […] (`~/.claude/skills/impeccable ->
../../.agents/skills/impeccable`, codex's point into its plugin cache).

Updated in place rather than rebuilt beside and renamed: the container mounted
this directory.

## src/mech/skills.ts:399

`listSkills` is a pure function with no bus, so the report lives with the caller
that has one.

## src/mech/git/github.ts:20

The eight endpoints are PR create / edit / view, checks, comments, reviews,
`/user` and one repo read. […] status decoding [is] commodity behaviour with a
maintained owner.

Not `@octokit/rest` or the batteries-included `octokit`: those exist to give
you a typed method per REST endpoint, and we call eight of them with our own
schemas. Not `gh` either — the point of 007 is that a host with docker, the
image and a pasted token can run, and every shelled-out binary is one more
thing that has to be installed and separately logged in.

[The credential is] never a host CLI's login. That distinction is what
`test/one-model-path.test.ts` guards: two accounts behind one label is how the
fleet spent a night 401ing on a token the panel could not see.

## src/mech/git/github.ts:39

[the backoff] at 50ms is 50ms then 200ms. Its `doNotRetry` default [is]
400, 401, 403, 404, 410, 422, 451 […] that is the set this file used to spell
out by hand.

## src/mech/git/github.ts:106

Saying "deleted" when it was an org policy change sends the boss to the wrong
page.

## src/mech/git/github.ts:193

A schema here would have to wave the body through to be written at all, which
looks like validation and does none — see
`test/governance/type-hygiene.test.ts`.

## src/mech/git/github.ts:203

[the signal] is the one usable per-request identity. [A `WeakMap` per client,]
so nothing is shared between clients and nothing outlives the request.

## src/mech/git/github.ts:276

Refusing at the door is what keeps a caller who cancelled during a backoff from
paying for one more request.

## src/mech/git/github.ts:300

[reading by shape] is the same check the retry plugin makes on its own errors.
[importing] `@octokit/request-error` to compare against [is the second copy].

## src/mech/git/github.ts:344

Re-serialising is what keeps the sentence the boss ends up reading identical to
the one this file produced when it did its own parsing.

## src/mech/git/github.ts:372

GitHub labels its bodies correctly, so in production `data` is already parsed
and this is a no-op.

## src/mech/git/github.ts:406

the moment the cursor traffic tipped the count every open PR the poller was
serving from a 304 went back to paying full price against the budget this cache
exists to protect.

## src/mech/git/github.ts:509

one span name per pull request is a span table nobody can group by.

## src/mech/git/github.ts:534

Measured before this landed: 18 calls to one route, 132.1s, and not one error
row in the whole table.

## src/mech/git/github.ts:576

without this a quiet fleet spends its 5000/hour re-reading answers it already
has. […] all [Octokit] is handed is the `if-none-match` header and the 304 it
throws back.

## src/mech/git/github.ts:591

Passing our own groups would only change the pacing numbers, and would
mean declaring `bottleneck` directly, whose last release is 2023-02-22
and so fails the maintenance rule in `docs/standards/dependencies.md`.
(The date here said 2019 until it was checked against npm. The
conclusion held; a wrong date in the reason is how a decision gets
reopened by someone who checks.)

## src/mech/git/github.ts:600

[`retry-after` is] 60 by default. Saying no here keeps today's behaviour
exactly.

## src/mech/git/github.ts:23

[the plumbing:] retry, backoff, URL and body construction.

## src/mech/git/github.ts:126

[422 bodies read] "No commits between…", "A pull request already exists".

## src/mech/git/github.ts:430

writes are the only thing that sets this, to 0.

## web/src/features/knobs/view.tsx:49

These used to live in `config/default.yaml` with a hundred lines of comments
around them, and those comments are the most expensive thing in that file […] A
settings page that lists forty numbers with no reasons is a page that gets a
number changed once and never changed back. […] Three things this page owes the
reader, and did not: […] `1200000` is twenty minutes and `10800000` is three
hours, and told apart by counting zeros. […] a table crammed into one line of
JSON is a value nobody can read and nobody can fix by hand. […] A toast in the
corner outlives the fix and never says which of the four boxes on the row it
meant.

## web/src/features/knobs/view.tsx:100

每片 token 上限 does not, and used to carry an empty one anyway so the two
blocks' columns would agree. That bought the wrong alignment: […] one row
starting 3.25rem further in reads as broken long before anyone compares it to
the block above it.

## web/src/features/knobs/view.tsx:295

which is why the old page, asking for `indexModel`, drew nothing at all: the
most-called model in the system had no row and the paragraph explaining why it
matters was on screen zero times.

## web/src/features/knobs/view.tsx:740

The reason is what the boss can get wrong: one box holding `1200000` invites a
zero too many, and one box holding `20 分钟` invites `20 分` (fine), `20m`
(fine), `20 min钟` (refused, and the refusal is about spelling rather than about
the number).

## web/src/features/knobs/view.tsx:1157

so a new model could not be added at all: the box came back "contextWindow: Too
small: expected number to be >0" and the row never appeared.

## web/src/features/requirement/view.tsx:87

Each of them spelled it out: a `const go`, an early return, the call, the
refresh. Four lines of ceremony per button.

## web/src/features/requirement/view.tsx:100

The first version stacked everything at full weight: identity, five controls,
three slices each with its own gate row, an evidence panel that pushed the last
slice off the fold, then delegated answers, then records, then the roster, then
a composer. Nine blocks of equal loudness.

## web/src/features/requirement/view.tsx:152

Four things this page holds, and they were stacked in two columns down one
scroll: questions, slices, the record, the roster — plus a composer that ended
up below however many slices there were.

## web/src/features/requirement/view.tsx:245

It used to sit in a second pane below the whole list, so the diff for S2 was
drawn under S3 and the row it answers was two rows away from the two buttons
that answer it. […] not `flex-1`, which drew an 800px empty frame under three
closed rows.

## web/src/features/requirement/view.tsx:296

Stacked down one scroll they were invisible: at the top of the page nothing said
a question was being held by the Architect or that a stand-in had answered two
of them — you found out by scrolling past the box you came to type in. A switch
says it in three words without moving anything.

## web/src/features/requirement/view.tsx:368

Until this pane existed the page said nothing for all of it: the requirement
simply sat there, which is indistinguishable from stuck.

## web/src/features/requirement/view.tsx:632

A header saying `S2 <title> 验收：<spec>` sat here, directly under the lane row
that says S2 and the title, directly above the evidence panel that leads with
the acceptance line. Three copies of two facts, stacked.

## web/src/features/requirement/view.tsx:827

Both used to run the full width of the page, the question in body text and the
answer in a grey slab under it — two paragraphs of somebody else's words at the
weight of live work.

## web/src/features/requirement/view.tsx:945

A second composer down here asked the boss to type into whichever one they found
first, and neither said where the words would go.

## web/src/features/requirement/view.tsx:1116

There were two: 批准开工 and 退回重拴, and the box to type in was at the very
bottom of the page under everything else — so the words the boss added while
looking at the card went somewhere they could not see, and "要求修改" and "不做了"
did not exist at all. A duplicate requirement could not be turned away.

## web/src/features/requirement/view.tsx:1197

Opening a question used to fire a model call — one per open, on every question
the boss so much as looked at.

## web/src/features/requirement/view.tsx:1344

They sat in that list at the same weight, with the same tint and the same answer
box, and the commonest one is an Architect quoting the shell command a clearance
rule blocked: a paragraph of `git ls-tree -r main --name-only | grep -i markdown`
the boss can do nothing with.

## src/mech/git/worktree.ts:21

Three callers each wrote `origin/${await detectBaseBranch(...)}` and each took
an override argument that no caller outside a test ever passed. So the
hardcoded `origin/` prefix was the only path in production, and it is wrong
for exactly the clone that has no remote — the one where the fallback was
supposed to help.

## src/mech/git/worktree.ts:55

[a turn is killed by] the server stopping, the watchdog taking the process, the
agent hitting its turn cap. [git refuses with] "there is already a rebase-merge
directory … I am stopping in case you still have something valuable there"
[and] it says so once per wake attempt forever. Observed on
response-aiagent-markdown.

[`--abort` restores the pre-rebase HEAD,] which is exactly the state the caller
assumes.

## src/mech/git/worktree.ts:72

this used to return `origin/main` when `origin/HEAD` was set and `main` when it
was not, while four of its callers wrote `origin/${await defaultBase(...)}`. On
any repository where `origin/HEAD` exists — which is every clone — those asked
git for `origin/origin/main`.

[the remote's own HEAD first:] a repo whose default is `trunk` says so here.
`HEAD` last, for a repository with no branches yet.

## src/mech/git/worktree.ts:110

A checkpoint whose message is only `wip: S2: engineer` says nothing that
`git log --stat` does not. […] Twelve paths and a count is a page of the log
that answers "where did this touch" without a second command.

## src/mech/git/worktree.ts:126

[a path outside ASCII comes back as] `"docs/\350\256\276\350\256\241.md"`,
[so] git answers

    error: pathspec 'docs/\350\256\276\350\256\241.md' did not match any file(s)

exits 1, changes nothing, and the exit code was not read. The out-of-bounds
file survived and the bus announced it had been reverted, with a count. That
is decision 005's only remaining enforcement failing open and reporting
success, in a project whose runtime output language is Chinese.

## src/mech/git/worktree.ts:194

GitHub reads a `Co-Authored-By:` line in the body. It goes last, after a blank
line, which is where every tool that parses trailers looks.

[of two copies of the address] the half that is wrong is the half a DCO check
rejects — after every gate has already passed.

## src/mech/git/worktree.ts:222

flattening that would destroy information to satisfy a rule about noise.

## src/mech/git/worktree.ts:284

and it only "passed" on the retry because the next turn's checkpoint had
quietly committed the previous turn's work.

## src/mech/git/worktree.ts:302

`slice.base_sha` is the branch tip when the slice started, and it is the right
base right up until a rebase rewrites the branch onto a newer main. Groups here
rebase on every main push (watchdog rule 15), so that is the normal case, not
the rare one.

[Says which one it used,] because "this slice" and "this branch" are different
claims and the boss is accepting one of them.

## src/mech/git/worktree.ts:58

this runs at the start of a rebase about to redo the work.

## src/mech/git/worktree.ts:75

[then] `HEAD` [last].

## src/mech/git/worktree.ts:25

three messages for one cause, none of which names it.

## test/web/telemetry-render.test.tsx:24

`d3-transition` animates the `transform` attribute when the flamegraph zooms,
and `d3-interpolate` parses the current value by setting it on a scratch node
and calling `transform.baseVal.consolidate()`. happy-dom's `SVGTransformList`
has every other method from the spec and not that one, so a zoom threw from
inside a `d3-timer` callback — uncaught, after the test had already passed,
which is the worst place for it. Returning `null` is the documented answer for
an empty list and sends `parseSvg` down its identity path, which is right for
the zero-duration transitions this chart is built with.

## test/web/telemetry-render.test.tsx:111

Rendering the component bare tested a tree the product never builds, and the
failure it produced — "`Tooltip` must be used within `TooltipProvider`" — was
the harness's, not the component's.

## test/web/telemetry-render.test.tsx:158

it used to write its own status sentence there on search too — `search: 0 of
11271164.521939998 total samples`

## test/web/telemetry-render.test.tsx:207

Single-open was the original choice and it is wrong for these rows. A
requirement's slices are alternatives — reading one means not reading the
others — but 巡检规则 and 代码索引 are comparable, and the whole reason to
open the second is to see it beside the first.

## test/web/telemetry-render.test.tsx:244

Opening 设置 locks body scroll, the scrollbar goes, the pane gains those pixels
back and the observer fires — and while `width` was a dependency of the effect
that *creates* the chart, that destroyed and rebuilt it.

## test/web/telemetry-render.test.tsx:293

`ui.md` delivers the dark variant by inverting the ink scale, so a frame at a
fixed lightness stayed mid while the page flipped around it, and the label on it
went from readable to invisible.

## test/web/telemetry-render.test.tsx:347

it self-imports `d3-flamegraph.css`, the bundler emits it as `web/dist/main.css`,
and `web/index.html` links only `app.css`. So every rule the labels get is one
of ours, they arrive on the host rather than on the label itself (they are
Tailwind arbitrary variants), and an unstyled label is 16px of the page's own
ink with no truncation.

## test/web/telemetry-render.test.tsx:428

"It grew" is also satisfied by a runaway, and there was one: the chart was
measured *inside* the wrapper it had already scaled, so the width came out as
viewport ÷ zoom² and each render resized what the observer was watching.

## test/web/telemetry-render.test.tsx:519

Refusing at the menu is the fix, and the count is the reason — an absence the
reader cannot see is not an answer.

## test/web/telemetry-render.test.tsx:586

after which `zoomAt` clamped every widening to the span it already had and
`panBy` clamped every slide to zero.

## test/web/telemetry-render.test.tsx:604

It is also the wrong rank on its own terms: a project's spans are mostly routes
and container operations belonging to no requirement, which makes it a sibling
question rather than a detail.

## test/web/telemetry-render.test.tsx:653

This used to assert the opposite, and the opposite was a trap. […] in a slot the
size of the chart that is missing rather than as a line at the top of the page,
which is what the original complaint was about.

## test/mech/watchdog.test.ts:84

30ms a call. Measured: 92% of a sixty-tick CPU profile, and this file ticks the
watchdog forty-eight times.

## test/mech/watchdog.test.ts:292

It needed nobody: the system had already handled it. […] which costs the
notifications that were real — so which rule leaked is the fact a failure has
to carry, and one bare boolean per line did not carry it.

## test/mech/watchdog.test.ts:757

The old version of this test protected against comparing with a *local*
checkout's HEAD, which no longer exists to be compared with.

## test/mech/watchdog.test.ts:775

Ten requirements produced 123 MB of raw NDJSON — median 324 KB a turn, 3 MB at
the tail — because a transcript is mostly tool output written verbatim. Worth
keeping (every measurement in PROGRESS came out of these).

## test/mech/watchdog.test.ts:1014

It was a module-level `lastSweep` compared against `SWEEP_EVERY_MS` inside the
rule's own body. […] Nothing covered it — this is the first test of the cadence
at all, which is how it stayed a hand-written throttle while twenty-three
sibling rules had none.

## test/mech/watchdog.test.ts:1155

the answer was fetched once per group per tick — ten groups on one project, ten
identical calls against one rate limit, every thirty seconds, for one string.

## test/api/api.test.ts:616

measured, the objection arrived a minute later and said the plan contradicted
its own acceptance criterion.

## test/api/api.test.ts:632

This is not a hypothetical: on a fast machine the two writes above land on one
millisecond about one run in five, and while the comparison was a strict `>` the
objection was dropped and the test failed intermittently. […] so the flake was
the defect showing itself rather than noise around it.

## test/api/api.test.ts:1173

重新扫描 refreshes both halves of the list: this machine's directories, which it
can read, and the repository's own, which live in a container and reach this
process only as text `SKILL_SYNC` printed.

## test/api/api.test.ts:1284

pm-ai-agent's gate failed on a missing line in tsconfig.json, which is not in
its owns, so the sandbox refused the write. No verb opened a requirement for it
and `orch mail` creates no work, so it rewrote its own code three times,
escalated, and stopped. […] the caller named this path from inside `/work`.

## test/web/telemetry-render.test.tsx:10

`ResponsiveContainer` asks its parent how wide it is […] and the flamegraph
shell takes the same measurement for the width it hands the library.

## src/application/executor.ts:221

which is what it was on every turn span ever written […] The read path derives it
through `grp` for the rows already stored, and does not need this. One
primary-key lookup against a turn that takes seconds.

## src/application/executor.ts:238

The stages are the ones that actually take time.

## src/application/executor.ts:400

[`no_result`] is a turn that broke after spending its whole timeout.

## src/application/executor.ts:452

It was a ternary inside an object literal, where the only way to check it was to
run a turn and read the spec back out.

## src/application/executor.ts:575

The slice number is where the reviewer looks first, the role is who did it, and
the task title is the only sentence anyone wrote about this particular piece of
work. […] The checkpoint runs at the top of a turn and commits whatever is
dirty, which is the previous turn's output […] and the one place a reviewer
looks to find out who wrote a line said the wrong name.

## src/application/executor.ts:611

Removed whole — it documented something this function does not do. It sat as the
doc comment on `buildStableFor`, which builds the stable prompt prefix and has
nothing to do with gate containers:

> The project's gate container, if it has one.
>
> `config_json.container` = `{"image":"oven/bun:1"}`, optionally with
> `network`, `depsVolume` and `depsPath`. Absent means the host.

If that is still true of `config_json.container`, it belongs wherever the gate
container is actually read.

## src/application/executor.ts:630

The comment that used to be here said those two queries have to agree, and then
wrote out its own predicate and its own literal 20.

## src/application/executor.ts:656

The boss attaches a screenshot […] claude was asked to `Read` a missing file,
failed silently and improvised around it; codex was handed `-i
/Users/…/data/attachments/…` for a file that was not there. Nothing copied them
in, and nothing said so — the feature had been dead for as long as the container
had been the boundary.

## src/application/executor.ts:723

a deny-list used to stop the write before it happened, and decision 005 §Ceiling
accepted the trade. […] Deliberately deterministic: asking a role prompt to
respect a boundary is the thing this codebase does not do.

[`sandboxGit`] Pointing the host runner at it threw on every turn, in the one
mechanism that has no second line of defence.

## src/application/executor.ts:752

The same function was just fixed for pointing the host runner at `/work`; this
line is the identical failure one layer down.

## src/application/executor.ts:853

成本's 按账号 split was reading `model LIKE 'gpt%'`, which is right today and
wrong the first time either vendor renames anything.

## src/application/executor.ts:899

Removed whole — it described two parameters that no longer exist:

> No `repoPath` and no `git`: both were left over from when this read the host
> checkout, and the diff has come out of `sandboxGit(WORK)` since 005. A
> parameter nobody reads is the next reader's wrong mental model.

## src/application/executor.ts:923

Removed whole — it was stacked above `handleAuthFailure`'s own doc comment and
describes a denied *tool call*, which that function does not handle:

> A headless run never prompts, so a denied tool call is silent and the agent
> quietly invents a workaround. Surfacing it as an escalation is the only way
> the boss ever finds out.

## src/application/executor.ts:1000

The denominator used to be the literal 200_000 for every model. Measured on this
repo's own logs, sonnet-5 and opus-5 report a 1M window — so the strong models
were rotating at 12% of theirs.

## src/application/executor.ts:1140

docs/project/plan.md called the runner the sandbox's only hole.

## src/platform/scheduling/scheduler.ts:133

each one is a real Chromium […] `typecheck` wants as many as the machine has
cores. One global number could only ever be the minimum of those, which is the
browser's.

## src/platform/scheduling/scheduler.ts:144

Removed whole — it sat on the `now?: () => number` option and describes
`FREE_KINDS`, which is declared 77 lines further down:

> Kinds that are cheap bookkeeping and bypass the group slot pool.

## src/platform/scheduling/scheduler.ts:162

Injected like the others, so no unit test needs a network — `repoHeld` in
`github.ts` is what the server passes.

## src/platform/scheduling/scheduler.ts:194

the contradiction was load-bearing […] the boundary was never cut, the approval
never landed […] Observed on three groups at once, each holding a permanently
pending job.

## src/platform/scheduling/scheduler.ts:223

those used to collapse onto slot 0 — so Architect, CoS, Dispatcher and
Librarian, who share nothing, took turns waiting for each other. Measured on
this database: Dispatcher averaged 4309s of queueing, CoS 1752s, for turns that
touch no common state. […] (it cannot write two transcripts at once) […] They
still count towards `maxGroups`, which was the actual reason slot 0 existed.

## src/platform/scheduling/scheduler.ts:346

The rules enumeration, which now restates the three named branches of
`claimCapacity`:

>  - one in-flight agent_turn per group (the group's single writer; makes the
>    L2 barrier and "no intra-group write conflicts" fall out for free)
>  - at most `maxGroups` groups with an in-flight agent_turn
>  - leases draw from their own pool, capped per resource concurrency
>  - a group must be in a dispatchable status
>  - budget must not be exhausted (slice budget first, then group)

## src/platform/scheduling/scheduler.ts:494

It will be hired, run once, and hold the provider itself.

## src/platform/scheduling/scheduler.ts:517

A turn that cannot possibly work should not be dispatched — preflight and the
settings page are where this is said out loud, and both name the command that
fixes it. […] with none, nothing it could be hired onto would run either.

## src/platform/scheduling/scheduler.ts:541

there is nothing to look up, and defaulting to held would stop housekeeping over
somebody else's credential.

## src/platform/scheduling/scheduler.ts:645

Sixteen `enqueue` sites had no `tick()` after them and the omission looked
exactly like the deliberate ones — both waited for the watchdog timer, up to
`watchdogIntervalMs`, on work whose whole point was that something noticed it
was stuck. […] an escape from here surfaces against whatever happens to be
running with no relationship to the job that caused it.

## src/platform/scheduling/scheduler.ts:678

the queue looks healthy and simply never moves. Observed exactly that way. […]
After a restart nothing is being read, which is the right answer — the command
inside the sandbox runs on into the void until its own timeout, and the requeued
turn sees whatever it wrote.

The work itself was still dropped — the slice stayed `running`, so
`startNextSlice` counted the group busy and never queued anything again. Same
silence, one layer down.

## src/platform/scheduling/scheduler.ts:776

each holding a turn that was only ever killed by the restart itself, and every
one of them needed a human to say "go on then". […] spending its one retry on
that would leave the group stopped after the connection came back.

## src/mech/git/checkout.ts:46

GitHub is the source (007 §6).

## src/mech/git/checkout.ts:51

this is the only request that runs on every path.

## src/mech/git/checkout.ts:76

The settings endpoint offers the remote's branch list and calls the box "a
choice rather than a memory test"; the resolver was making it exactly a memory
test.

## src/mech/git/checkout.ts:229

the repository's own skills are re-linked and re-listed on every turn for no
extra round trip.

## src/mech/git/checkout.ts:240

`--progress` and streamed: git writes clone progress to stderr, and
`--progress` is what keeps it on when stdout is not a terminal.

## src/mech/git/checkout.ts:250

[There used to be three.] The first was "on the host", because a group's
commits lived there between turns — which was the entire reason the host held a
checkout. They live on the remote now (`pushBranch`).

## src/mech/git/checkout.ts:266

Falls back to the old literal when nothing is connected — a checkout still has
to work before GitHub does.

## src/mech/git/checkout.ts:274

A repo that ships both is left alone.

## src/mech/git/checkout.ts:485

It reads the project's own container instead […] a read per file is 125 round
trips a tick.

## src/mech/git/checkout.ts:493

These are the two cadences that matter: `createCheckout` is once per
requirement and calls itself the longest minute in a group's life, and
`keepBranch` is once per *turn*, of which a requirement has dozens — so the
second is very likely the larger bill and neither could be seen at all.

[Reported failure rather than a throw] means a span that only errored on an
exception would almost never error.

## src/mech/git/checkout.ts:574

[the two callers:] one is a turn that has already finished its work, the other
a slice acceptance nobody awaits.

## src/mech/sandbox/sandbox.ts:657

Neither span opens on the warm path.

## src/mech/sandbox/sandbox.ts:703

Once per host path per process […] the fallback above has already said its
piece.

[the three:] one writes files under `CODEX_HOME`, one calls
`credentialVault.create`, and the third is an `ls` whose only output is an
upgrade message. Serially they were three round trips […] with a *diagnostic*
in front of the credentials.

## src/mech/sandbox/sandbox.ts:772

One `ls` per host path per process, and only when that path holds something.

## src/mech/sandbox/sandbox.ts:1000

[it throws] with the paths in the message, because the SDK's error names
`files/upload`.

## src/mech/sandbox/sandbox.ts:1444

Ten groups, the shipped default, is 2.5 hosts' worth of CPU asked for at
once.

## src/mech/sandbox/sandbox.ts:1463

`execIn` had one and the nine delegations beside it did not, so `git clone` —
which this module's own comment calls the longest minute in a group's life —
did not exist in 系统耗时 at all.

The scope is the identity, and it carries the project so the panel's project
filter sees it.

## src/mech/sandbox/sandbox.ts:1485

[handed over,] which is immediately — the number would be the cost of
constructing an iterator rather than of the turn it streams. […] a caller who
breaks out early or throws, which is how a cancelled turn leaves.

## src/platform/persistence/database.ts:12

The function form exists for one case so far: rewriting the skill paths stored
in old message bodies, where the old and new forms differ by the skill's name
and SQLite has no regex.

## src/platform/persistence/database.ts:330 (migration 017)

sized for the browser (1, each lease is a real Chromium) […] Tags name the
contended thing, and each tag gets its own pool size.

## src/platform/persistence/database.ts:347 (migration 020)

a table rather than a variable so the header is not blank after a restart and
does not wait for the next turn to arrive.

## src/platform/persistence/database.ts:374 (migration 023)

Nothing displays them and nothing can.

## src/platform/persistence/database.ts:396 (migration 026)

a restarted orchestrator reconnects to the container that is still running […]
a sandbox has two possible owners, a group or a project's standing roles.

## src/platform/persistence/database.ts:424 (migration 028)

storing one has to kill the running sandboxes. The fix that lasts is not a third
call to the same helper but a fact on the row.

## src/platform/persistence/database.ts:443 (migration 030)

they belong to this machine rather than to a project, and the boss edits them in
the panel.

## src/platform/persistence/database.ts:466 (migration 033)

The composer used to insert a path relative to the boss's home, which is a file
the agent is told to read and cannot now that turns run in a container.

## src/platform/persistence/database.ts:475 (migration 034)

Every project now comes from GitHub (007 §2). […] the remote was recorded at
registration and `parseRepo` reads the slug out of it. […] dropping the row
deletes a project the boss chose.

## src/platform/persistence/database.ts:497 (migration 036)

the shape this project has been burned by (see `grp.worktree`, a column nothing
wrote and four things read).

## src/platform/persistence/database.ts:512 (migration 037)

an existing PAUSED row is one whose cause was never recorded.

## src/platform/persistence/database.ts:553 (migration 040)

Three indexes: `trace_id` for a whole trace, `span_scope` for a group or slice,
and `span_age` for the retention scan, which neither of the others can serve.

## src/platform/persistence/database.ts:588 (migration 042)

the panel could say `index.ask` failed 2,835 times and never that the reason was
a missing credential. Answering that took a query against the database, which is
the thing 系统耗时 exists to make unnecessary.

## src/platform/persistence/database.ts:596 (migration 043)

the settings endpoint's own comment calls that box "a choice rather than a
memory test". Seen twice in one event feed, 29 seconds apart, both announcing
the same reversion.

## src/composition/server.ts:352

These were three module-level containers keyed by project id alone, which
`AGENTS.md` invariant 11 forbids and which two tests proved: a second database
with a project id 1 inherited the first one's verdict, so a pass could be
skipped on the strength of a failure that happened somewhere else. One process
with one database never noticed, which is why it survived.

## src/composition/server.ts:397

"the flag now stops the work" was the whole of the fix, and the previous version
of that claim — a flag that gated only the warning — held for months because
nothing asserted it.

## src/composition/server.ts:511

nothing in the utility container asks a model — it has no agent in it, which is
the entire reason it may hold real tokens.

## src/composition/server.ts:575

Best-effort: chmod is a no-op on Windows.

## src/composition/server.ts:662

Answering un-pauses it, and the watchdog re-queues the Auditor's turn, which
passes again and retries the PR.

## src/composition/server.ts:810

otherwise the first boot on a clean machine always prints a failure that fixed
itself two seconds later.

## src/composition/server.ts:972

An unhandled rejection is still a bug […] Installed once, like the signal
handlers.

## src/mech/ops/watchdog.ts:520

Every group in a project asks the same repository for the same branch, so ten
groups on one project made ten identical calls against one rate limit on every
tick — and the answer they were racing to fetch was the same string.

## src/mech/ops/watchdog.ts:829

the mirror is `--filter=blob:none`, so reading through it is a network fetch per
file, and this machine has no checkout at all. One exec for the whole corpus
[…] the last declaration in a truncated file falls outside its `export_statement`
and is lost, and no larger cap fixes it. […] (indexing off, or no container yet)

## src/mech/ops/watchdog.ts:774

`commands.run` is ~1s.

## src/mech/ops/watchdog.ts:789

Rate limited to five minutes inside.

## src/mech/ops/watchdog.ts:1074

an import, a refresh, a CLI […] this is the class of bug where forgetting looks
healthy. The durable form is a fact about the row.

## src/mech/ops/watchdog.ts:1117

`renewSandbox` is a no-op for a scope with no container.

## src/mech/ops/watchdog.ts:1140

because N failed restarts is evidence that restarting is not the answer.
