# Module boundaries

## Zones

| Zone | Paths | Owns | May depend on |
|---|---|---|---|
| Web | `web/src/**` | Browser views and interaction | Browser libraries and shared public RPC contracts |
| Public RPC | `src/http/routes/**` | Typed Hono route surface consumed by generated clients | HTTP edge, API handlers, shared contracts |
| HTTP edge | Remaining `src/http/**` | Middleware, validation adapter, response shape | Platform and shared contracts |
| Composition | `src/api.ts`, `src/server.ts` | HTTP/server wiring and process lifecycle | Public RPC, API, application, mechanisms, adapters, platform |
| API | `src/api/**` | Panel and agent protocol operations | Mechanisms, platform, shared contracts |
| Application | `src/runtime/executor.ts` | Turn orchestration and policy coordination | Mechanisms, prompt, runtime adapters, platform |
| Build info | `src/platform/process/version.ts` | Package/release identity shared by executable entry points | No runtime policy |
| Mechanisms | `src/mech/**` except platform primitives, plus `src/ctx.ts` | Scheduling, state transitions, Git/sandbox operations, injected mechanism context | Runtime adapters and platform primitives |
| Runtime adapters | Provider files in `src/runtime/**` | Provider subprocess protocol | Platform, shared contracts, type-only prompt shape |
| Platform | `src/platform/**` plus the root scheduler, language, and observability leaves | Process-wide configuration, persistence, observability, and process primitives | Shared contracts |
| Prompt | `src/prompt/**` | Cache-safe prompt assembly | Shared data only |
| CLI | `src/orch/**` | Agent-facing client transport | Shared runtime schemas plus type-only public Orch RPC |
| Scripts | `scripts/**` | Maintainer-only development, benchmark, and setup entry points | Unrestricted; never shipped as production runtime |
| Tests | `test/**` | Observable behavior and regression evidence | Public modules; explicit test harnesses may reach internals |

The intended control direction is:

```text
web/src --type-only--> public panel RPC route
src/orch --type-only--> public Orch RPC route
src/orch -> src/contracts | build info
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
- Fallow classifies `src/http/routes/**` as `public-rpc`; new typed route files
  join that public type surface without a config edit. Neither `src/api/**` nor
  generic `src/http/**` is public.
- Cross-zone deep imports are denied unless the Fallow configuration names the
  file as a public boundary.
- Specific exceptions precede directory zones because Fallow uses first-match
  ownership. New files under `src/platform`, `src/http`, `src/runtime`, and
  `src/mech` inherit their directory zone automatically. The remaining root
  platform leaves stay explicitly classified until their owning subsystems
  move; a new production file outside an owned directory must be moved into one
  or deliberately classified.

Boundary exceptions require an ADR. Tests and maintainer scripts have coverage
zones but no dependency rule: Fallow's documented no-rule behavior leaves these
peripheral entry points unrestricted without pretending they are production
layers.
