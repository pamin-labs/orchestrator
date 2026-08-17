# 018 The GitHub transport is Octokit; our regex buckets, the plugin waits

**Status**: accepted
**Date**: 2026-08-17

`github.ts` carried its own retry loop, backoff, abortable sleep and abort race —
a state machine that fails at 3am over a wrong jitter. `@octokit/core` with
`plugin-retry` and `plugin-throttling` owns it.

Not a net deletion: 328 code lines became 354, because Octokit throws for 304 and
every status at or above 400, so each is reassembled into `GhResult`. Criterion 1
of `dependencies.md` is unmet; criterion 3 carries it, plus a capability we
lacked — GitHub's own `retry-after` now reaches `GhFail`.

Throttling never blocks in band: both callbacks return `false`. Isolation is
`id: crypto.randomUUID()` per client, not custom limiter groups — the plugin
keys limiters by `id`, and custom groups would need `bottleneck`, last released
2019. Pacing is therefore the plugin's defaults, which are GitHub's own numbers.

**Consequence**: `classify()` keeps its regex, since the plugin's own
`/\bsecondary rate\b/i` is narrower and would drop "abuse detection". A non-zero
per-request `retries` bypasses `doNotRetry`, so the type is `retries?: 0`.
