# 019 The web bundle has no size budget

**Status**: accepted
**Date**: 2026-08-18

`scripts/performance-budget.ts` capped `web/dist/main.js` at 1,900,000 bytes and
`app.css` at 65,536. Neither number was derived from anything: they were a
measurement rounded up. The panel is served over loopback to one person and then
holds an SSE connection, so the size of its JavaScript is a one-off local parse,
not a product constraint — there is no network, no CDN bill, and no first-paint
competitor.

A ceiling also reports the wrong thing. At 1,648,981 against 1,900,000 it allowed
250KB of silent drift, which is the shape a real mistake takes, while blocking
deliberate work. `@grafana/flamegraph` was measured at +6,161,139 bytes for one
import — 396 packages, including a code editor and a Redux store, to draw bars —
and that was declined on its own merits, not because a gate said so.

**Consequence**: `perf:budget` keeps only the release archive cap, which is a
distributed artifact and a cost a user pays. Nothing enforces web bundle size.
An accidental heavy dependency is caught by review and by the dependency
standard's measured-adoption rule, which is where a judgement about a trade
belongs. Reopen if the panel is ever served over a network.
