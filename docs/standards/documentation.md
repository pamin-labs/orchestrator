# Documentation standard

Documentation has one home per responsibility:

- `AGENTS.md`: navigation, hard invariants, required AI workflow.
- `docs/project/`: active product goal, milestone, verified baseline, blockers,
  and at most five next actions.
- `docs/architecture/`: stable system and dependency contracts.
- `docs/standards/`: engineering rules and enforcement owner.
- `docs/operations/`: runnable procedures and failure handling.
- `docs/adr/`: one accepted, rejected, or superseded architectural decision.
- root OSS files: user, contributor, security, governance, and support contracts.

Do not duplicate rule lists across these layers. Link to the authority and keep
the local file focused. A changed architecture or public behavior updates its
documentation in the same coherent commit.

Write factual present tense, exact commands, and explicit failure evidence.
Mark planned behavior as planned; do not describe an endpoint, gate, artifact,
or platform as available until its runnable check passes. Prefer `file:line`,
command output, measurements, and acceptance conditions over “clean”, “robust”,
or “best practice”.

ADRs state status, date, context/evidence, decision, consequences, and revisit
condition. Supersede instead of rewriting historical evidence. Runtime
`note(kind=decision)` entries are project evidence and do not replace repository
ADRs.

Links are relative, case-correct, and checked. The source guard prevents the
retired root planning/design files and former decision directory from being
reintroduced.
