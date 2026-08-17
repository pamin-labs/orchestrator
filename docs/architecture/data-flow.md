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
