# Decisions

开发期的设计变更记录。一个文件一个决策，命名 `NNN-kebab-title.md`。

**和运行期的 `note(kind=decision)` 不是一回事** —— 那个是 agent 在做项目时产生的决策记录，这个是我们开发 orchestrator 本身时的决策。

格式（保持短——**能装下证据的最短长度**，不是一个行数）：

「≤10 行」曾经写在这里，而实际的中位数在 25 行以上，最长一条 372 行。一条没人
遵守的规则不会让文档变短，只会让下一个人要么忽略它、要么为了守它删掉度量数据。
真正的判据是：读的人能不能不去翻代码就知道当时为什么这么定，以及什么条件下该重估。

```markdown
# 001 Use bun instead of node

**Status**: accepted
**Date**: 2026-08-13

Bun ships sqlite, HTTP, SSE and subprocess management in one runtime.
Node would need better-sqlite3 + a server framework.

**Consequence**: bun becomes a hard dependency; no build step needed.
```

初始设计决策全部在 `docs/project/plan.md` 里，不重复记录。这里只记**开发过程中偏离 `docs/project/plan.md` 的地方**。
