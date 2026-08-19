# Release operations

Releases are immutable products of one already-reviewed `main` commit. A release
workflow never edits source, bumps a version, commits, rebases, or cherry-picks.

## Before dispatch

1. Land the version bump as an ordinary pull request.
2. Confirm the selected SHA is reachable from `main` and all required checks
   passed for that SHA.
3. Confirm the version/tag/release does not exist and package metadata matches
   the requested version.
4. Run a dry run. It builds binaries and images, scans them, generates SBOMs,
   checksums, manifests, and workflow artifacts, but does not push a registry
   tag, Git tag, GitHub release, or registry/GitHub attestation.

## Build once from the selected SHA

- Build five binaries: Linux x64/arm64, macOS x64/arm64, Windows x64. Linux and
  Windows x64 use Bun's baseline targets so the published x64 artifacts do not
  require AVX2.
- Build native amd64 and arm64 container images, then join their digests into a
  multi-platform manifest.
- Verify each archive contains the binary, bundled `orch` CLI, config, roles,
  web assets, package metadata, licence, README, and release manifest. The
  bundled CLI must report the package version; the native Linux x64 server must
  report that version and pass `/healthz`.
- Scan filesystem and images with Trivy and emit SPDX and CycloneDX SBOMs.
- Generate `SHA256SUMS` for every published archive and manifest evidence.
- Generate GitHub artifact provenance attestation bound to the selected source
  SHA and subject digests.

## Publication and resume points

Publication is an ordered, recoverable state machine:

1. push per-platform `sha-<source>-<platform>` staging images and verify their
   immutable digests;
2. create or verify identical platform version tags, the staged manifest, and
   the immutable version manifest;
3. scan and attest the version manifest, then assemble checksummed release
   evidence;
4. atomically bind `v<version>` to the verified source and create the GitHub
   release;
5. compare-and-swap `latest` from the digest observed before publication to the
   published version digest.

A failed publishing run can therefore leave verified staging tags, immutable
version tags/digests, attestations, or an unpublished Git tag. These are not
overwritten or deleted. Rerun the same version and source: the workflow reuses
only byte-identical/digest-identical state and rejects divergence. If the GitHub
release exists but `latest` promotion failed, rerun the failed job so its saved
manifest output is retained; do not re-cut the release.

`latest` advances only after the GitHub release exists. Published artifacts,
tags, attestations, checksums, and image digests are never replaced; a
correction is a new version.

Use [`rollback.md`](rollback.md) for a bad release. Release evidence and known
limitations belong in the release notes, not a workflow-generated source commit.
