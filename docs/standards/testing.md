# Testing standard

Tests buy confidence in observable behavior, failure recovery, and boundaries.
Test count and coverage percentage are not goals.

## Test layers

- **Unit:** pure parsing, transitions, policy, and error semantics. Use small
  builders and in-memory SQLite.
- **Handler/contract:** call `(ctx, req, params, data)` directly; start Hono only
  for routing, middleware, content-type, and generated-client behavior.
- **Protocol contract:** prove generated clients, runtime validation, stable
  errors, idempotency, and mailbox replay agree on the published version.
- **Integration:** use a real temporary Git repository, subprocess, server, or
  sandbox only when the behavior depends on it.
- **Smoke/end-to-end:** verify the built panel and a representative owner flow.
  Live OpenSandbox tests may be environment-gated but must report a skip.

## Where a test file goes

`test/` mirrors the source zones, one directory per subject: `api`, `application`,
`cli`, `governance`, `http`, `integration`, `live`, `mech`, `platform`, `runtime`,
and `web`. `test/support` holds shared harness code and `test/fixtures` holds data
read from disk; neither contains tests.

`governance` is for suites whose subject is the repository rather than a
subsystem — boundary configuration, workflow files, source hygiene, invariants
across all of `src/`. `integration` and `live` are excluded from `test:stress` by
directory, so a suite that boots a server or talks to OpenSandbox is excluded on
the day it is written rather than when somebody remembers a list.

Test behavior, not private method calls or implementation order. Cover happy
path, invalid input, boundaries, dependency failure, cancellation/concurrency,
and regression evidence for a repaired incident. Avoid excessive mocks and
fixtures that recreate production architecture.

## How to write one

**Rows come from `test/support/factories.ts`.** Never write `INSERT INTO` in a
test. `fx.project.insert(db, { remote })` fills the columns the schema demands
and leaves the ones you name at the call site — which is the rule: a value the
test is exercising stays visible in the test, a value the schema merely requires
does not. Traits (`fx.runningGrp`, `fx.acceptedSlice`) are `.params()` on the
same factory. If a table has no factory, add one there rather than reaching for
SQL; the exception is a test whose subject *is* the statement, and there are two
in the suite.

**Rendering goes through `test/support/render.tsx`.** The document itself is a
preload (`test/support/dom.ts`), so it exists before any module is evaluated and
nothing needs importing in a particular order. Query the way a reader would —
`getByRole`, `getByLabelText`, `getByText` — and never put a DOM node inside
`expect`: a failed assertion on an element prints a serialised browser. Assert a
count (`queryAllByRole(...)` with `toHaveLength(0)`), an accessible name, or a
property. Anything that positions or measures itself asynchronously — every Radix
popover and dialog — needs `findBy*` or `waitFor`, or React will warn that the
update escaped the test and your assertion read the frame before it settled.

**The network is `test/support/http.ts`, in web tests too.** `mockHttp()` at the
top of the file, handlers from `msw`; nothing assigns `globalThis.fetch`. A
replaced `fetch` fakes the wrong layer and, more to the point, cannot be
reconciled with `onUnhandledRequest: "error"` — thirteen web files stubbing it
directly meant that gate covered none of the suite that talks to the panel's own
API. A pane asserted in its first-paint state passes `inFlight()` to `mockHttp()`,
which answers every unclaimed request with a promise that never settles; that is
the one opt-out, and it is per file. The three files that release a reply from
inside the test to order it against a render — `read-races`, `evidence-race`,
`pending-transitions` — still hold `fetch`, because what they need is a promise
the test owns rather than a route.

**Use `test.each` when the cases differ only in data.** The boundary tests for an
address predicate or a state transition are a table. This reverses what this
document used to say — that nineteen addresses in one loop is one test naming the
rule where nineteen tests name nothing — and the reason is the failure message.
A loop reports `expected false, received true` at one line number and withholds
the input, which is the only thing the reader needed; `test.each` puts the case
in the test's own name, so the report reads
`a mount is covered by a prefix directory > /var/tmp/orch-cache-other/skills
covered: true`. The rule still gets named — by the `describe` the table sits in.
Bun's formatter takes the arguments positionally: `%s` for a string, `%p` for
anything else, `%j` for an object. Where the input is too large to read in a
name, make the first column a sentence and format only that.

**Or assert on the value, so the diff is the finding.** A boolean helper that
answers "are these unique" becomes one that answers "which ones repeat", and
`expect(duplicates(SERVER_STATES)).toEqual([])` prints the offending state
instead of `false`. Where several booleans belong to one fact, assert them as one
object — `expect({ matching, spaced, overlong }).toEqual({ … })` — and the diff
names the case that moved. Leave `toBe(true)` where the boolean genuinely is the
fact under test: a `.ok` narrowing before reading `.error`, or a flag on a row.

