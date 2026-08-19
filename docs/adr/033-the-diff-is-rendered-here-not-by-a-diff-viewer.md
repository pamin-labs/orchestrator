# 033 The diff is parsed by a library and rendered by us

**Status**: accepted
**Date**: 2026-08-19
**Follows**: `docs/design/ui.md`, and the rule in `AGENTS.md` that a capability a
maintained library already provides is not written here.

Accepting a slice is one of the three things the boss is here to do, and the diff
is the thing they read before doing it. It was a raw unified diff in one `<pre>`:
`diff --git` and `index` lines as grey noise, every changed line coloured red or
green as *text*, no line numbers, no file boundaries, and a cut at 120 lines
wherever that happened to land. Reading it was work.

## What is rented

`parse-diff` for the unified format and `diff` for the intra-line pass. Both are
small, dependency-free, and older than any bug we would reintroduce by parsing a
diff by hand.

## What is not, and why

`diff2html` and the viewers like it bring their own stylesheet and a syntax
highlighter. This panel has its own design language and, by a test, fetches
nothing at runtime — `test/smoke.test.ts` enforces the second, and the first is
the reason a bundled stylesheet is a cost rather than a saving. Rendering is
four decisions, each aimed at one reason the old view was tiring:

1. **Side by side**, old left, new right, aligned. A unified diff makes the
   reader reconstruct the pairing, and that reconstruction is arithmetic.
2. **Tint the row, not the ink.** Coloured body text is hard to read past a few
   lines. The row gets a wash, the code stays in normal ink.
3. **Word-level marks.** A one-character change used to look like a rewritten
   line.
4. **Line numbers on both sides, and a file list.** QA's verdict says
   `requirement.tsx:177` and there was no way to reach line 177.

None of the four is what a viewer library would give without being fought.

## Deliberately not done

No syntax highlighting. It is a whole tokenizer or a large dependency, and the
thing being read is a change rather than a program. **Reopen** if reading a change
turns out to need the language — which would show up as reviewers asking what a
line does, not as a preference.
