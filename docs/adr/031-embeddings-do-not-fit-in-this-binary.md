# 031 Local embeddings do not fit in this binary, so retrieval stays lexical

**Status**: accepted, as a measured refusal.
**Date**: 2026-08-19
**Follows**: [020](020-retrieval-is-rented-and-multilingual.md), which reserved
the seam — *"a field on this schema and a mode passed to `search`"* — and
[021](021-stop-words-are-rented-and-merged-by-script.md).

The plan was hybrid retrieval: BM25 over `terms()` plus a local embedding, so a
Chinese question could reach an English symbol or an English summary. The reason
is real — the corpus is split by language on purpose (`docs/journal/` is Chinese,
ADRs and standards are English) and BM25 cannot cross that line. Local rather
than hosted, because a remote embedding would send the boss's own requirements
and acceptance criteria to a third party, which is a decision the boss makes and
not a default.

Both candidates were installed and run before anything was written. Neither ships.

## `@huggingface/transformers` 4.2.0 — 384 MB

```
node_modules            384M
  onnxruntime-node      212M
  onnxruntime-web       131M
  @huggingface           14M
```

`scripts/performance-budget.ts` caps a release archive at **160 MB** and the
compiled binary is 65 MB. The runtime alone is more than twice the whole budget,
before any model weights. There is no configuration of this that fits.

## `@orama/plugin-embeddings` 3.1.18 — 69 MB, and it does not run

Smaller, pure JavaScript, no native bindings — so on size alone it was the
plausible one. It does not work as installed:

- It declares `@tensorflow-models/universal-sentence-encoder` and `@orama/orama`
  and **no TensorFlow backend**. Loading the model throws
  `No backend found in registry`.
- Adding the current `@tensorflow/tfjs-backend-cpu` (a further 11 MB) trades that
  for `tfjsCore.util.convertBackendValuesAndArrayBuffer is not a function` — the
  backend is built against a newer core than the plugin's transitive pin.

Two further facts that would have mattered even if it had run:

- The weights are fetched from `storage.googleapis.com` and `tfhub.dev` at first
  use. A retrieval layer that silently needs Google on a cold start is a new
  external dependency in a product whose whole shape is about where things run.
- Universal Sentence Encoder is English-first, and the case for embeddings here
  *is* the Chinese half of the corpus. The measurement that would have decided it
  could not be taken, because the model could not be loaded.

## What this means

Retrieval stays lexical: `terms()` over `Intl.Segmenter`, rented stop words,
BM25. Cross-language recall stays a known gap — a Chinese question still cannot
reach an English symbol name — and it is a stated gap rather than a silent one.

The seam ADR 020 reserved is untouched and costs nothing to keep: Orama's
`mode: 'hybrid'` and a `vector[N]` schema field are in the installed version.

**Reopen when** any of these becomes true, and the first one is the likely one:

- an embedding runtime for JavaScript exists that is tens of megabytes rather
  than hundreds, or `onnxruntime-node` can be installed without the web build;
- the product stops shipping as a single compiled binary, which is what makes
  160 MB the number that matters;
- the boss asks for hosted embeddings *explicitly*, which makes the corpus
  leaving this machine a decision instead of a default. The seam is already
  designed for it: `cfg.embedding: { mode, endpoint }` beside `cfg.indexModel`.

Not measured and deliberately not guessed: whether a hosted embedding would
actually fix cross-language recall on this corpus. That test needs the endpoint
the boss would choose.
