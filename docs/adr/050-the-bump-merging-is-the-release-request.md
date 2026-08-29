# 050 The bump merging is the release request

**Status**: accepted
**Date**: 2026-08-29

[013](013-immutable-release-provenance.md) made the version a decision recorded
on `main` and took the commit out of the release: "Version changes now land
through a normal pull request", "release never edits or commits source". That
holds and is not revisited here.

What 013 left was a second place to say the version. `release.yml` took it as a
required dispatch input and `checks` compared the two, so cutting a release meant
merging the bump *and* typing the number again. The first release after 013 died
on exactly that gap — a dispatch for 0.1.3 against a `main` still reading 0.1.2,
refused at step one with `Merge the 0.1.3 bump PR first`. The gate was right; the
second place to be wrong was the defect.

The version is now read from `package.json` at the selected SHA, and the workflow
runs itself: `workflow_run` after `ci`, `security` or `codeql` completes on
`main`. Merging the bump is the request. `workflow_dispatch` survives with no
inputs, for a run that was missed.

`dry_run` goes with the input. It existed to build everything and publish
nothing, and it was the default, which meant the publishing half was the half
nobody had ever run. It is also redundant against what 013 already built: a run
that fails before `publish` publishes nothing, and `checks` refuses only a
version that is *already published* — so a failed attempt leaves the same version
free to be attempted again, and a tag bound without a release resumes onto the
same source.

**Consequence**: a release has no inputs and no rehearsal. Three workflows
produce the required check names, so the run fires three times per merge and a
firing that finds the others in flight ends as *no release*, by notice. Every
commit that is not a version bump does the same. A run refusing is therefore the
ordinary state, and the gate had to stop saying it in red — `checks` now reports
three outcomes rather than two, and `release=false` is one of them.

**Consequence**: every job carries
`if: needs.checks.outputs.release == 'true'` rather than inheriting a skip
through `needs`. The cascade is real, but it makes "can this step be reached
without authorisation" a graph walk, and a publish that should not have happened
is the one failure here that cannot be taken back.
