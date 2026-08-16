# Async and concurrency standard

- Propagate the incoming `AbortSignal`; combine it with
  `AbortSignal.timeout()` using `AbortSignal.any()` at external I/O.
- Every subprocess, HTTP call, sandbox operation, lease, and turn has a bounded
  lifetime and contextual timeout error.
- A lease never holds an HTTP/mailbox request open for its command lifetime.
  Enqueue returns immediately; completion schedules exactly one durable result
  turn for the requesting agent. Shutdown cancels the sandbox command before its
  job can be resumed.
- Await promises or intentionally detach them through the repository's tracked
  background-work path. A bare promise is a lint error.
- Concurrency is bounded at admission. Queue capacity and lease availability
  provide backpressure; do not replace them with `Promise.all` over an
  unbounded collection.
- Retry only transient, idempotent work with bounded exponential backoff and
  jitter. Authentication, validation, and content conflicts do not improve with
  retries.
- `providerHeld`, `repoHeld`, and sandbox holds are circuit breakers: one shared
  failure pauses new work and exposes a recovery action instead of making each
  group fail differently.
- Assume cancellation races with completion. Make finalization idempotent and
  check durable state inside the same transaction that wins ownership.
- Tests synchronize on observable state or injected clocks, never sleeps.

Document queue ordering, at-least/at-most-once behavior, lease expiry, and
recovery before adding a new asynchronous channel.
