# 013 Releases are immutable products of a verified SHA

**Status**: accepted
**Date**: 2026-08-17

The previous release workflow formatted source, changed the version, committed,
pushed, built, tagged, and cherry-picked. The code reviewed on `main` was not
necessarily the exact source selected at dispatch, and failure could leave
partial mutable state.

Version changes now land through a normal pull request. Release selects a
verified `main` SHA, builds five binaries and native amd64/arm64 images from that
SHA, verifies archives/version/start/manifest, scans with Trivy, emits SPDX and
CycloneDX SBOMs, creates `SHA256SUMS`, and generates GitHub provenance
attestation. The tag/release is created last with an explicit target SHA.

**Consequence**: release never edits or commits source. Dry run publishes
nothing. Published tags, artifacts, attestations, checksums, and image digests
are not replaced; a correction is a new version.
