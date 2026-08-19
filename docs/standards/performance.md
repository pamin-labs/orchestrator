# Performance standard

Optimize measured hot paths without weakening correctness or replacing explicit
limits with hidden queues.

## Required signals

- Fallow complexity and change-risk identify review hotspots; deterministic
  findings are zero and hotspot scores may not regress without evidence.
- Benchmarks cover snapshot, watchdog, scheduler, prompt assembly,
  reconciliation, serialization, and representative database query counts.
- Observe event-loop delay, subprocess/HTTP duration, queue depth, memory
  retention, and cache hit/size behavior.
- Record compiled binary, archive, and container image sizes. The web bundle is
  measured when a change is likely to move it, but is not budgeted: see
  [ADR 019](../adr/019-no-web-bundle-budget.md).

PR gates should reject only a statistically meaningful regression beyond a
documented budget. Keep raw samples and compare the same runtime, fixture, warmup,
and platform. A single faster run is not evidence.

Avoid unbounded collections/concurrency, accidental quadratic scans on growing
tables, unnecessary copies/serialization, N+1 queries, retained closures, and
blocking work on the event loop. A cache is allowed only with the key, capacity,
stale behavior, and invalidation defined in [`data.md`](data.md).

Test-suite runtime is a developer performance budget and follows
[`testing.md`](testing.md); reducing valuable failure-path coverage is not an
optimization.
