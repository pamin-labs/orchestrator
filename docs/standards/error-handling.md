# Error handling standard

Protocol errors use one stable shape:

```ts
interface ErrorResponse {
  error: string;
  code: string;
  request_id: string;
  details?: Readonly<Record<string, unknown>>;
}
```

`code` is the machine contract; `error` is concise human context. Expected
domain failures have stable codes and an explicit owner/remediation path.
Programmer defects may fail loudly internally, but the response never exposes a
stack, credential, prompt, host path, SQL, or provider payload.

External I/O errors carry structured `operation`, safe `target`, `retryable`,
and correlation context. Wrap at the boundary that can add this information,
preserving the cause. Do not catch only to log and continue, return an empty
success, or convert every failure to a generic 500.

Cleanup belongs in `finally` or resource lifetime APIs. A partial multi-step
effect must either roll back, checkpoint a resumable state, or record what
completed. Retrying a non-idempotent operation is forbidden unless its
idempotency contract makes duplicate execution harmless.
