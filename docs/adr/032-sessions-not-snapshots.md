# 032 A bash session per container, and no snapshots

**Status**: accepted; sessions implemented, snapshots refused on measurement.
**Date**: 2026-08-19
**Follows**: [005](005-the-container-is-the-boundary.md) and
[026](026-three-classes-of-process.md), which decide what a container is for.

The plan called for two things the SDK ships and this repository had zero
references to: bash sessions, and snapshots for cold start. Both were measured
against a live server before either was written, and they came out opposite.

## Sessions: 1013ms → 5ms

Five runs of the same `git rev-parse` in a real container:

```
run()            median 1013ms   (1013–1025 — a fixed interval, not the command)
createSession()  1ms
runInSession()   median 5ms
```

Two hundred times, for the same shell. `sandbox.exec` ran **6,506 times in a day**
on one machine, so the fixed second alone was about **1.8 hours of waiting**.
Implemented.

**The catch, and why it is not a two-line change.** A session merges stderr into
stdout. Inside one, `readlink /proc/self/fd/1` and `fd/2` both answer
`pipe:[5228080]` — the same pipe inode — while `run()` gets `/tmp/<id>.stdout` and
`/tmp/<id>.stderr`. The SDK exposes `onStderr` for session runs and the server has
nothing to feed it; the callback never fires, and it is not an omission. Swapping
one call for the other would have returned git's warnings to NUL-delimited
`STATUS_Z` output — the defect `sandboxGit` was repaired for on this branch.

So each command redirects its own stderr to a file and reads it back after a
marker, which is what the one-shot path does server-side. Verified byte-identical
to `run()` on a failure, a success that writes to stderr, a plain success, and
multi-line output. Three things were wrong first and are recorded in the commit: a
bare `exit` ends the session, a NUL marker cannot travel through a shell argument,
and a session keeps its cwd between commands.

## Snapshots: 300ms on a 3-second operation

```
Sandbox.create from image      3098ms
Sandbox.create from snapshot   2804ms
createSnapshot                 12ms accepted, Ready in ~3s
```

**Ten percent, and the premise was wrong anyway.** The plan costed this against a
34-second cold start. On a machine that already holds the image, `Sandbox.create`
is three seconds. What the 34 seconds actually contained was the nine serial execs
of provisioning and the clone — and those execs were a second each until the
session change made them five milliseconds. The session fix already removed most
of what snapshots were meant to pay for.

Against 300ms, snapshots want: an invalidation rule (image tag, skills directory,
`runtime_auth` freshness), a cleanup rule and a twenty-fifth watchdog rule to run
it, storage, and a degradation path for a restore that fails. That is a decision
with four moving parts for a tenth of one operation, once per requirement.

**Reopen when** `Sandbox.create` itself is the measured cost — a machine that pulls
the image per creation, or a Kubernetes runtime where scheduling dominates. The
number to beat is 3098ms, and it should be re-measured there rather than assumed.

## Warm pools are the server's, and not available to us

`CreateSandboxRequest` has a third mode: `extensions.poolRef`, a pre-configured
pool from a Pool CRD. It would be the warm pool the plan proposed building.

It cannot be used here, and the reason is in the contract rather than in the
runtime: with `poolRef`, `snapshotId`, `networkPolicy`, `platform`, `volumes` and
`credentialProxy.enabled` **must not be provided**. All three of the last are
load-bearing — the deny list, the cache and skills mounts, and the egress vault
that is the whole of ADR 005's boundary. A pool would trade the security model for
a warm start.

## An error the SDK made easy to make

`SandboxManager` has snapshot methods that delegate to `this.sandboxes`, and the
constructor only assigns that from its options — so `new SandboxManager({connectionConfig})`
produces an object whose every snapshot call throws `undefined is not an object`.
`SandboxManager.create({connectionConfig})` is the factory that builds the adapter
stack. The typed methods are identical either way, which is what made it look like
a missing server feature for two probes.
