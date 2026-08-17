# 006 Skills are mounted, not only injected

**Status**: accepted
**Date**: 2026-08-15
**Amends**: 002 (which turned the catalogue off wholesale), docs/project/plan.md §4 技能, §5 spawn.

## The problem

`--disable-slash-commands` reads like "no `/foo` typed at an agent". Its help line
is `Disable all skills`, and that is what it did: an agent could not use a skill at
all, by any route. So `/impeccable` sent to an Engineer did nothing, and 002's
saving was paid for with the whole feature.

What remained was the injection path: the boss names a skill in a requirement, the
orchestrator reads that SKILL.md on the host and appends it to that one turn's
delta. That is genuinely good — one turn pays for one skill, the cached prefix is
untouched — but it is boss-driven. An agent twenty turns into a slice cannot reach
for the skill that would have told it how to do the thing it is doing, because it
has no idea the skill exists.

The container made this worse rather than better. A skill's `reference/*.md` and
scripts used to be one `Read` away; after 005 the agent is in a container and the
path in the message points at the host's home directory, which is not there.

## Decision

Both paths, for different jobs.

1. **Mounted.** `stageSkills` copies the ticked user-scope skills into
   `skillsDir` on the host — `/var/tmp/orch-cache/skills`, not under `dataDir`,
   because the sandbox server only mounts host paths on its own
   `allowed_host_paths` — and every sandbox mounts that directory read-only at
   `/root/.claude/skills` and `$CODEX_HOME/skills`. The CLIs discover them the way
   they discover any skill.

   Three flags had to change together, and each was measured, because any one of
   them alone leaves the feature doing nothing:

   - `--disable-slash-commands` is gone. Its help line is `Disable all skills`.
   - `Skill` is in `--tools`, for every role. With `--tools` set and `Skill` not
     in it, no catalogue loads at all: an agent asked to list its skills answers
     NONE.
   - `--setting-sources` includes `user`. Under `project,local` the CLI does not
     look at `$HOME/.claude/skills`, which is where the mount is. That flag
     excluded `user` because inheriting the boss's home measured ~195k cached
     tokens on a trivial turn — but that was on this machine. In a container HOME
     is `/root` and the only thing in it is what we put there.
2. **Injected.** Unchanged. A skill named in a requirement is still read on the
   host and appended to that turn's delta — including one that is not ticked.

Which skills are ticked is a server-scope setting (`setting` table, key
`skills.off`), edited in 设置 › 技能. The stored value is the **off** list, so a
skill installed tomorrow is available tomorrow without anyone going back to tick
it.

## Why copy rather than mount the real directories

Both skill directories on a real machine are symlink farms —
`~/.claude/skills/impeccable -> ../../.agents/skills/impeccable`, and codex's point
into its plugin cache. Mounting `~/.claude/skills` into a container gives you a
directory of dangling links whose targets were never mounted. `cpSync(...,
{dereference: true})` is the whole fix, and deduplicating two directories into one
falls out of it.

The staging directory is updated **in place**. A rebuilt-and-renamed directory
leaves every running container mounted on the old inode, which is the kind of bug
that looks like a caching problem for a week.

## The cost, and who pays it

Every ticked skill's name and description sit in the cached prefix of every turn of
every agent. 002 measured the boss's whole set plus slash commands and tool schemas
at 46k; the skills' own share scales with how many are ticked. So the settings page
states the count and an estimate next to the tick boxes — 硬约束 5: the boss
decides, with the bill in view.

Project skills have no tick box. They live in the checkout the CLI already runs in,
so they are visible whatever this page says.

## Ceiling

- `SKILL.md`'s mtime stands for the whole skill when deciding whether to re-copy. A
  touched `reference/*.md` alone is missed until 重新扫描 or a re-tick.
- The mount needs the sandbox server's `allowed_host_paths` to include
  `skillsDir`, or container creation fails outright. Preflight names the exact
  path rather than pretending to have checked the server's own TOML, and a
  creation rejected for that reason retries once without the skills and says
  which path to allow — every group failing to start is a worse outcome than a
  feature none of them needs to run.
- codex reading `$CODEX_HOME/skills` is a directory convention, not something its
  docs state. `test/live/sandbox-live.test.ts` is what decides whether that half holds.
