---
name: git-commit
description: Commit changes in this repository. Use when asked to commit, or after finishing a verifiable unit of work. Encodes this project's commit convention — conventional-commit prefix, a subject that states the finding, and a body that says what the failure looked like.
allowed-tools: Bash, Read, Grep
---

# Committing in this repository

Lives in the repo rather than in anyone's `~/.claude/skills`, so a contributor
gets it by cloning. If a personal `git-commit` skill is also installed, this one
wins for this project.

## Before anything

`bunx tsc --noEmit -p .` and `bun test` must pass. A commit whose tests were not
run is a commit somebody else has to bisect.

If another agent or session is editing the tree, `git add -A` sweeps their
half-finished work into your commit. Stage the files you changed by name.

## Format

```
<type>(<scope>): <subject>

<body>

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: <session url>
```

`feat` `fix` `docs` `test` `refactor` `perf` `build` `chore`. Scope is the
module — `sandbox`, `github`, `web`, `config`, `scheduler`.

**English**, always — code, commit messages, PRs and error strings are English
even though the panel is Chinese (`CLAUDE.md`, 代码风格).

## The subject states the finding, not the diff

The log is read by someone asking *why is this like this*. A subject naming the
change answers nothing they cannot already see.

```
fix(sandbox): update mount path                 ← says nothing
fix(sandbox): the skills mount was empty on macOS, and nothing could say so
```

```
fix(config): add github to ctx                  ← says nothing
fix(config): a key the server does not copy into Ctx does nothing
```

## The body says what the failure looked like

Not what you changed — the diff has that. What it cost, how it presented, and
why the fix is where it is. Three things worth including whenever they are true:

- **What the boss or the next developer actually saw.** An ENOENT that reads as
  *git is not installed* sends someone to install what they already have; that
  is worth more than the stack trace.
- **Why the fix is at this level.** "Fixed in the shared function rather than at
  each call site, so the fifth caller added next month is covered" is the
  sentence that stops the fix being undone.
- **What was deliberately not done, and why.** A stated limit outlives a silent
  one.

Measurements beat adjectives. `179 on the host, 0 in the container` is the
commit. "Fixed the mount" is not.

## Do not

- Do not commit or push unless asked. Ask first if the work is not obviously done.
- Do not commit on `main` without checking `CLAUDE.md` and the current branch —
  this project has worked directly on `main` when the boss asked for it, which is
  not the default.
- Do not include a `🤖 Generated with` footer in commits. The trailers above are
  the attribution.
