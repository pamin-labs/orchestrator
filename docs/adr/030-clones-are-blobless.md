# 030 Clones are blobless, not shallow

**Status**: implemented, as part of 007.
**Date**: 2026-08-15
**Split from**: [007](007-github-is-the-source-of-a-project.md) on 2026-08-19,
which carried seven decisions in one file against this directory's own rule. The
shared context — why the host stopped being a git participant, what it deleted,
and the measured path-scoping the whole thing rests on — stays in 007, which
is now the index. This was decision *7. `--filter=blob:none`* there; the text is unchanged.

Blobless, not `--depth=1`. Shallow is faster (4× vs 1.5× on the kernel) and breaks
`rebase` and `merge-base --is-ancestor`, both of which we use. GitHub measures an
88.6% average reduction in clone time across repositories using partial clone.
Independent of everything else here; can land first.
