# 018 The GitHub transport is Octokit; our regex buckets, the plugin waits

**Status**: accepted
**Date**: 2026-08-17

`src/mech/git/github.ts` carried its own retry loop, backoff schedule, abortable
sleep and abort race — a stateful machine that fails at 3am over a wrong jitter
or a dangling timer. `@octokit/core` with `plugin-retry` and `plugin-throttling`
owns it now.

This is not a net deletion: 328 code lines became 354, because Octokit throws for
304 and every status ≥ 400, so each non-2xx path is caught and reassembled into
`GhResult`. `dependencies.md` criterion 1 is not met; criterion 3 is, and the new
capability is real — GitHub's own `retry-after` reaches `GhFail` instead of a
number we invented. `classify()`, the repository hold, Zod validation and the
ETag cache stay ours; Octokit has no conditional-request plugin.

Throttling never blocks in band: both callbacks return `false`, so a rate-limited
call still returns promptly as `transient` and the scheduler retries the turn.
Isolation is `id: crypto.randomUUID()` per client, not custom limiter groups —
the plugin reaches limiters as `group.key(state.id)` and Bottleneck mints one per
key, so the default `id` would serialise across instances while a unique one does
not. Custom groups would need `bottleneck` as a direct dependency, and its last
release is 2019-08-03. Pacing is therefore the plugin's defaults, which are
GitHub's documented numbers: writes 1s apart, notifying writes 3s, reads unpaced.

**Consequence**: our regex still decides the bucket — the plugin's own
`/\bsecondary rate\b/i` is narrower than ours and would drop "abuse detection" —
while the plugin decides the wait. A non-zero per-request `retries` bypasses
`doNotRetry` entirely, so the type is `retries?: 0`. Note for the next person
here: `type-hygiene` strips comments before matching, so a banned token in a
comment passes it; do not lean on that.
