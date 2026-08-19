# 031 Retrieval stays lexical, because the embedding cannot rank across languages

**Status**: accepted, as a measured refusal. **Amended 2026-08-19** — the first
version of this refused on package size and was measuring the wrong thing.
**Date**: 2026-08-18, amended 2026-08-19
**Follows**: [020](020-retrieval-is-rented-and-multilingual.md), which reserved
the seam — *"a field on this schema and a mode passed to `search`"* — and
[021](021-stop-words-are-rented-and-merged-by-script.md).

The gap is real. The corpus is split by language on purpose — journals in Chinese,
ADRs and standards in English, code identifiers in English — and BM25 cannot cross
that line. A Chinese question cannot reach an English symbol name. Local rather
than hosted, because a remote embedding sends the boss's own requirements and
acceptance criteria to a third party, and that is a decision rather than a default.

## What the first version got wrong

It refused on size: `@huggingface/transformers` installs 384 MB, against a 160 MB
release-archive budget. That number is real and it is the wrong number. It is the
size of the **package**, and the package ships every ONNX Runtime variant —
`onnxruntime-node` at 212 MB and `onnxruntime-web` at 131 MB, of which the web
build alone carries four `.wasm` files between 13 and 26 MB.

What ships is one runtime and one wasm:

```
ort-wasm-simd-threaded.wasm   13 MB
ort.wasm.mjs                 559 KB
```

**13.5 MB**, and this repository already bundles a `.wasm` exactly this way — the
tree-sitter grammars go in through `with { type: "file" }` because
`Parser.init()` cannot find them inside a compiled binary. Size was never the
obstacle, and *"measure the artefact, not the source"* is a rule this document
broke while citing it elsewhere.

## What the obstacle actually is

Measured on this repository's own shape — five passages, three questions, the
model's own required `query:` / `passage:` prefixes, `dtype: "q8"`:

```
Q: 沙盒是怎么启动的           small          base
   中-沙盒  (right, zh)      0.899          0.882
   中-迁移  (WRONG, zh)      0.845          0.825
   英-沙盒  (right, en)      0.764          0.758

Q: 迁移编号在哪检查
   中-迁移  (right, zh)      0.921          0.896
   中-沙盒  (WRONG, zh)      0.856          0.849
   英-迁移  (right, en)      0.827          0.837
```

**Within a language the ranking is correct. Across languages it is not:** an
irrelevant passage in the question's own language outranks the relevant passage in
the other one, on both questions and at both model tiers. `multilingual-e5-base`
has more than twice the parameters of `small` and the gap does not close — it
narrows on one question and widens on the other, which is noise rather than a
trend. Language dominates topic in this family.

That is exactly and only the case the feature existed for. Within-language recall
is already BM25's, and BM25 does it without 13.5 MB, a 120 MB model download, and
a vector column.

The prefixes matter and are worth recording: without them every pair lands between
0.75 and 0.87 and nothing is separable at all. The first run of this measurement
omitted them and produced a verdict about the model that was really a verdict about
how it had been called — the same mistake as the package-size number, one layer up.

## What this means

Retrieval stays lexical: `terms()` over `Intl.Segmenter`, rented stop words, BM25.
Cross-language recall stays a known gap, stated rather than silent.

The seam ADR 020 reserved is untouched and costs nothing to keep: `mode: 'hybrid'`
and a `vector[N]` field are in the installed Orama.

**Reopen when a model ranks the relevant other-language passage above an
irrelevant same-language one** on the table above. That is a runnable check rather
than a judgement, and the corpus is five sentences.

It is now literally runnable: `bun run embedding:check` scores that table against
whatever `embedding` in the config names and exits non-zero while this refusal
stands. `mode: local` needs `@huggingface/transformers`, which is deliberately not
a dependency and which the command says how to add. `mode: remote` needs an
endpoint and the name of a stored credential, which is the half below that could
not be tested before. Candidates worth the download
when one appears: `bge-m3`, which is built for exactly this and is far larger, or a
hosted embedding — which needs the boss's own endpoint, and is a different
decision because the corpus would leave the machine.

Not measured and deliberately not guessed: whether a hosted embedding does better
on this corpus. That test needs the endpoint the boss would choose — which is why
`embedding` exists in the config and in settings, defaulting to `local`. A remote
embedding sends the corpus, and the corpus is the boss's own requirements and
acceptance criteria, so that switch is a decision rather than a fallback
(`docs/standards/security.md`).
