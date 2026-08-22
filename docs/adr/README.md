# Decisions

Design changes made while building this. One decision per file, named `NNN-kebab-title.md`.

**Not the same thing as a runtime `note(kind=decision)`** — that is a decision an agent recorded while working a project; this is a decision made while building the orchestrator itself.

Format — keep it short, meaning **as short as the evidence fits in**, not a line count:

"≤10 lines" used to be written here while the actual median was over 25 and the
longest was 372. A rule nobody follows does not shorten anything; it teaches the
next person either to ignore it or to delete the measurements to meet it. The
real test is whether a reader can tell, without opening the code, why it was
decided that way and what would make it worth revisiting.

```markdown
# 001 Use bun instead of node

**Status**: accepted
**Date**: 2026-08-13

Bun ships sqlite, HTTP, SSE and subprocess management in one runtime.
Node would need better-sqlite3 + a server framework.

**Consequence**: bun becomes a hard dependency; no build step needed.
```

The initial design decisions all live in `docs/project/plan.md` and are not repeated here. This directory records **where the build departed from `docs/project/plan.md`**.
