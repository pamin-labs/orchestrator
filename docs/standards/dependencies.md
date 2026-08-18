# Dependency standard

Orchestrator is an open-source project that will take contributions from many
people and keep growing. The question a dependency decision answers is not "can
we delete a few lines today" but "will a hundred contributors a year from now
still be able to reason about this". A capability that a popular, maintained
library already provides should not be reimplemented here.

The team owns product policy: agent orchestration, slice lifecycle, evidence,
sandbox boundaries, and release immutability. Everything else — linting, type
checking, dependency graphs, coverage, tracing, benchmarking, HTTP interception
in tests, markdown parsing, schema validation — belongs to an external owner.

## Adopting a dependency

A candidate qualifies when **any one** of these holds:

1. **Net deletion.** It removes more project-maintained code than it adds.
2. **Semantic fidelity.** It makes the code do or test the more correct thing.
   Intercepting HTTP at the network layer exercises the real retry, conditional
   request, and throttling paths that a hand-written stub skips. Asserting on
   accessible roles survives a class rename that a substring assertion does not.
   Validating against a published schema checks the specification rather than
   our reading of it.
3. **Capability we need now or plausibly later.** Waiting until the absence
   hurts is not a virtue.

"We could write this ourselves" is not a reason to decline. A decision to
decline must cite measured evidence — release activity, a capability gap, or a
demonstrated conflict — and record what would make us look again.

## Maintenance

Consider anything popular and maintained. **Do not consider a project with no
release in over three years.** A year was the earlier line and it was too tight:
it excluded `stopword`, whose sixty-four word lists are data that does not rot,
on a fourteen-month gap. Age is evidence about a project, not a verdict on it —
pair it with what the package actually is.

Judge an ecosystem by its active packages, not by the version date of its
umbrella package. `unified` and `remark` publish rarely because their core is
finished, while `mdast-util-from-markdown`, `remark-gfm`, and `micromark` ship
regularly; that is stability, not abandonment. State which packages carried the
judgement.

## Constraints that do not relax

- **One owner per risk.** A library may replace the current owner with an ADR
  and migration evidence. It must not become a second linter, test runner,
  dependency graph, SAST scanner, coverage authority, or release authority
  beside the existing one. Owners are listed in the
  [enforcement matrix](enforcement-matrix.md).
- **Delete what it replaces, in the same commit.** A commit that installs a
  library and leaves the hand-written implementation behind is reverted.
- **Do not wrap a library to rename its API.** A wrapper earns its place only
  when it carries Orchestrator-specific policy: stable error codes, bounded
  label cardinality, credential ownership, cancellation, or durable recovery.

## Change evidence

A pull request that adds or replaces a dependency records:

- which of the three adoption criteria it meets, with the measurement;
- the commodity capability taken over and the project-specific policy that stays;
- files and net project-owned lines deleted versus added;
- current release activity, licence, vulnerability and supply-chain posture;
- runtime, bundle, binary, startup, and test impact where applicable;
- the rollback or replacement path.

A pull request that declines a candidate records the measured reason and the
condition that would reopen it, so the next contributor does not repeat the
investigation.
