# Fallow security candidates

`bunx fallow security` surfaces *candidates*, not vulnerabilities: a syntactic
sink plus a reachability guess. Every candidate needs a recorded human decision,
because an undispositioned list is one nobody reads.

This is that record. One row per candidate, and the same reason is written on the
line itself as a `// fallow-ignore-next-line security-sink -- …` comment, so
`require-suppression-reason` and `stale-suppressions` keep the two in step: a
suppression that outlives the code it explains fails CI.

A candidate whose value is genuinely attacker-reachable is fixed rather than
annotated, and the fix goes where the value enters the process — not at the line
the scanner picked.

A candidate that was never at risk is not refactored to please a scanner. But
where the dynamism the scanner objected to was not buying anything — a pattern
recompiled per call that never varies, a filter clause assembled per call that
only ever takes two forms — removing it is what removes the finding, and those
rows say *removed* rather than *false positive*: there is no annotation left
because there is nothing left to annotate.

## Decisions

| Category | Location | Decision | Reason | Owner |
|---|---|---|---|---|
| dynamic-regex | `src/mech/git/prwatch.ts:184` | false positive | `TYPES` is a module `as const` tuple; the PR title is the tested string | mech |
| dynamic-regex | `src/mech/lease.ts:246` | false positive | `spec.pattern` is `resource.arg_schema_json`, and `flow/start.ts` is that table's only writer | mech |
| dynamic-regex | `src/mech/lease.ts:312` | false positive | `error_regex` comes from the same single writer, out of the source literals in `util/detect.ts` | mech |
| dynamic-regex | `src/mech/sandbox/sandbox.ts:63` | false positive | interpolates `PUBLISHED_REPO`, the constant declared one line above | mech |
| dynamic-regex | `src/mech/sandbox/server.ts:168` | false positive | the one placeholder is `key`, already regex-escaped; callers pass fixed TOML key names | mech |
| dynamic-regex | `src/mech/skills.ts:199` | false positive | `RegExp.escape(s.name)`, so a skill directory name can only contribute literals | mech |
| dynamic-regex | `src/mech/util/attachment-text.ts:26` | false positive | interpolates the module constant `IMAGE_TAG` through `RegExp.escape`; hoisted so it compiles once, but kept interpolated so it cannot drift from the line `withAttachments` writes | mech |
| dynamic-regex | `src/mech/util/detect.ts` | **removed** | the parameter only ever took `"test"`; now the module constant `MAKE_TEST_TARGET` and no `RegExp` call at all | mech |
| sql-injection | `src/mech/ops/cost.ts` (7 sites) | **removed** | all seven were the same optional project filter assembled per call; now `(?1 IS NULL OR project_id = ?1)` inside each statement, so every query is a constant string and the id only arrives bound | mech |
| sql-injection | `src/mech/flow/escalate.ts:65` | false positive | `COLUMNS`/`VALUES`/`open` are module literals; question, prefix and state list are all bound | mech |
| sql-injection | `src/mech/flow/escalate.ts:76` | false positive | same three literals, plus the group id bound | mech |
| sql-injection | `src/mech/flow/ownership.ts:214` | false positive | `WRITING_SQL` is the frozen state list from `contracts/states.ts` | mech |
| sql-injection | `src/mech/flow/review.ts:628` | false positive | `idle` is one of two literals chosen by the `autoAdvance` boolean | mech |
| sql-injection | `src/application/executor.ts:115` | false positive | `SELECT_AGENT_BASE` is a module column-list literal; group id and role bound | application |
| ssrf | `src/mech/ops/notify.ts:200` | false positive | `cfg.notifyWebhook` is boss-only settings, unreachable from a sandbox; no credential, scrubbed body | mech |
| ssrf | `src/mech/ops/preflight.ts:62` | false positive | destination is `cfg.sandbox.server` and the key sent is the one stored for that address | mech |
| ssrf | `src/mech/ops/preflight.ts:201` | false positive | gateway and secret come from the same `runtime_auth` row; they cannot be substituted for each other | mech |
| ssrf | `src/mech/sandbox/images.ts:44` | false positive | fixed `ghcr.io` origin, `PUBLISHED_REPO` in the path | mech |
| sql-injection | `src/platform/persistence/database.ts:709` | false positive | `table` loops a two-element `as const` and `key` is a ternary of two literals, so both interpolations are fixed at compile time | platform |
| sql-injection | `src/api/panel/group.ts:64` | false positive | `CLAIMING_SQL` is `sql(CLAIMING)`, built once from the `GRP_STATES` literal tuple; the ids are bound | api |
| sql-injection | `src/api/panel/group.ts:199` | false positive | same constant, group id bound | api |
| sql-injection | `src/api/orch/planning.ts:348` | false positive | same constant, project and group ids bound | api |
| sql-injection | `src/api/panel/panel.ts:72` | false positive | every `where` element is a source literal carrying `?`; the values travel in `args` and are bound by `.all(...args)` | api |
| ssrf | `src/api/panel/authflow.ts:132` | false positive | destination is `cfg.sandbox.server` and the key sent is the one stored for that address — the same disposition as `preflight.ts:62` | api |
| ssrf | `src/orch/cli.ts:88` | false positive | the URL is the generated client's, built from `ORCH_URL` or loopback; inside a sandbox `ORCH_MAILBOX` is set and this branch is never taken | orch |
| ssrf | `src/mech/sandbox/images.ts:51` | false positive | fixed `ghcr.io` origin; token was minted for that same repository | mech |
| ssrf | `src/mech/sandbox/mailbox.ts:94` | false positive | `normalise` pins the origin and the `/orch/v1/` prefix and returns the string that is sent | mech |
| ssrf | `src/mech/sandbox/server.ts:93` | false positive | destination is `cfg.sandbox.server`, paired with its own key | mech |
| ssrf | `scripts/browse.ts:101` | false positive | origin is the throwaway local server this script just started; the step file contributes a path | scripts |
| ssrf | `scripts/make-github-app.ts:102` | **fixed** | `code` arrives on a listening socket; now shape-checked at the socket, so it is one path segment | scripts |
| hardcoded-secret | `src/contracts/config.ts:219` | false positive | the `SETTING_DENIALS` refusal text for `sandbox.apiKey`, not a key; nothing is stored or sent | contracts |
| sql-injection | `src/platform/observability/span-store.ts:372` | false positive | `where` is one of `scopeSql`'s three source literals; `percentiles("duration_ms")` is a module template over a literal column name; bounds and scope ids bound | platform |
| sql-injection | `src/platform/observability/span-store.ts:465` | false positive | same `where`; bounds, scope ids and `limit` bound | platform |
| sql-injection | `src/platform/observability/span-store.ts:564` | false positive | same `where`, nothing else interpolated — this is the flat read the fold walks in JS | platform |
| sql-injection | `src/platform/observability/span-store.ts:667` | false positive | same `where` plus `percentiles("wall")`; bounds and the four `bucketMs` bound | platform |
| ssrf | `web/src/shared/api.ts:59` | false positive | wraps the hono client bound to the relative base `/api/v1`; same-origin by construction | web |
| open-redirect | `web/src/features/progress/view.tsx:211` | false positive | `prUrl` returns null or a literal `https://github.com/` prefix plus two `[\w.-]+` segments | web |

