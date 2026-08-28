# 048 A project states its own gates, so there is nothing to approve

**Status**: accepted. Supersedes the proposal-and-approval design in this round's plan.
**Date**: 2026-08-29

## Context

`detect.ts` was a table of six stacks — node, cargo, go, python, dotnet,
just/make. Miss it and `detectGates` returned `[]`, which `gate.ts:92` treated as
**fail every slice**, with a message telling the boss to write the gates by hand.
Elixir, Zig, Swift, OCaml, and any Makefile whose target is not called `test` got
that. No table will ever have every row.

Underneath it, a second gap: `docker/agent.Dockerfile` held bun, node, git and
ripgrep, because those are what *this* project needs. Every other project arrived
to find no compiler.

## Decision: three layers, all of them reads

1. **What the repository already committed.** `devcontainer.json` (read, not run),
   `mise.toml` / `.tool-versions` / `.nvmrc` / `.python-version` / `.go-version`,
   the CI workflow, `Taskfile.yml`, mise tasks, `package.json` scripts. One pass
   answers both halves — how to build the environment and how to verify it —
   because a CI workflow writes both down.
2. **mise for the toolchain.** It reads all nine ways a repository declares a
   version and installs exactly that. The per-language install logic that would
   otherwise live in `detect.ts` was never written.
3. **The bootstrap agent**, only when the first two find nothing. It already runs
   at that point — it is the turn that works out the install — so most projects
   do not pay an extra one. It proposes through `orch setup --gate name=command`,
   and the route below checks the proposal rather than approving it.

Convention beats CI where both exist: a CI step is written for a machine that has
the services CI starts, so preferring it would trade "no gate" for "a gate that
cannot pass" — and the second is worse, because it reads as the agent's fault,
once per slice.

## Why the plan's approval ladder was not built

The plan specified `config_json.proposed_gates`, an `orch setup --propose-gate`
flag, and three tiers — auto / PM / boss — on the reasoning that an agent
proposing a command needs somebody to approve it.

That premise did not survive the first layer. Every command the discovery above
produces is one **the repository itself committed**: a `package.json` script, a
CI step, a Taskfile target. The plan's own tier 0 was "the command's head is an
entry the repository declared" — and after discovery became deterministic, that
is every command there is. A ladder whose top two rungs are unreachable is
machinery, a config key, a CLI flag and an escalation path for a case that does
not occur.

## What replaced approval: two machine checks

The third layer needs *some* answer to "may this command be registered", and the
ladder's answer was a person. Two deterministic checks cover the same ground, and
both are things a person could not do as well:

- **Declared.** The command is one the repository itself committed — a package
  script, a Makefile or justfile target, a `Taskfile`/`mise` task, a CI step, a
  `postCreateCommand`. `declaredCommands` enumerates those in any language,
  because enumeration is the half of detection that never runs out of table rows.
  A command the repository merged is a command its owners approved.
- **Proven.** It is not declared, but it ran here — through `proveGate`, the same
  `runOneGate` a real gate goes through, so the tokenisation, the timeout, the
  error digest and the log are the ones the gate will have — and it passed.
  `rebar3 eunit` in an Erlang repository with no CI is the case this exists for:
  undeclared, and a passing run is better evidence than a declaration.

Neither, and it is refused with the exit code, the output, and the list of what
the repository *does* declare. An agent may point at a command; it may not invent
one and have it registered unseen. Anything carrying shell grammar is refused
before it runs, with the reason — `lease.ts` tokenises on whitespace, so `a && b`
would hand `&&` to `a`.

This is the plan's tier 0 test, kept, with tier 1 and tier 2 replaced by evidence
rather than by an escalation. The boss is still asked when a repository declares
no entrypoint at all and no proposed command runs, which is the one case where
the answer really is a person's.

The trust boundary the ladder was protecting did not move: `resource` is still
written only by the registration path in `flow/start.ts`, lease templates still
tokenise on whitespace and never reach a shell, and anything carrying shell
grammar, a redirect, a substitution or a `${{ … }}` is **skipped rather than
mangled** — a gate that looks like it ran and did half of nothing is the failure
this avoids.

`toolchain` and `install` stayed two named fields rather than the plan's
`setup: string[]`. `start.ts:87` replays them in order, which is what the array
was for; two steps that mean different things do not need an untyped list to sit
in.

## "This project has no tests" is an answer

`gates: []` no longer means fail-everything. `review.ts:190` records
`gate: "none"` and passes. `gates: undefined` — never detected — raises to the
boss instead, because those are different facts and only one of them is a
decision somebody made.

## Consequence

A project orchestrator has never seen is drivable without anyone writing a table
row for it. The cost is that a wrong CI-derived gate is now possible where before
there was simply no gate.

**Revisit when** a real project's derived gates are wrong often enough to cost
more than they save. That is when the plan's proposal tier becomes worth
building, and it should be built against measured false positives rather than
against the expectation of them.

**Also revisit** if "proven" turns out to accept commands that pass at bootstrap
and fail forever after — a suite that needs a service the container does not
have would fail the proof, but one that is green because it ran nothing would
pass it. `discriminate` ([`049`](049-the-review-half-gained-two-layers-and-neither-casts-a-vote.md))
is the layer that catches that, and it is the reason this one does not have to.
