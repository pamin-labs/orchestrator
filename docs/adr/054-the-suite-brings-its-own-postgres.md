# 054 The suite brings its own PostgreSQL, because the agent has no Docker

**Status**: accepted and implemented
**Date**: 2026-09-03

## Context

The first requirement this project gave itself stopped on its first slice. The
engineer's report was:

> Lease #1 cannot start the required test gate because docker is absent from
> PATH. Please restore Docker or provide this group's approved database-test
> resource.

Both halves are unanswerable. An agent runs inside an OpenSandbox container that
has no Docker daemon and no route to the host's — ADR 005 made the container the
boundary, and a socket back to the host would be the boundary's largest hole.
And there is no "database-test resource" to hand over: `orch lease` runs commands
in that same container.

`scripts/test.ts` reached for `docker compose -f docker/postgres-test-compose.yml`
when nothing answered on 5433. That is right on a developer's machine, right on
a CI runner, and impossible in the one place the fleet actually works.

## Decision

`bun run test` starts PostgreSQL from `@embedded-postgres/<os>-<cpu>`, which is
what `bun install` already put in `node_modules`. No daemon, no image pull, no
network. The setup step every checkout already runs is the whole prerequisite.

Measured, cold, this tree:

| where | to a usable database | suite |
|---|---|---|
| macOS arm64, developer | 1.0s | 2095 tests, 11.6s |
| agent image, root, no docker | 1.6s | targeted, passes |
| linux/amd64, non-root, frozen lockfile | 4.5s | targeted, passes |

The compose file stays, and stays the only owner of the server's settings —
`max_connections`, `fsync=off`, `pg_stat_statements` and the rest. `serverFlags()`
reads its `command:` array and passes it to `postgres`, so the two servers are one
description. `bun run db:test:up` still starts the container for anyone who wants
one, and `ownDatabase` still stops only what it started.

## Why the binaries are driven directly

`embedded-postgres`, the package these binaries belong to, resolves them and runs
`initdb` as a `postgres` user when the caller is root. It does the second with
`child_process.spawn`'s `uid`/`gid`, **which Bun ignores**: measured in the agent
image, `spawnSync("id", { uid: 65534 })` prints `uid=0(root)` under bun 1.3.14
and `nobody` under node 20. A sandbox runs as root, and `initdb` refuses to run
as root, so the wrapper's one remaining job is the one that does not work here.
`runuser -u postgres --` does work, and is four lines.

**Reopen when** Bun honours `uid` in `spawn`. The wrapper then deletes to a
constructor call, and this ADR should be revisited rather than the code quietly
kept.

## Cost

60MB per platform on Linux, 145MB on macOS, in `node_modules` — devDependencies,
never in a release archive, which ships a compiled binary and no `node_modules`
at all. MIT for the packages; the binaries are PostgreSQL-licensed, which the
dependency-review allow-list already accepts. Rollback is `bun run db:test:up`
plus reverting one file.

## Consequence, and what it does not fix

CI now runs the no-Docker path, which is deliberate: `ubuntu-24.04` is the only
machine that ever exercises `linux-x64`, and a workflow that started a container
first would leave the path this exists for unrun. `release` keeps the container,
because its smoke test runs the compiled *server* and never the suite.

This fixes **this repository's** gate. It does not fix the general case: a
project added to orchestrator whose tests need Docker — testcontainers, a compose
stack, an image build — still cannot run them inside a sandbox, and the honest
answer stays the one ADR 048 already gives, which is to escalate to the boss.
The general fix is a sandbox that can reach a daemon, and that is a decision
about the boundary in ADR 005, not a workaround in a test script.