## Owned by a later pass

Not touched here, and still undispositioned:

| Category | Location |
|---|---|
| sql-injection | `src/platform/persistence/database.ts:708` |
| sql-injection | `src/api/panel/group.ts:62` |
| sql-injection | `src/api/panel/group.ts:196` |
| sql-injection | `src/api/panel/panel.ts:71` |
| sql-injection | `src/api/orch/planning.ts:345` |
| ssrf | `src/api/panel/authflow.ts:131` |
| ssrf | `src/orch/cli.ts:87` |

## The four the span store adds, and why they are one decision

Every read in `platform/observability/span-store.ts` filters by scope, and the
scope filter is the only interpolation any of them carries. `scopeSql` returns
one of three fixed strings — `project_id IS NULL AND grp_id IS NULL`,
`grp_id = ?`, or the project pair — chosen by `scope.kind` and never assembled
from a value, with the ids returned alongside as `params` for `.all(...)`.

So the four rows are the same disposition four times, and the honest way to hold
them that way is at the shared helper rather than at each call. It is not
inlined into a single string because the three scopes need different numbers of
bound parameters, which is the one thing a constant cannot express.

## The three that were worth changing anyway

`cost.ts` built the same optional `WHERE project_id = ?` clause seven times, so
each of its seven queries had two possible statement texts depending on the
argument. Putting the filter inside the statement as `?1 IS NULL OR project_id =
?1` makes every one of them a constant prepared once, deletes the `where`/`args`
pair, and takes seven findings and seven annotations with it.

`detect.ts` compiled `^${target}\s*:` per call from a parameter whose only caller
passed `"test"`. It is now the module constant `MAKE_TEST_TARGET` and the
parameter is gone.

`attachment-text.ts` compiled a pattern per call that never varied — hoisted to
module scope. It keeps its annotation: the interpolated `IMAGE_TAG` is what stops
the reader from drifting away from the writer, so flattening it to a literal
would trade a real guarantee for a quiet scanner.

## The one that was real

`scripts/make-github-app.ts` runs a loopback server so GitHub can redirect the
manifest conversion code back to it. That code was read out of the query string
and interpolated straight into an `api.github.com` path, and the answer to that
call is written to disk as an app's private key — so a `code` carrying a `/` or a
`?` would have steered the POST somewhere else on the same host.

The guard is on the read, not on the `fetch`: the socket is the one place the
value enters the process, and every later use of it is covered by checking it
once there.

No unit test accompanies it. The script's module body starts a server and awaits
the redirect at the top level, so importing it from a test hangs; making the
guard callable would mean restructuring a one-shot interactive setup script
around a twenty-character predicate. Worth revisiting only if that script grows a
second thing worth testing.
