# Dependency rules

Fallow is the sole owner of repository dependency graphs. TypeScript proves
project build boundaries; Oxlint checks source-level correctness. Do not repeat
Fallow cycle or zone rules in Oxlint.

## Enforced rules

1. `web/src` can import shared contracts and the panel route type only. It cannot
   import API handlers, generic HTTP modules, Bun modules, the database, or runtime
   adapters.
2. `src/orch` can import shared runtime schemas and the Orch route type only. It
   cannot import API handlers or mechanisms.
3. `src/http/routes` composes Hono, schemas, middleware, and handlers but owns no
   state transition or business policy.
4. `src/api` may call `src/mech`; `src/mech` may not import `src/api`,
   `src/http`, or `web`.
5. Runtime adapters cannot import mechanisms, application orchestration, panel,
   web, or route policy. `src/application/**` and the remaining
   `src/application/executor.ts` composition leaf belong to the application zone,
   not the adapter zone.
6. Prompt construction outside `src/prompt/assemble.ts` is forbidden.
7. Production dependencies must be declared in `dependencies`; test/build-only
   packages belong in `devDependencies`.
8. Cycles are forbidden. A cycle is resolved by moving the shared contract
   inward or deleting the back-edge, not by adding a barrel.
9. A public signature may expose only public types from the same or an inward
   zone.
10. Cross-zone imports use named public files. Barrels must not expand the public
   API accidentally.
11. Tests and maintainer scripts have coverage zones but no dependency rule;
    they may assemble internal harnesses without adding fake production edges.
12. Every production file has boundary coverage.
13. Constrained production zone rules form a directed acyclic graph, including
    type-only edges. A new back-edge fails `test/governance/architecture-boundaries.test.ts`.

`src/platform/**` is directory-owned by the platform zone. Configuration,
persistence, observability, and process primitives belong there without another
file-specific Fallow pattern; the remaining root platform leaves retain
explicit ownership until they move.

Run a touched-area guard before editing and the repository audit after:

```bash
bunx fallow guard <file...>
bun run audit
```

Fallow also owns dead code, duplicate exports, private type leaks, public
signature coupling, complexity, and change-risk findings. Deterministic findings
must be zero. Complexity is a non-regression signal: refactor a hotspot when the
change makes it worse or when measurement identifies it as a failure source.
`fallow audit` already gates newly introduced findings against the comparison
base. Do not add a health baseline when the repository has no accepted debt to
suppress.

Tailwind v4 is a build-only dependency imported from CSS. Fallow's documented
CSS-framework exception is therefore the `ignoreDependencies` entries; it
is not an ignored source import or a production runtime dependency.
