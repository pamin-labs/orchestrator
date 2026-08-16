# Module boundaries

## Zones

| Zone | Paths | Owns | May depend on |
|---|---|---|---|
| Web | `web/src/**` | Browser views and interaction | Browser libraries and shared public RPC contracts |
| Public RPC | `src/http/routes/panel.ts`, `src/http/routes/orch.ts` | Typed Hono route surface consumed by generated clients | HTTP edge, API handlers, shared contracts |
| HTTP edge | Remaining `src/http/**` | Middleware, validation adapter, response shape | Platform and shared contracts |
| Composition | `src/api.ts`, `src/server.ts` | HTTP/server wiring and process lifecycle | Public RPC, API, application, mechanisms, adapters, platform |
| API | `src/api/**` | Panel and agent protocol operations | Mechanisms, platform, shared contracts |
| Application | `src/runtime/executor.ts` | Turn orchestration and policy coordination | Mechanisms, prompt, runtime adapters, platform |
| Mechanisms | `src/mech/**` except platform primitives, plus `src/ctx.ts` | Scheduling, state transitions, Git/sandbox operations, injected mechanism context | Runtime adapters and platform primitives |
| Runtime adapters | Provider files in `src/runtime/**` | Provider subprocess protocol | Platform, shared contracts, type-only prompt shape |
| Platform | Scheduler, DB, bus, settings, observability, `runtime/running.ts`, scrub/text/shell helpers | Process-wide primitives | Shared contracts |
| Prompt | `src/prompt/**` | Cache-safe prompt assembly | Shared data only |
| CLI | `src/orch/**` | Agent-facing client transport | Shared runtime schemas plus type-only public Orch RPC |
| Server script | `scripts/browse.ts` | Local server browser harness | HTTP entrypoint only |
| Benchmark script | `scripts/benchmark.ts` | Measured hot-path harnesses | Named API/mechanism/runtime targets only |
| Tooling scripts | Other `scripts/*.ts` | Standalone release/setup checks | Standard library only |
| Tests | `test/**` | Observable behavior and regression evidence | Public modules; explicit test harnesses may reach internals |

The intended control direction is:

```text
web/src --type-only--> public panel RPC route
src/orch --type-only--> public Orch RPC route
src/orch -> src/contracts
composition -> public RPC -> API -> mechanisms -> runtime adapters
application -> mechanisms | prompt | runtime adapters
HTTP edge | platform | prompt -> shared contracts
runtime adapters -> provider CLI subprocesses
```

`src/mech/git` and `src/mech/sandbox` remain external-effect mechanisms until
there is measured value in another package. `src/runtime/executor.ts` is
application orchestration; classifying it as an adapter would create the false
mechanism-to-runtime-to-mechanism cycle. Do not create an interface for a single
implementation.

## Public files

- The browser consumes the type-only panel client contract exported by the HTTP
  route layer. It must not import handler implementations.
- The `orch` CLI consumes runtime validation schemas from `src/contracts` and
  the type-only Orch client contract from the route layer. It never imports API
  handlers, mechanisms, or scheduler policy.
- Fallow classifies the two route files as `public-rpc`; that is the complete
  public type surface. Neither `src/api/**` nor generic `src/http/**` is public.
- Cross-zone deep imports are denied unless the Fallow configuration names the
  file as a public boundary.
- A new production file must match exactly one Fallow zone. Unclassified code is
  a failed boundary check, not a miscellaneous zone.

Boundary exceptions require an ADR. Tests may use narrow internal harnesses when
the alternative is starting a server, container, or Git repository for behavior
that does not depend on that integration.
