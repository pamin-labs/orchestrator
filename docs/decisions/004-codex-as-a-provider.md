# 004 codex agents run workspace-write with network, and ownership is checked after the turn

**Status**: accepted; decisions 1, 2 and 4 superseded by 005. codex now runs
`--dangerously-bypass-approvals-and-sandbox` inside the group's container, so
there is no `-s workspace-write` line, no `Provider.confinesWrites` and no host
`CODEX_HOME` — the decoy `auth.json` is written into the container instead.
Decision 3 (ownership checked after the turn) is now how it works for **both**
runtimes, not just codex.
**Date**: 2026-08-13
**Extends**: 001, which measured the claude sandbox. This is the same exercise for the other CLI.

## Why

claude carried every role while its 5-hour and weekly windows were the binding
constraint and the codex account sat unused. `RoleDef.runtime` had existed since
the first version and no role had ever set it — the switch was there, nothing was
wired behind it: `difficultyModel` held only claude model ids, so a `runtime:
codex` role would have been handed `claude-sonnet-5` and `codex exec -m` would
have rejected it outright.

## What we measured

codex-cli 0.147.0 on macOS (`codex update` reports it is the latest). Every row is
an observed run, not a doc claim.

| Probe | Result |
|---|---|
| `codex sandbox -- curl https://example.com` | DNS failure — the default sandbox has **no network** |
| `codex sandbox -- curl http://127.0.0.1:<listening port>` | refused — **loopback is not an exception** |
| `-c sandbox_permissions=[]` / `["network-full-access"]` | no effect either way. 0.147 does not know the key; the orchestrator had been passing the empty form and calling it a sandbox |
| `-s workspace-write -c sandbox_workspace_write.network_access=true` | external HTTP 200, loopback connects |
| `-c sandbox_workspace_write.writable_roots=[subdir]`, then write to cwd | **succeeded** — writable_roots only adds; cwd cannot be taken away |
| permission profiles (`default_permissions` + `permissions.x.base="read-only"` + `network.enabled`) | **SIGABRT**. Same with the `":read-only"` spelling and with `--enable network_proxy` |
| `--ignore-user-config`, then a one-shot prompt | still emitted "Skill descriptions were shortened to fit the skills context budget" — **user skills load anyway** |
| `CODEX_HOME=<dir with only auth.json symlinked>` | the notice disappears; the login still works. Same prompt: **16336 input tokens vs 17327** on the boss's home |
| `token_count.info.model_context_window` | **272000** for the gpt-5.6 family |
| a real turn under the shipped argv, calling `curl http://127.0.0.1:<port>` | `ORCH-OK`, exit 0 — an agent can reach the orchestrator |

Also relevant, from upstream: [openai/codex#10390](https://github.com/openai/codex/issues/10390)
— `network_access` written into `config.toml` is ignored by the macOS seatbelt.
Passing it as an argv `-c` does work, which is what the adapter does.

## What follows

**1. Sandbox: `-s workspace-write` with network on.** `orch` is HTTP to
127.0.0.1 and it is the only channel an agent has, so a sandbox without loopback
is a mute agent. codex offers one network switch, not claude's loopback-only
`allowLocalBinding`, so the stated ceiling is that a codex role can reach the
public internet. That is also how it does web research, which claude roles get
through WebFetch/WebSearch — tools that never touch the Bash sandbox.

The shape we want is the beta permission profiles (`base="read-only"` +
`network.allow_local_binding` + a domain allowlist). Marked `ponytail:` in
`buildArgv`; swap when they stop crashing.

**2. File ownership moves after the turn.** `denyOutsideOwns` builds a deny-list
for claude's settings profile and the write never happens. codex has no equivalent
and cwd is always writable, so `outsideOwns()` runs the same rule against `git
status --porcelain` once the turn ends, reverts what strayed, and tells the boss.
Same rule, later clock — still an `if`, not a line in a prompt.

This is expressed as `Provider.confinesWrites` rather than as
`if (runtime === "codex")`, so a third provider has to answer the question.

**3. QA loses its tool whitelist; the slice budget replaces it.** `allowedTools`
is a claude settings mechanism. QA's narrow list (Grep, no Read) was a cost
control, not a safety boundary — and cost control already had a deterministic
home in `slice.budget_tokens`. Which had never been INSERTed, so it was NULL on
every row and the two admission checks in `scheduler.ts` had never stopped
anything. Defaults now come from `config.sliceBudgetTokens`, sized from the 16
slices in this checkout that spent anything: trivial averaged 4.0M with one 12.0M
runaway, normal 7.3M with a 16.1M tail.

**4. `CODEX_HOME` is the analogue of `--setting-sources project,local`.**
`--ignore-user-config` drops config.toml and leaves the skills. The prefix
difference is about 1k tokens a turn, not the 46k measured on the claude side
(002) — so the size is not the argument. The argument is that the boss's
config.toml pins a model and an effort, and a role that names its own must win.
The home holds a symlink to the real `auth.json` so this and the boss's own codex
refresh the same token.

**5. AGENTS.md is symlinked to CLAUDE.md** when a project has one and not the
other. Same instructions, two filenames.

**6. The rotation denominator is per model.** Unrelated to codex, found while
wiring it: `overTokenBudget` divided by a literal `200_000` for every model. This
repo's own turn logs report 200k for haiku-4-5 and **1M for sonnet-5 and opus-5**,
and codex reports 272k — so the strong models had been rotating their session at
12% of their window, discarding a cached prefix each time. Now `config.contextWindow`
seeds it, whatever the CLI reported during the turn overrides it, and
`contextWindowFor` clamps the result to [100k, 2M] so a missing or absurd value
cannot produce a session that never rotates or one that rotates every turn.
