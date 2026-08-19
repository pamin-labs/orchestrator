# 009 Executable engineering governance

**Status**: accepted
**Date**: 2026-08-17

Rules were concentrated in a growing agent prompt and repeated across root
files. That makes conflicts invisible and gives mechanical violations no owner.

Engineering policy is split into three layers: `AGENTS.md` contains navigation
and hard invariants, `docs/architecture` and `docs/standards` contain focused
contracts, and compiler/lint/audit/test/CI make decidable rules executable. The
enforcement matrix assigns one primary tool per risk. Fallow Review and
independent reviewers cover judgment after deterministic findings.

Project plan/progress move under `docs/project`, UI design under `docs/design`,
and development decisions under `docs/adr`. Legacy paths are source-guarded.

**Consequence**: a rule change updates its one authoritative document and its
executable owner together. Architectural exceptions require an ADR.
