# Contributing

Thanks for looking. This is a small project with an unusual amount of written
reasoning behind it, so the most useful thing you can do before a first pull
request is read [`CLAUDE.md`](CLAUDE.md) — it is the house rules, and several of
them will otherwise look like arbitrary review comments.

## Before you write code

- **[`PROGRESS.md`](PROGRESS.md)** — where things are and what is known to be
  broken. The 反直觉事实 section is a list of things that were measured and are
  the opposite of what you would guess; changing one back is the most common way
  to reintroduce a bug here.
- **[`PLAN.md`](PLAN.md)** — the design. Design changes go in this file, not in a
  commit message.
- **[`docs/decisions/`](docs/decisions/)** — why a thing is the way it is.

## Running it

```bash
bun install
bun test                     # every check
bun run dev                  # build the panel and serve it on 127.0.0.1:47821
```

The sandbox parts need Docker and a running `opensandbox-server`; see the
[README quickstart](README.md#quickstart). `test/sandbox-live.test.ts` skips
loudly without one, which is fine — CI skips it too.

## What CI will ask of you

Two required checks, and both are cheap to satisfy locally:

**`check`** — `bunx tsc --noEmit -p .`, `bunx oxlint@latest --deny-warnings src
web/src test`, `bun run build:web`, `bun test`. Run them before pushing; the
suite takes about fifteen seconds.

**`dco`** — every commit carries a `Signed-off-by` line matching its author:

```bash
git commit -s -m "fix(sandbox): ..."      # adds the trailer
git rebase --signoff main                 # fixes a branch that forgot
```

This is the [Developer Certificate of Origin](https://developercertificate.org/):
signing off means you wrote the patch or otherwise have the right to submit it
under the project's licence. It is not a CLA and it assigns nothing.

## Commit messages

Conventional-commit prefix, and **a subject that states the finding rather than
the diff**. Someone reading the log a year from now is asking *why is this like
this*, and a subject naming the change answers nothing they cannot already see:

```
fix(sandbox): update mount path                 ← says nothing
fix(sandbox): the skills mount was empty on macOS, and nothing could say so
```

The body says what the failure looked like — what it cost, how it presented, and
why the fix is where it is. Numbers beat adjectives. Full version in
[`.claude/skills/git-commit/SKILL.md`](.claude/skills/git-commit/SKILL.md), which
is in the repository so you get it by cloning.

**English** for code, comments, commit messages, pull requests and error strings,
even though the panel's own text is Chinese.

## Pull requests

- One thing per pull request. If the description needs the word "also", it is
  probably two.
- Non-trivial logic leaves one runnable check behind — `bun test`, no framework,
  no fixture hierarchy.
- New state? `src/mech/ops/states.ts` and `src/mech/ops/invariants.ts` have to
  agree, and `test/invariants.test.ts` fails until they do. That is deliberate:
  a state nobody drives is how a group ends up looking healthy and going nowhere.
- Adding a UI component? Check shadcn/Radix first (硬约束 4). Hand-rolled
  dialogs and menus are how you end up with no focus trap and no Escape key.

## Reporting something

Bugs and ideas go in [issues](../../issues). Anything that looks like a way
around the sandbox, the credential vault, or the `orch` interface goes to
[SECURITY.md](SECURITY.md) instead — privately, not in an issue.
