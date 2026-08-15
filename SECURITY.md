# Security

## Reporting

Use GitHub's [private vulnerability reporting](../../security/advisories/new) —
not a public issue. It goes to the maintainers only, and you get a thread to
discuss the fix in before anything is published.

You will get a reply. This is a small project, so treat "within a week" as the
expectation rather than a service level, and say so in the report if you have a
disclosure deadline in mind.

## What is in scope

This project's whole design is a boundary, so the interesting reports are about
the boundary rather than about crashes:

- **Reaching the host from inside an agent's container** — the filesystem, the
  Docker socket, another group's container, the orchestrator's own process.
- **Getting a real credential.** The container holds format-valid decoys; the
  real value is substituted by the egress sidecar on the way out. Anything that
  ends with a real token inside a container, or delivered to an address an agent
  chose, is the report we most want.
- **Acting as another agent or another group** — the `orch` interface is the only
  thing an agent can use to change the world, and every verb is scoped to its
  caller.
- **Reaching the panel's API from a page the boss visits.** It listens on
  loopback with no login: whoever reaches it is the boss.

## What is not a vulnerability

Written down because they are deliberate, documented trade-offs rather than
oversights, and a report about one is a report we cannot act on:

- **Outbound network traffic is open by default.** Agents need to read
  documentation and install packages. Credentials are protected; **data is not**
  — an agent can send repository contents anywhere. `sandbox.denyDomains` is the
  control. See the README's *What the sandbox stops — and what it doesn't*.
- **Roles inside one group share a container.** The boundary is between groups,
  not between the Engineer and the QA of the same group.
- **The panel has no authentication.** It binds `127.0.0.1` and is meant to be
  behind your own reverse proxy if it is anywhere else.
- **An agent can spend money.** Budgets and the watchdog bound it; they do not
  make it zero.

## What we already know

Two things are recorded rather than fixed, and a report on either is welcome only
if it comes with a way past the mitigation described:

- The egress sidecar follows the container's own name resolution, so an agent can
  point a bound host name at an address it controls. What stops the credential
  arriving there is **upstream certificate verification** — measured, see
  `PROGRESS.md`. Turning that off in the sidecar's configuration would make it
  exploitable.
- `web_commit_signoff_required` and the `dco` check cover sign-off; commit
  signatures (GPG/SSH) are deliberately not required, because agents commit
  inside containers that hold no signing key.
