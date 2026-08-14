# 005 the sandbox is the boundary, not a deny-list

**Status**: accepted and implemented, except the vault (see Open)
**Date**: 2026-08-14
**Supersedes**: 001's write-confinement half. 001's transport finding (localhost
TCP over unix socket) stays true for the host-mode code that still exists.

## Why

001 measured that the built-in sandbox is **deny-only**: allow-lists cannot carve
exceptions out of a `denyWrite`, so "only this worktree is writable" is not
expressible. It accepted the ceiling: *a path nobody thought to deny is writable*.

Everything since has been paying that bill. `clearance.ts` generates deny-lists,
`denyOutsideOwns` computes the complement of the owned files, `confine()` wraps
srt and hardcodes eight package-manager cache paths, `setupRefusal` is an
admitted command blocklist, `postGit` is a host RPC that exists because the agent
cannot write `.git`, `handleDenials` translates silent refusals into escalations,
`reconcileOwnership` reverts writes after the fact.

A container inverts the proposition: the agent cannot reach the host at all, and
the host offers a finite set of actions through `orch`. Hard constraint 2 stops
being "the sandbox's only gap" and becomes "the only interface".

## What we measured

OpenSandbox 0.1.11 (JS SDK) + `opensandbox-server` on the Docker runtime,
macOS 15 / Apple Silicon / Docker 29.4, real sandboxes. Observed, not inferred —
several results contradict the project's own docs.

### Setup

| Thing | Result |
|---|---|
| Aliyun registry from the docs | `docker pull` fails: auth endpoint returns EOF. **Unusable from here** |
| Docker Hub `opensandbox/*` | works, and is what the shipped config actually references |
| Image sizes | `execd` 79MB, `egress` 398MB, `code-interpreter` **7.04GB** |
| Containers per sandbox | **2** — the sandbox plus its egress sidecar |
| `Sandbox.create`, image cached | **2.2–2.6s** |
| SDK default request timeout | 30s — an image pull blows through it. Pre-pull or raise `requestTimeoutSeconds` |
| SDK default resources | **`cpu: "1"`, `memory: "2Gi"`** |

### Network

| Policy | Result |
|---|---|
| no `networkPolicy` | everything reachable |
| `defaultAction: deny` + `allow <fqdn>` | works: named host reachable, everything else refused |
| `defaultAction: deny` + `allow "*"` | **matches nothing.** `*` is not "all"; wildcards are leftmost-label only (`*.example.com`) |
| `defaultAction: allow` + `deny <fqdn>` | works — blacklist shape |
| IP/CIDR as a `NetworkRule.target` | the SDK type says unsupported in the egress MVP; not needed once `defaultAction: allow` is used |
| `host.docker.internal` from inside | reaches a host listener bound to **127.0.0.1** — on Docker Desktop only. Docker Engine on Linux has no such name |

### Credential Vault

| Thing | Result |
|---|---|
| injection under `defaultAction: allow` | **works** — the docs say `defaultAction="deny"` is required. Not true on the Docker runtime |
| injection semantics | **replaces** an `Authorization` header the client already set. The fake value in the sandbox never reaches the wire |
| MITM CA | trusted by a stock `alpine:3` + curl with no CA install |
| survives `pause`/`resume` | **yes** — revision, credentials and bindings intact, injection still works. The docs' warning is about Kubernetes (pod delete + snapshot), not Docker |

Probed with synthetic values only; no real credential was used.

### The egress image the example config ships is too old

`egress:v1.1.4` — what `opensandbox-server init-config --example docker` writes —
403s **every** scoped package fetch as soon as a vault exists:

| egress | vault bound | `/is-odd` | `/@types%2fnode` | `/@types/node` |
|---|---|---|---|---|
| v1.1.4 | no | 200 | 200 | 200 |
| v1.1.4 | **yes** | 200 | **403** | 200 |
| **v1.1.6** | yes | 200 | **200** | 200 |

npm and bun both send the `%2f` form, so on v1.1.4 no JS project can install
anything while a credential is bound. Narrowing the binding with `paths` does not
help; the binding named `api.anthropic.com` and the rejection happened on
`registry.npmjs.org`.

Not a leak, which was the other candidate and the more serious one: an unbound
host (postman-echo, which echoes what it received) saw no injected header and no
trace of the credential. Injection is correctly host-scoped in both versions.

The addon on `main` (`components/egress/mitmscripts/system.py`) handles this
deliberately — `allow_single_encoded_slash` exists with the comment *"legit for
npm scoped package registry paths"* — so the fix shipped between v1.1.4 and
v1.1.6. **Pin v1.1.6 or later**, and treat the example config's version as
whatever was current the day it was written.

