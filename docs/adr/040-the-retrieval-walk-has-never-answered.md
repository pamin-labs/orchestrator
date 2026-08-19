# 040 PageIndex stays, because the question it was asked has never been tested

**Status**: accepted
**Date**: 2026-08-20

Wave 5.1 exists to settle one claim by measurement rather than by repetition: that
PageIndex's model-call layer pays for itself, because "超过六十轮的 turn 吃掉了 59%
的 cache-read 账单". That sentence appears three times in this repository and was
never measured.

## What the data says

From the pre-migration database, 98,056 spans over 2026-08-19:

| | |
|---|---|
| `index.ask` calls | 36 |
| succeeded | **0** |
| wall clock spent | **738.5s** |
| mean per call | 20.5s (max 24.4s) |
| share of every error span in the system | **36 of 56 — 64%** |

Every one of those traces is the same three spans: `sandbox.put_file`,
`sandbox.exec`, `index.ask`. Nothing else. The walk stops after the first failed
call — a failed `ask` returns `""`, `pickedIds` yields nothing, and `search`
returns — so this is one failed call per query, not three. Each `orch ctx query`
that reached the tree paid about 20.5 seconds to learn nothing and then fell
through to the lexical half, which ADR 020 measured at 0.32ms.

So the 59% claim is not refuted here. It is **untested and untestable**: the layer
has not returned an answer at all in this history, so there is no cache behaviour
of its to compare against.

## Why it cannot be diagnosed from that data

`index.ask` recorded `exit 1` and nothing else. The panel reads `status_message`,
so the most expensive model call in the system failed all day and looked quiet.
The boss *was* told — "PageIndex 建不起来：12 次调用全部没有返回" was emitted 43
times — but nothing recorded why, and the two settings events show both runtimes
being tried and reverted (`indexModel.runtime = "claude"`,
`indexModel.model = "claude-haiku-4-5-20251001"`), so it is not one model name.

That is the decision this ADR is really about: **the span now carries what the CLI
said**, scrubbed and clipped. A number with no sentence beside it cannot be acted
on.

## The decision

1. **Nothing is cut.** Cutting on this data would be cutting on a failure whose
   cause is unknown, which is the same mistake as keeping it on an unmeasured
   sentence — the failure is far more likely to be a credential or CLI problem
   than a verdict on tree navigation.
2. **The default stays on.** `pageindex.enabled` (ADR: this one) exists so the
   comparison can be run once calls succeed. Defaulting it off would bury a
   fixable misconfiguration behind a config change nobody revisits.
3. **Re-decide from the next window**, when `index.ask` failures name themselves.
   If they still fail, that is a defect to fix. If they succeed, the A/B the plan
   asks for finally has two sides.

**Consequence**: the retrieval question is deferred *with a date and a trigger*
rather than with an opinion, and `orch ctx query` stops being the one waiting path
that fails without saying why.
