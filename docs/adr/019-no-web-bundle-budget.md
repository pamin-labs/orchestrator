# 019 The web bundle has no size budget

**Status**: accepted
**Date**: 2026-08-18

`main.js` was capped at 1,900,000 bytes and `app.css` at 65,536. Neither number
was derived from anything. The panel is served over loopback to one person, so
its JavaScript is a local parse, not a product constraint — and a ceiling with
250KB of slack reports nothing until something exceeds it by multiples.

The stronger objection, recorded rather than omitted: the cost here is parse and
execute, paid on every reload whether the bytes crossed a network or not, and
`docs/design/ui.md` designs this page around a fifteen-second glance.

It fired correctly on its way out — `@grafana/flamegraph` measured +6,161,139
bytes for one import — but that dependency is declined on its own merits, which
is where a judgement about a trade belongs.

**Consequence**: `perf:budget` keeps only the release archive cap, an artifact a
user downloads. Reopen on a measurement, not a number: the panel served over a
network, or a measured time-to-interactive regression.