### claude in a container

| Thing | Result |
|---|---|
| `npm i -g @anthropic-ai/claude-code` in `node:22` | fine, 2.1.232 |
| well-formed but invalid `CLAUDE_CODE_OAUTH_TOKEN` | `API Error: 401 OAuth access token is invalid` — **the CLI does not validate locally**, it sends the token and the server rejects it |

That is what makes the vault path work for claude: a format-plausible fake in the
env, the real token injected at the sidecar.

### Lifecycle

| Thing | Result |
|---|---|
| `pause` / `resume` | real `docker pause`/`unpause`; state `Running` ↔ `Paused`; filesystem survives |
| does `pause` free resources? | **no** — the container still exists, disk is not reclaimed. Only `kill` frees anything |
| TTL | `expiresAt` is the backstop; a crashed spike left a sandbox + sidecar running until removed by hand |

### The sandbox is a working research environment

Measured from inside, with `defaultAction: allow`:

| From the sandbox | Result |
|---|---|
| `bun.sh/docs`, `api.github.com`, `registry.npmjs.org` | 200 |
| `api.anthropic.com/v1/models` with no credential | 401 — reached, and refused by the API rather than the network |
| a domain in the project's `denyDomains` | blocked outright |

So WebFetch and an agent's own `curl` both work, and the blocklist is a real
control rather than a decorative one.

### Cost of a turn's worth of work

`files` API is cheap, `commands.run` is not:

| Call | Median |
|---|---|
| `files.writeFiles` (small) | 5ms |
| `files.readFile` | 1ms |
| `files.search` | 1ms |
| `commands.run` | **~1000ms** |

This repo's own workload inside a sandbox (`oven/bun:1`, tarball uploaded):

| Step | `cpu: 1` (default) | `cpu: 6` | host |
|---|---|---|---|
| `bun install --frozen-lockfile` | 5.5s | 6.6s | — |
| `tsc --noEmit` | 7.6s | **3.2s** | 2.07s |
| `bun test test/lease-args.test.ts` | 1.5s | 1.4s | — |

The 3.7x gap at the default was the one-CPU limit, not virtualization. There is
no bind mount anywhere in this — the checkout lives on the container's own
overlay fs, which is why the usual macOS Docker filesystem penalty never appears.

## Decision

1. **The sandbox is the write boundary.** `clearance.ts` and every deny-list that
   feeds it goes away. Tool allow-lists move to `roles/*.yaml`, which is what
   they always were.
2. **Transport is a file mailbox over the `files` API**, not `host.docker.internal`.
   The name only exists on Docker Desktop, so it is not an answer on Linux or
   WSL; the files API behaves identically everywhere and costs 1–5ms.
   `commands.run` at ~1s is for turns and gates, not for chatter.
3. **Egress is `defaultAction: allow` plus a per-project blacklist.** The vault
   still injects under it, so open web access and credential protection are not
   a trade — both. WebSearch/WebFetch go to every role.
4. **Credentials live in the vault, never in the sandbox.** The Anthropic and
   OpenAI credentials are bound at the sidecar and the environment holds decoys.
   Requires `egress:v1.1.6` or later — preflight should check it, because on
   v1.1.4 the failure is "this project cannot install its dependencies", which
   nobody traces back to a credential.
5. **Our own image** (`docker/agent.Dockerfile`, 1.5GB), not `code-interpreter`
   (7GB) and not a bare `ubuntu:24.04`. Measured per sandbox: **3.8s** to a
   usable one, against **340.9s** for ubuntu plus apt plus npm — the bare image
   is the smaller pull, paid once, and the larger cost, paid by every group.
6. **`pause` is not a resource-release mechanism.** Dissolving a group means
   `kill`. TTL + renew is the liveness story, and it needs a watchdog rule
   (hard constraint 7) or a crashed orchestrator leaks two containers per group.

## Open

- **No end-to-end run yet.** It needs a purpose-built image (bun + node + git;
  the official code-interpreter is 7GB and `tsc` needs node) and a server left
  running in `dns+nft` mode.

## Ceiling

- File ownership inside the checkout is no longer enforced before the write.
  `reconcileOwnership` (post-turn revert) becomes the only mechanism. "L1 may not
  touch package.json" has to become a pre-commit hook inside the sandbox, or be
  accepted as a rollback.
- A Python daemon and Docker are now hard dependencies of running any agent.
  Preflight must assert them and **must not silently fall back to host mode** —
  001's lesson was that every quiet failure looked exactly like success.
- The vault's protection assumes the egress sidecar is in the path. If a future
  config drops `credentialProxy.enabled` the failure mode is a 401, not a visible
  "vault off". Preflight asserts it.