**Reach for `fast-check` when the invariant is worth more than the examples** —
when you can state a property that must hold for every input rather than enumerate
the ones you thought of. Keep the enumerated regression too if it came from a real
incident.

**A repaired bug gets a test that fails without the repair.** Check that by
removing the fix and watching it go red, not by assuming. A test that passes with
the behaviour removed is worse than no test, because it will be cited as coverage.

## Tools and speed

Bun is the only test runner. Use `bun:test` spies/mocks and table tests,
`:memory:` SQLite, and the injected clock. Before writing fixture, mock, timer,
HTTP interception, or generated-data infrastructure, apply the
[`dependency standard`](dependencies.md) — the owners already chosen are in the
[`enforcement matrix`](enforcement-matrix.md), and a second helper stack beside
one of them is forbidden.

Use local concurrency only for tests proven not to mutate process environment or
global registries. Environment-mutating tests restore values and remain serial.
No sleeps for synchronization and no global concurrent switch.

There is no wall-clock target, because a threshold on it is a coin flip in CI:
the same suite measured 7.64s, 9.44s and 11.12s on three machines while nothing
about it changed. What is recorded instead is what each cost buys. The suite runs
in about 16s, of which roughly 8s is the browser environment the panel's render
tests need — the alternative was portalled dialogs and popovers reporting success
without being rendered at all. Slow integration fixtures are shared or replaced
with a lightweight harness when Git behavior is not under test. Tests that only
spawn `tsc` or Oxlint duplicate their dedicated gates and must be removed.

## Property tests

Use fast-check where generated inputs explore an invariant better than an
enumerated regression. Current properties cover mailbox path normalization,
ownership boundaries, claim/reconcile suffixes, idempotent JSON writes, and
context-window clamping; state, queue, and migration behavior remains in the
stronger deterministic transaction/invariant suites until a generative model
adds a distinct failure surface. PR runs use 100 cases. Nightly uses 1,000 plus
randomized order/rerun 10.

Replay fast-check with both values printed by the failure:

```bash
FC_SEED=<seed> FC_PATH=<path> bun run test test/governance/properties.test.ts
```

Replay Bun's randomized stress order with its printed seed:

```bash
BUN_TEST_SEED=<seed> bun run test:stress
```

`FC_PATH` without its matching `FC_SEED`, or a non-integer Bun seed, fails fast
instead of pretending to replay a different run.

`test:stress` repeats replay-safe unit, property, and model suites. Stateful HTTP
and live OpenSandbox integration run once in main CI; randomizing their shared
server lifecycle would test ordering noise instead of product behavior.

## A guard is kept only once it has been seen failing

Write the test, take the fix away, watch it go red, put the fix back. A guard
that has only ever been green is a guess about what it measures, and it is worse
than no guard because it reads as coverage.

Three on one branch could not fail at all:

| Guard | Why it could not fail |
|---|---|
| a flamegraph resize test | dispatched `window.resize`; happy-dom's `ResizeObserver` never sees one |
| a bundle boot test | waited for a non-empty `document.body`, which the first paint satisfies — the assertions then ran against a page still routing |
| a CLI regression test | `bun test` gives no tty, so it passed with its guard deleted |

Each was written against a real, reproduced defect. Each was green against the
broken code. The third was deleted rather than fixed, which is also an answer.

This is the same rule as "no `fallow-ignore` without a reason", moved from the
suppression to the assertion: a claim that cannot be wrong is not a claim.

## Measure the artefact, not the source

The suite imports `web/src/**`, so until `test/governance/bundle-boots.test.ts`
nothing in it ran the bundle the browser is served — and the source and the
bundle are different programs. `recharts` resolves an axis scale by building
`"scale" + type` and looking the name up on its `d3-scale` namespace, which no
bundler can follow, so deleting an unused `<Brush>` tree-shook `scalePoint` out
and crashed a whole view while 1,311 tests stayed green.

Reasoning about it was wrong twice before the boot test settled it in one run.
The same shape appeared in CI, where the CRAP gate ran `fallow audit` with no
`coverage/coverage-final.json` in the checkout: it fell back to an
export-reference estimate and failed on seven functions that measure 88.9%–100%
covered.

So when a claim can be measured — a bundler's output, a CI job's inputs, a
library's runtime behaviour — measure it. Build it and run it, or read the real
numbers out of the file. Confident wrong answers cost more than a check.
