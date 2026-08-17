# Data and control flow

## Owner request to delivered branch

```text
panel request
  -> /api/v1 validation
  -> job (future work)
  -> scheduler admission
  -> group mailbox
  -> agent turn in OpenSandbox
  -> claimed files and checkpoint
  -> deterministic gates
  -> QA and external audit
  -> utility container publishes branch
  -> GitHub pull request
  -> event/note evidence shown to owner
```

HTTP request IDs enter an `AsyncLocalStorage` context and follow HTTP -> job ->
turn -> event. Job, group, agent, and correlation identifiers belong in
structured log fields and spans, never in message strings that must be parsed.

Spans are also stored. A `SpanProcessor` writes each finished span to the `span`
table so the panel can answer where a requirement's wall-clock time went without
a collector to ask; an OTLP exporter runs beside it only when one is configured.
The scope columns (`project_id`, `grp_id`, `slice_id`) are nullable and are
deliberately not foreign keys: a span is an observation of work, not a reference
to it, so deleting a group must not either fail or erase last week's timing.

Retention is therefore what bounds the table, and it is two bounds that answer
different questions. Age is the product bound and it is **a day**, because a day
is what the panel reads: `DEFAULT_WINDOW_MS` is 24 hours and the page says so.
It was a week, and the row cap then cut that to under three days at the measured
write rate — so the copy promised a day, this page promised a week, and a reader
could reach neither. Days two through seven were stored and read by nothing.

The row cap is the safety bound and nothing else: a retry storm or a hot loop
writes in an hour what a day normally holds, and an age bound alone would fill
the disk before anything aged out. It is sized so it never decides how far back
a reader can see — a day is about 75,000 rows at the measured rate and ten times
that on a busy fleet, against a cap of a million.

A rollup — folding expiring spans into per-hour summaries — was designed for
this and discarded. It buys long history cheaply, and this page does not want
long history; it wants to say whether something is slow now. Storing a week to
serve a day is what made retention look like it needed a mechanism.

The trim is amortised on the writer and gated to at most once a minute, the same
shape the idempotency record store already uses, so there is no second timer and
nothing runs on an idle process.

## Agent transport and credentials

The host owns HTTP/SSE, SQLite, scheduling, and mailbox polling. Each group has
one OpenSandbox container and a clone. Agents write requests into the file
mailbox; the host validates and dispatches them through the `orch` protocol.
The utility container performs privileged publication without running repository
content. Real credentials remain in the egress vault; agent containers receive
format-valid decoys.

## State and persistence

- A state transition and the event describing it commit in the same SQLite
  transaction when partial visibility would be invalid.
- Jobs are claimed with bounded capacity and an explicit lease. Queue fullness
  is backpressure, not an invitation to spawn unbounded work.
- Mailbox replay retains the original idempotency key. Repeated delivery returns
  the stored result rather than repeating the effect.
- `src/contracts/states.ts` is the lifecycle vocabulary. The invariant table declares who
  drives each non-terminal state and tests exercise the repairs, not only their
  registration.

## Prompt data

All prompt assembly goes through `src/prompt/assemble.ts`. A delta is appended to
the latest user message; inserting it in the system prompt or earlier history
invalidates the cached prefix while appearing functionally correct.

Trust boundaries and data classifications are detailed in
[`../standards/security.md`](../standards/security.md) and persistence rules in
[`../standards/data.md`](../standards/data.md).
