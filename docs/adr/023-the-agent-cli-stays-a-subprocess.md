# 023 The agent CLIs stay subprocesses, and the reason is licensing

**Status**: accepted
**Date**: 2026-08-18

`src/runtime/providers/**` plus `claude.ts` and `codex.ts` own argv construction
and stream-json reduction — 725 lines. `@anthropic-ai/claude-agent-sdk` 0.3.234
and `@openai/codex-sdk` 0.147.0 (both 2026-08-17) own exactly that, and
`codex-sdk`'s surface maps cleanly onto what is here: `startThread({sandboxMode,
approvalPolicy, workingDirectory, …})`, `runStreamed() → AsyncGenerator<ThreadEvent>`,
`resumeThread(id)`, and a `Usage` carrying the five token fields `recordCost`
already records.

The earlier objection — "the SDKs spawn a local child process, and model calls
must happen inside a sandbox" — **was wrong**. The SDK can run *inside* the
container; the image already has bun and node.

The objection that holds is Anthropic's, in the Agent SDK's own documentation:

> Unless previously approved, Anthropic does not allow third party developers to
> offer claude.ai login or rate limits for their products, **including agents
> built on the Claude Agent SDK**. Use the API key authentication methods
> described in the Quickstart instead.

The same page names the supported path for everything else:

> To drive the same agent loop from another language, **run the CLI as a
> subprocess** with the `-p` flag and `--output-format json`.

That is what `claude.ts:35` does. This product's shape is that the user signs in
with their own subscription (`auth.ts:571` injects `CLAUDE_CODE_OAUTH_TOKEN`);
adopting the SDK would turn that into a third-party product spending subscription
quota, which is the arrangement the note describes.

Two further facts for whoever revisits: `@anthropic-ai/claude-agent-sdk` is
licensed `SEE LICENSE IN README.md` — **not an OSI licence** — which matters for
a repository that is about to be public; and `@openai/codex-sdk`'s documentation
does not describe authentication at all, so the Codex side has no first-hand
answer and must not be assumed safe.

**Consequence**: the ~500 lines stay. `runtime/providers/**` would keep its
normalisation layer under either arrangement — the two SDKs' event models differ
from each other — so the deletion was always argv construction plus parsing.

**Reopen when**: Anthropic grants written approval, or the product moves to API-key
billing. Not on a technical trigger.
