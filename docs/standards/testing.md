# Testing standard

Tests buy confidence in observable behavior, failure recovery, and boundaries.
Test count and coverage percentage are not goals.

## Test layers

- **Unit:** pure parsing, transitions, policy, and error semantics. Use small
  builders and in-memory SQLite.
- **Handler/contract:** call `(ctx, req, params, data)` directly; start Hono only
  for routing, middleware, content-type, and generated-client behavior.
- **Protocol contract:** prove generated clients, runtime validation, stable
  errors, idempotency, and mailbox replay agree on the published version.
- **Integration:** use a real temporary Git repository, subprocess, server, or
  sandbox only when the behavior depends on it.
- **Smoke/end-to-end:** verify the built panel and a representative owner flow.
  Live OpenSandbox tests may be environment-gated but must report a skip.

Test behavior, not private method calls or implementation order. Cover happy
path, invalid input, boundaries, dependency failure, cancellation/concurrency,
and regression evidence for a repaired incident. Avoid excessive mocks and
fixtures that recreate production architecture.

## Tools and speed

Bun is the only test runner. Use `bun:test` spies/mocks and table tests,
`mkdtemp` for temporary repositories, `:memory:` SQLite, and the injected clock.
Do not add Jest, Vitest, fake timers, MSW, Faker, or Fishery without an ADR that
shows a missing capability.

Use local concurrency only for tests proven not to mutate process environment or
global registries. Environment-mutating tests restore values and remain serial.
No sleeps for synchronization and no global concurrent switch.

The suite performance target is median at most eight seconds or at least 35%
faster than the 13.84-second governance baseline. Slow integration fixtures are
shared or replaced with a lightweight harness when Git behavior is not under
test. Tests that only spawn `tsc` or Oxlint duplicate their dedicated gates and
must be removed.

## Property tests

Use fast-check where generated inputs explore an invariant better than an
enumerated regression. Current properties cover mailbox path normalization,
ownership boundaries, claim/reconcile suffixes, idempotent JSON writes, and
context-window clamping; state, queue, and migration behavior remains in the
stronger deterministic transaction/invariant suites until a generative model
adds a distinct failure surface. PR runs use 100 cases. Nightly uses 1,000 plus
randomized order/rerun 10.

Replay fast-check with both values printed by the failure:

```bash
FC_SEED=<seed> FC_PATH=<path> bun test test/properties.test.ts
```

Replay Bun's randomized stress order with its printed seed:

```bash
BUN_TEST_SEED=<seed> bun run test:stress
```

`FC_PATH` without its matching `FC_SEED`, or a non-integer Bun seed, fails fast
instead of pretending to replay a different run.

`test:stress` repeats replay-safe unit, property, and model suites. Stateful HTTP
and live OpenSandbox integration run once in main CI; randomizing their shared
server lifecycle would test ordering noise instead of product behavior.
