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

## Comments in source

A comment's home is the same question as a document's. Three kinds, three places:

- **The invariant stays in the code.** The sentence a reader cannot get from the
  lines below it and that, broken, breaks something: why the pathspec must be
  `-z`, why the container is the boundary rather than the CLI's own sandbox, why
  this `COALESCE` exists. Tighten the wording; never drop the fact.
- **Measurement, selection and post-mortem go to the commit message or an ADR.**
  Timings, benchmark tables, "I judged this wrong and here is why", the release
  dates that ruled a library out. `AGENTS.md` already requires the commit body to
  carry what the failure looked like and why the fix sits at that layer, so
  keeping a second copy in the file means two copies drifting apart — and the one
  in the file drifts silently, because nothing re-reads it.
- **Restatement goes nowhere.** A line that says what the next line says.

**No block comment longer than eight lines.** One that genuinely needs more is a
signal the code wants a name, not that the comment wants the space.

The measured starting point was 24% of `src` + `web/src` + `test` — 19,337 lines
of 79,149, with single files above 50%. The target is not a number; it is that
every surviving line answers "what breaks if this is wrong".

Links are relative, case-correct, and checked. The source guard prevents the
retired root planning/design files and former decision directory from being
reintroduced.
