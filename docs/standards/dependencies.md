# Dependency standard

Orchestrator owns product policy and reuses commodity capabilities. The team
should spend maintenance effort on scheduling, isolation, evidence, and owner
workflows rather than another fixture builder, retry loop, parser, polling
engine, serializer, metrics registry, or benchmark harness.

## Selection order

Use the first option that satisfies the required behavior:

1. delete the capability when the product does not need it;
2. reuse code already owned by the responsible module;
3. use the standard library or Bun/web platform;
4. use an installed dependency;
5. adopt a well-maintained library;
6. write the smallest project-owned implementation.

A new dependency is preferred over handwritten commodity code when it removes
more project-maintained code than it adds, preserves the required behavior, and
has acceptable maintenance, security, licence, runtime/bundle cost, and exit
strategy. Remove the replaced implementation in the same coherent change.

Do not wrap a library merely to rename its API. A wrapper earns its place only
when it enforces Orchestrator-specific policy such as stable error codes,
bounded cardinality, credential ownership, cancellation, or durable recovery.

## Change evidence

A pull request that adds or replaces a dependency records:

- the commodity capability and the project-specific policy that remains;
- files and net project-owned lines deleted versus added;
- why the standard library, platform, and installed dependencies were
  insufficient;
- current maintenance/release activity, licence, vulnerability and supply-chain
  posture;
- runtime, bundle, binary, startup, and test impact where applicable;
- the rollback or replacement path.

One risk has one owner. A library may replace the current owner with an ADR and
migration evidence; it must not create a second linter, test runner, dependency
graph, SAST scanner, or release authority beside the existing one.

Exact build, lint, security, and test owners remain in the
[`enforcement matrix`](enforcement-matrix.md).
