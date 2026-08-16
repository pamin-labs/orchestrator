# State management standard

State has one explicit owner. Server lifecycle and durable workflow state do not
live in React components; browser state is a projection of server snapshots and
events.

- `src/states.ts` is the sole stored lifecycle vocabulary.
- Every state appears in `src/mech/ops/invariants.ts` with a driver, terminal
  declaration, or idempotent repair. Tests prove every table is executed and
  exercise the repair effect, not only the presence of a row.
- Coupled fields change through one transition function. For example, status,
  pause timestamp, and pause reason must not be independently updated at call
  sites.
- New singleton mutable state is forbidden. Process-local caches declare
  ownership, invalidation, capacity, and restart semantics.
- State transitions write the corresponding event atomically whenever an event
  without the state, or state without the event, would lie to the operator.
- Watchdog health rules answer “is it healthy?”; invariant drivers answer “who
  moves it?”. Do not mix these responsibilities.
- Feature flags have an owner, default, removal condition, and safe behavior on
  restart. They do not bypass data migrations or authorization.

Model impossible states out of the type/API before adding source-text guards.
When the type system cannot cover a persistent invariant, use a database
constraint or executable invariant check.
