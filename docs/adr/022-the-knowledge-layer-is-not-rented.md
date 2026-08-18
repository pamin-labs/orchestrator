# 022 The knowledge layer stays ours

**Status**: accepted
**Date**: 2026-08-18

`orch ctx query` assembles, inside one turn's 16k budget, the group's slices and
their acceptance lines, its gate and lease state, its unanswered questions, where
code lives, and the notes that match. Every agent-memory framework was checked
against that job.

| Candidate | Measured | Why not |
|---|---|---|
| cognee, graphiti-core, langmem, zep self-hosted | **not on npm at all** | Python-only; this is Bun/TS |
| `@letta-ai/letta-client` 1.12.1 | zero deps, but an API client | needs a Letta server |
| `mem0ai` 3.1.6 | deps `openai`, `axios` | self-hosting wants a vector store and a service; the `openai` path violates the one hard constraint |
| `@mastra/memory` 1.26.2 | the only pure-TS, serverless one | models conversation threads, and arrives with the whole Mastra framework |
| `semantica` 0.6.5 (8.7k★, active) | REST and MCP, so reachable | decision provenance for regulated work — `record_decision`, `trace_decision_chain`, PROV-O audit trails. Cheapest wiring (embedded Oxigraph + PgVector + local embeddings) still adds a Python service, to replace 168 lines |
| `pageindex` 1.0.1 | 2 stars, 3 commits, PDF only, **no incremental update** | ours is incremental by content signature, takes an injected `Ask`, and attributes cost |

The reason that does not depend on the ecosystem: these store **conversation
facts**, and this layer stores **project state**. `ctx.ts`'s `sliceContext` and
`groupContext` read acceptance criteria, gate results and PR numbers straight out
of `slice`, `grp`, `escalation` and `lease`. That schema is ours. The only part
any of them could take over is note retrieval — already Orama, already 168 lines.

**Consequence**: vector and hybrid retrieval are a field on the existing schema
and a mode passed to `search`, not a second system. Embeddings are generated
locally, so they are not a model call and do not touch the sandbox constraint.

**Reopen when**: something needs entity resolution across projects, which is the
one thing a graph buys that a scoped index does not.
