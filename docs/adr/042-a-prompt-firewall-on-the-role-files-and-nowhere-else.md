# 042 A prompt firewall on the role files, and nowhere else

**Status**: accepted; the "known next step" section is superseded by
[`047`](047-the-fence-does-not-need-the-nonce-in-the-prefix.md).
**Date**: 2026-08-21

A role's prompt can carry text shaped like an instruction rather than like data —
a role file arrives by copy-paste from somebody else's installation, and nobody
reads all of it. `promptpurify` (MIT, 0.0.1) is adopted to refuse those at load
time, with its probabilistic half deliberately switched off.

It is adopted at **one** place. A second gate was designed, built, measured, and
rejected; that measurement is recorded below because it is the part of this work
most likely to be proposed again.

## What each gate owns

`src/mech/flow/chain.ts`'s `isReserved()` decides **whether a human must rule on
this topic** — spending money, merging to `main`, credentials, going live,
changing scope — and routes an escalation. Its input is a question an agent chose
to ask; its output is a routing decision.

`src/platform/text/prompt-guard.ts`'s `findHijack()` decides **whether a span of
text is pretending to be a command**. Its input is text on its way into a prompt;
its output is a rule id and the offending span.

One string can trip both. That is two correct answers about two different
questions, not two owners of one risk. The boundary that keeps it so:
**`findHijack` must never influence escalation routing.** It refuses a file at
startup; it does not decide severity, chain entry, or who answers. The moment its
verdict picks the answerer it has become a second owner of the gate `isReserved`
exists to be, and this ADR is void.

## Why the classifier is not wired

promptpurify ships a deterministic structural layer (L1 normalization, L2 nonce
fencing, L4 tripwires) and a probabilistic one (L5a, a logistic model in pure TS;
L5b–L5e, ONNX models that are a separate 14MB download). Measured on this
repository before adopting it:

| corpus | n | result |
|---|---|---|
| real commit diffs from `main` | 40 | 100% flagged; `encoded-payload` fires on the git SHA every time |
| real `src/**/*.ts` file heads | 60 | 75% flagged, 1 blocked |
| benign repo content, L5a score | 100 | p05 0.383, **p50 0.545**, p95 0.965 |
| eight real injections written against *this* orchestrator | 8 | six score **0.25–0.40** |

Six of eight genuine attacks rank *below* the median of ordinary source code.
No threshold separates them, so the score is not a usable signal here and no
tuning makes it one. For comparison, `isReserved()` — twenty lines of regex
already in the tree — catches five of those same seven orchestrator-shaped
attacks.

So the gate is `verdict === "blocked"`, the deterministic layer alone. Under it
all ten files in `roles/` load. Under `flagged` with the classifier running, five
of the ten are refused at startup.

Two things keep the classifier out, and only one is a decision: none is
configured, and `findHijack` calls the synchronous `inspect()`, which does not run
one even if a later edit passes it — only `inspectAsync()` does. `onnxruntime-node`
is not a dependency of this project.

## The gate: `loadRoles`, fail closed

A role whose prompt trips the gate does not start. Better a role that will not
load than one running a backdoor its author never read. Fail-closed is affordable
because it was measured: 0 of 10 shipped roles are refused.

The sink is `untrusted_data`, not `trusted_instruction`. This looks backwards and
is not: `trusted_instruction` is the sink for text that is *allowed* to command
the model, so nothing is ever `blocked` under it and the gate would pass
everything. The first implementation had this wrong and the test caught it. A role
file is checked precisely because it may not be ours.

The failure is `RolePromptHijackError`, which carries `code`, `file`, and the
`hijack` (`rule`, `message`, `excerpt`) as **fields rather than one sentence** —
the panel renders it as a dismissible notice with the filename and the offending
text shown separately, and a message built by concatenation would only have to be
parsed apart again there.

## The gate we rejected: checking the assembled prompt

The stronger-sounding proposal was to check the prompt assembled for each turn on
its way to the agent. The reasoning was sound — that is where indirect injection
actually arrives (the boss's own words, an issue body, whatever `orch ctx query`
pulled out of the repository), and none of it is visible to `loadRoles`.

It was built and measured. Four real turns, assembled through `buildDelta`:

| turn | verdict |
|---|---|
| card + unread digest | clean |
| card + boss's Chinese requirement | clean |
| rejection + a real commit diff | flagged (`encoded-payload` on the commit SHA) |
| card + `src/runtime/codex.ts` via `orch ctx query` | **blocked** |

The last one is the finding. `src/runtime/codex.ts:36` reads
`argv.push("--ignore-user-config", "--ignore-rules")` — real Codex CLI flags, one
of the two runtimes this project drives. The structural layer blocks on
`ignore-rules`. An engineer asked to audit that file would have the turn refused,
deterministically, every time — not a probabilistic false positive that better
tuning could shrink, but a fixed string in our own source.

That leaves only fail-open variants: report the hit and send the turn anyway. An
advisory-only version was built and worked. It was still dropped, because a check
that never refuses on a path whose false positives are deterministic buys a queue
of notices about our own source code, and the honest cost of keeping it is that
somebody eventually raises the threshold to make the noise stop.

`test/platform/prompt-guard.test.ts` keeps the `codex.ts` case as a fixture, so
the day promptpurify stops firing on it, this decision can be reopened with
evidence rather than from memory.

## The dependency, against the rules in CLAUDE.md

- **Replaced implementation**: none. A net addition, not a substitution — the one
  rule in `CLAUDE.md` this adoption does not satisfy, stated rather than finessed.
- **Maintenance**: one maintainer, one published version (0.0.1, 2026-05-30), no
  release history. The real risk here, and the reason the surface used is the
  small deterministic one and the blast radius is startup.
- **Security**: zero transitive dependencies, npm provenance attestation (SLSA).
- **Licence**: MIT, SDK and weights.
- **Cost**: none. No network, no model download, no GPU. `inspect()` is 0.25ms at
  1KB and 55ms at 200KB; it runs once per role at boot.
- **Rollback**: delete one call site and one file. Nothing persists a verdict.

## Known next step: L2 nonce fencing, and what blocks it

> **Superseded by [`047`](047-the-fence-does-not-need-the-nonce-in-the-prefix.md).**
> Three claims below are false against the installed package. L2 has no
> false-positive cost — it does: `harden()` strips indentation and chat-template
> tokens from what it fences. The way out is a per-session nonce — it is not
> reachable, because `buildMessages` mints its own and exports no seam; the way
> out is that the nonce does not belong in the hashed half at all. And this does
> not address the injection path the rejected gate was aimed at: `orch ctx query`
> output is a Bash result inside the agent's own session and never reaches
> `assemble.ts`. The section is kept as the record of what was believed.

The genuinely valuable half of this library is the one not adopted here.
`buildMessages()` wraps untrusted spans in `<<DATA:label:nonce>> … <<END:…>>` and
tells the model, in trusted text, that everything inside is data. It *transforms*
rather than *judges*, so it has no false-positive cost at all — the only mechanism
here that does not, and the only one that would address the injection path the
rejected gate was aimed at.

It is deferred because it collides with the invariant `src/prompt/assemble.ts`
exists to protect. The fence notice has to live in `systemAppend`, which
`StablePrompt.hash` covers, and promptpurify's nonce is random per call. A nonce
that changes every turn changes the hash every turn, so `needsRotation()` fires
every turn and each one re-reads the whole prompt at full price instead of 0.1x —
precisely the disaster that file's header warns about.

The way out is a **per-session nonce**, minted once when the session is created
and carried on it, so the stable half stays byte-identical for the session's life.
Worth doing on its own, and not worth doing carelessly.
