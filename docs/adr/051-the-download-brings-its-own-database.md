# 051 The download brings its own database

**Status**: accepted
**Date**: 2026-08-30
**Amends**: [038](038-postgres-and-what-it-cost.md) — bring-your-own is now the
override rather than the only option.

038 made `ORCH_DATABASE_URL` bring-your-own: "managed, remote, or the one
container in `docker/postgres-compose.yml`". Correct for a deployment, and it
left the documented install path unable to start.

The README's quickstart is `curl | tar`, `./orch-server`, with Docker and `uv`
named as the prerequisites and "one compiled binary, no toolchain" as the
promise. Neither README mentions PostgreSQL — the requirement is written in ADR
038, in `docker/postgres-compose.yml`, and in `config/default.yaml`, none of
which a person reads before running the three lines. The server opens its
database at `server.ts` before `Bun.serve`, so following the README verbatim on
a clean machine produces `ORCH_DATABASE_URL is unset` and no panel. The release
workflow found this on its own first run through the smoke step and fixed it for
CI by setting the variable, which left the archive still unable to start
anywhere else.

And the fallback the documentation named was not in the archive. `release.yml`
copied `roles config drizzle`; `docker/postgres-compose.yml` and `bun run db:up`
exist only in a git checkout. So the one turnkey database this project owns was
unreachable to exactly the people who needed it.

## What changed

With `ORCH_DATABASE_URL` unset, `start()` runs
`docker compose -f ROOT/docker/postgres-compose.yml up -d --wait` and connects to
what comes up. The variable still wins, so managed and remote PostgreSQL are the
same single line they were. The archive now carries `docker/`, and the guard in
`test/governance/workflows.test.ts` that already enforced `drizzle/` covers it.

Docker is not a new dependency: the sandboxes cannot open a container without
it, the README requires it, and `images.ts` and `preflight.ts` already shell out
to it. The compose file is not a new definition either — it is the one `db:up`
starts, with one change: `${ORCH_POSTGRES_PORT-5432}` where the port was
literal. The `-` rather than `:-` is the whole of it. Unset still means 5432, so
`db:up` and the `.env` beside it are untouched; **empty** publishes
`127.0.0.1::5432`, which is Docker's own instruction to draw a free port. The
server passes empty when nobody pinned one.

Choosing the port ourselves was the alternative and it is worse in both
directions. A port this process probes as free is not a port it holds — between
the probe and compose binding it, anything may take it, and on this machine that
anything is the sandbox server, which draws ephemeral ports for its egress
sidecars and has already lost that race to itself (`failed to bind host port
0.0.0.0:57714/tcp`, in this file's own history). Scanning a range is the same
race with more code. Docker allocates, and it does not race itself.

Four details that are decisions rather than mechanics:

- **`start()`, not `open()`.** `open()`'s other callers are
  `scripts/embedding-check.ts` and `test/platform/schema.test.ts`. A test file
  that starts a container because a variable was unset is a worse surprise than
  the one being fixed.
- **The password is a file**, `dataDir/postgres.password`, mode 600, created
  with `wx` so two boots racing produce one value. `POSTGRES_PASSWORD` is read
  by the image's initdb on an empty volume and never again, so a password
  generated per boot authenticates against nothing from the second start
  onwards — which reads as a corrupt install rather than as the bug it is.
- **The address is asked for, never assumed.** `docker compose port postgres
  5432` after `--wait`, and the URL is built from what it answers. Necessary
  because Docker's choice is knowable no other way, and because it *moves*:
  measured across one stop and start, 32768 became 32769. It is also what makes
  a pinned port honest — a container believed to be at an address it never took
  is how a connection reaches somebody else's PostgreSQL and migrates it.
- **No span**, though it waits on Docker for as long as an initdb takes.
  `configureTracing` reads its configuration out of the database this call is
  opening; a span here has nothing behind it to export. Recorded here rather
  than left to be found as an omission.

## Consequences

A machine that runs `./orch-server` with no database gets one, on a port Docker
chose, holding its data under `dataDir` beside the turn logs — one directory to
back up, which is what the compose file's volume was already arranged for. The
address is printed on the way up, because a port nobody chose is a port nobody
can guess when they want `psql`. `ORCH_POSTGRES_PORT` pins it for anyone who
wants the address to stay put. A failure names both ways out, since neither is
guessable from Docker's own error.

`ORCH_DATABASE_URL` stays an environment variable rather than becoming a key
here, and this ADR is where the question keeps being asked, so: `ORCH_HOST`,
`ORCH_PORT` and `ORCH_DATA_DIR` are keys in `config/default.yaml` because they
are not secrets. That file is committed, and a connection string in it is a
password in the next commit and in every release archive built from it. The file
for it already exists and is already read — a `.env` beside the binary, measured
on the compiled release binary — and neither README said so. Now they do.

Footnote, since it was found while tracing this: 038 says tests run on
`@electric-sql/pglite`. They have not for some time — the package is in neither
`dependencies` nor `devDependencies`, and `openMemory()` connects to the
container on 5433. The ADR is left as written; this is the correction.
