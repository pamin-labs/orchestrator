# TypeScript standard

TypeScript is the compile and declaration-boundary owner.

## Compiler contract

The shared base enables `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitOverride`,
`noFallthroughCasesInSwitch`, `noImplicitReturns`, and
`verbatimModuleSyntax`. Project references divide production server, browser,
and tests. Composite projects emit declarations for referenced public types; the
root config contains references rather than a second include graph.

Use the incremental project build for normal work and a clean build at a
milestone. Do not enable Oxlint's experimental compiler diagnostics as a second
`tsc`.

## Source rules

- Treat external input as `unknown`, then validate at the boundary. Internal
  functions accept concrete types.
- Prefer discriminated unions and exhaustive handling over boolean mode
  parameters or type assertions.
- `undefined` means absent; `null` is an explicit protocol/database value. Do
  not treat optional and nullable as synonyms.
- Use readonly inputs and results when mutation is not part of the contract.
- Use branded/opaque identifiers only where mixing two primitive identities is
  a demonstrated risk.
- Avoid `any`, unsafe assertions, and implementation types in public exports.
- Use `import type` for erased dependencies and explicit file extensions as
  required by the project module mode.
- Do not annotate inferred maps as `Record<string, ...>` when doing so erases a
  useful literal-key union.

The compiler proving a type is reachable does not make the dependency allowed;
Fallow owns that decision.
