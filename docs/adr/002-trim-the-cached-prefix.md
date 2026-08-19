# 002 Trim the prompt prefix: --tools, --disable-slash-commands, --setting-sources

**Status**: accepted; the `--disable-slash-commands` half is superseded by 006.
Its help line is "Disable all skills", and that is what it did — the saving below
was paid for with the whole skill feature. Skills are now a read-only mount of the
set the boss ticked, so the prefix carries what was chosen rather than everything
or nothing. The `--tools` and `--setting-sources` findings still hold.
**Date**: 2026-08-13
**Adds to**: docs/project/plan.md §7 token economics (a lever that section did not have).

## What we measured

Same live task twice (create a file, write a journal entry, mark the task done),
same `trivial` slice on haiku, real `claude -p` runs:

| | before | after |
|---|---|---|
| built-in tool definitions loaded | 31 | 6 |
| skills / slash commands in the prefix | 16 / 47 | 0 / 0 |
| `cache_creation_input_tokens` (the prefix) | 46,117 | **17,609** |
| cost for the identical task | $0.1170 | **$0.0592** |

Output was identical (`hello.txt` containing `hi`, one exported decision journal).

## The finding

`--allowedTools` gates *permission*; it does not trim the tool *definitions*
injected into the prompt. A turn allowed only `Bash(orch *) Read Edit` was still
carrying schemas for Task, Workflow, Monitor, CronCreate, DesignSync,
RemoteTrigger, SendMessage, Skill and twenty others, plus the whole skill
catalogue and slash-command list — about 46k tokens of prefix on every turn.

## Decision

Every spawn now passes:

- `--tools <exactly what the whitelist implies>` — derived from `allowedTools`
  by `toolsFromAllowed()`, so the two can never drift apart
- `--disable-slash-commands` — drops the skill catalogue
- `--setting-sources project,local` — excludes the boss's user-level settings,
  so agents do not inherit their personal `CLAUDE.md`, plugins or output styles.
  Agents should follow their role prompt, not the boss's editor setup.
- `--strict-mcp-config`

`tools` is part of the stable-half hash, so changing it rotates the session
rather than silently invalidating the cached prefix.

## Consequences

- A role that needs a tool must list it in its whitelist. Previously a missing
  entry only caused a permission denial; now the tool is not loaded at all. The
  denial path still surfaces it as an escalation, so the failure is visible.
- Agents lose access to skills. That is deliberate — a skill invoked inside a
  turn is unbudgeted work the orchestrator cannot see or account for.
- Prefix cost is now dominated by the role prompt plus the onboarding pack and
  lessons list, which is exactly where we want it: content we author and can
  measure, rather than a catalogue we never asked for.
