# 001 orch talks over localhost TCP, not a unix socket

**Status**: accepted
**Date**: 2026-08-13
**Deviates from**: PLAN.md §2 and §10, which specified a unix socket.

## What we measured

Probed Claude Code 2.1.228's built-in sandbox with real `claude -p` runs (haiku,
throwaway dirs). Every claim below is observed, not inferred from docs.

| Config | Result |
|---|---|
| `sandbox.enabled` alone | `denyRead` works. **Writes outside cwd are NOT restricted** — a write to a sibling directory succeeded |
| `filesystem.denyWrite` | works |
| `filesystem.allowWrite` inside a broader `denyWrite` | **does not re-open it** — deny wins, so allow-lists cannot carve exceptions |
| `network.allowUnixSockets: ["<exact path>"]` and `["/tmp/orch-*.sock"]` | **no effect** — connect still refused |
| `network.allowAllUnixSockets: true` | orch reachable — **and so is `/var/run/docker.sock`**, even with that path in both `denyRead` and `denyWrite`. Filesystem deny does not block socket connect |
| `sandbox.excludedCommands: ["orch"]` | **unsandboxes the entire command line.** `orch && echo B > <denyWrite path>` created the file |
| `network.allowedDomains: ["127.0.0.1","localhost"]` | localhost TCP still refused |
| `network.allowLocalBinding: true` | **localhost TCP works, unix sockets stay closed** |

## Decision

`orch` reaches the orchestrator over **localhost TCP** (127.0.0.1, ephemeral
port), and agent profiles set:

```json
{ "sandbox": { "enabled": true, "failIfUnavailable": true,
  "autoAllowBashIfSandboxed": true, "allowUnsandboxedCommands": false,
  "network": { "allowLocalBinding": true, "allowAllUnixSockets": false } } }
```

## Why the alternatives are worse

**`excludedCommands: ["orch"]`** was the most attractive option — one narrow,
auditable hole. It is not narrow: the exclusion applies to the whole command
line, so `orch status "x" && bun test` runs entirely unsandboxed. An agent would
trigger this innocently, by writing the shell one naturally writes. Rejected.

**`allowAllUnixSockets: true`** opens the Docker socket, which is present on this
machine via OrbStack. That is a one-line full host escape (`docker run -v /:/host`)
and filesystem deny rules do not close it. Rejected.

## Consequences

1. `failIfUnavailable: true` is mandatory. Every quiet failure above looked
   exactly like success, so the sandbox must refuse to start rather than
   silently degrade.
2. Write confinement is **deny-only**. There is no way to say "only this
   worktree is writable", so profiles are generated per group and deny: the
   main checkout, sibling worktrees, and the sensitive parts of `$HOME`.
   *Ceiling*: a path nobody thought to deny is writable. Accepted for now —
   worktrees live outside `$HOME` so the blast radius is scratch space.
3. Localhost TCP means an agent can reach other services on 127.0.0.1. Smaller
   surface than the Docker socket, but real. The orch API requires a per-agent
   token from the environment so agents cannot act as one another.
4. Unix socket paths are capped near 104 bytes on macOS (hit `ENAMETOOLONG`
   during the probe). Moot now, but it is why "just put the socket in the data
   directory" would not have worked either.

## Re-test when

Claude Code's sandbox implementation changes. `test/clearance.test.ts` asserts
the profile shape; `test/sandbox-probe.sh` re-runs the live matrix above.
