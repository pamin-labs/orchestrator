# Architecture principles

Orchestrator is a durable scheduler around isolated agent processes. The design
optimizes for explicit ownership, observable failure, and small recovery units.

1. **One owner per decision.** `job` owns future work, `event` records completed
   facts, `note` owns durable knowledge, and `task`/`slice` owns delivery state.
2. **Dependencies point toward policy.** Routes translate protocols, API
   handlers invoke mechanisms, and runtime/adapters execute external effects.
   Lower layers do not import presentation policy.
3. **Trust is crossed once.** Parse `unknown` data at HTTP, mailbox, config,
   process-output, and database migration boundaries before business code sees
   it.
4. **Expected failure is data.** Stable error codes and durable holds make
   remediation routable. Programmer defects may throw; expected domain failure
   must not rely on stack inspection.
5. **Every state moves.** Each stored state has a driver, is terminal, or has an
   idempotent repair. Health checks diagnose a driver; they do not replace one.
6. **Side effects are bounded.** External operations carry cancellation and a
   timeout. Concurrency, retries, queues, caches, and history have explicit
   limits.
7. **Public surface stays small.** Cross-zone imports use declared public files.
   Implementation types do not leak through RPC or package boundaries.
8. **Evidence beats intention.** Compiler, lint, tests, audits, and runtime
   measurements enforce claims that can be decided mechanically.
9. **Composition over framework ownership.** Hono owns HTTP composition, Zod
   validation, Bun runtime primitives, and OpenSandbox isolation. Orchestrator
   retains prompt assembly, state transitions, and admission control.
10. **Exceptions are decisions.** A rule may be broken only with an ADR and the
    smallest executable regression guard that preserves the reason.

## Design choices

- Treat scheduling/state, agent transport/sandbox, provider runtime, and project
  publication as bounded contexts. Share an explicit contract, not another
  context's database row shape or helper internals.
- Keep related policy cohesive and hide its representation. Minimize coupling,
  cross-context knowledge, and public API surface; dependencies point toward
  the more stable policy.
- Apply dependency inversion at an external boundary: policy owns the contract
  implemented by provider/adapters. Do not create a one-implementation interface
  merely to imitate the pattern.
- Prefer composition to inheritance. A caller asks the nearest owner for an
  operation rather than reaching through object chains (Law of Demeter).
- Reject God objects, feature leakage into generic modules, and functions that
  mix protocol, policy, persistence, and effects at different abstraction
  levels.
- Separate essential orchestration complexity from accidental framework or
  abstraction complexity. YAGNI and KISS mean the smallest design that enforces
  today's invariant, with an upgrade trigger for a deliberate ceiling.

The hard invariants agents must know without loading this file remain in
[`AGENTS.md`](../../AGENTS.md).
