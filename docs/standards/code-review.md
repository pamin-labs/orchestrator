# Code review standard

Review the change against its stated invariant and failure modes, not against
personal formatting preferences already owned by tools.

## Required review dimensions

1. **Correctness:** Does observable behavior match the plan? What happens at
   empty, boundary, duplicate, partial, cancelled, and dependency-failure cases?
2. **Architecture/API:** Is dependency direction preserved, public surface
   minimal, and compatibility/idempotency/error behavior explicit?
3. **State/data:** Is ownership clear, impossible state prevented, transaction
   atomic, and migration restartable?
4. **Async/reliability:** Are timeouts, cancellation, retry eligibility,
   backpressure, cleanup, and graceful shutdown handled?
5. **Security:** Are trust boundaries parsed, authorization scoped, secrets
   excluded, and user-controlled paths/commands/URLs safe?
6. **Tests:** Do tests prove observable value and failure paths without
   recreating expensive integration unnecessarily?
7. **Performance/operations:** Does the change worsen a measured hot path,
   cardinality, query count, bundle, queue, or rollback story?
8. **Maintainability:** Does an abstraction have more than one real consumer?
   Can deletion or an existing dependency do the job?

Findings use severity, `file:line`, a reproducible failure scenario, and the
smallest remediation. Mechanical output links to its owning tool instead of
being restated as reviewer judgment.

Large or high-risk changes receive independent architecture/API, security,
test-quality, and performance review as applicable. Fallow Review runs after the
deterministic Fallow audit and anchors each judgment to a signal/snapshot. It is
not a nondeterministic CI gate. The author records `PASS` or dispositions for
every material finding before merge.
