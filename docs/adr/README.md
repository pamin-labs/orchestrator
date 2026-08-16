# Decisions

开发期的设计变更记录。一个文件一个决策，命名 `NNN-kebab-title.md`。

**和运行期的 `note(kind=decision)` 不是一回事** —— 那个是 agent 在做项目时产生的决策记录，这个是我们开发 orchestrator 本身时的决策。

格式（保持短，≤10 行正文）：

```markdown
# 001 Use bun instead of node

**Status**: accepted
**Date**: 2026-08-13

Bun ships sqlite, HTTP, SSE and subprocess management in one runtime.
Node would need better-sqlite3 + a server framework.

**Consequence**: bun becomes a hard dependency; no build step needed.
```

初始设计决策全部在 `PLAN.md` 里，不重复记录。这里只记**开发过程中偏离 `PLAN.md` 的地方**。
