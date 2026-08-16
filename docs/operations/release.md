# Release operations

Releases are immutable products of one already-reviewed `main` commit. A release
workflow never edits source, bumps a version, commits, rebases, or cherry-picks.

## Before dispatch

1. Land the version bump as an ordinary pull request.
2. Confirm the selected SHA is reachable from `main` and all required checks
   passed for that SHA.
3. Confirm the version/tag/release does not exist and package metadata matches
   the requested version.
4. Run a dry run. It may build and verify but must not push a tag, image,
   release, attestation, or mutable registry tag.

## Build once from the selected SHA

- Build five binaries: Linux x64/arm64, macOS x64/arm64, Windows x64.
- Build native amd64 and arm64 container images, then join their digests into a
  multi-platform manifest.
- Verify each archive contains the expected binary/config/roles/web assets,
  reports the requested version, starts far enough to prove the executable
  format, and appears in the artifact manifest.
- Scan filesystem and images with Trivy and emit SPDX and CycloneDX SBOMs.
- Generate `SHA256SUMS` for every published archive and manifest evidence.
- Generate GitHub artifact provenance attestation bound to the selected source
  SHA and subject digests.

Only after every build and verification succeeds may the workflow publish the
versioned multi-platform image and, as its final external write, create
`v<version>` and the GitHub release with
`gh release create --target <sha> --generate-notes`. A failed pre-publication
run leaves no release/tag. Published artifacts are never replaced; issue a new
version.

Use [`rollback.md`](rollback.md) for a bad release. Release evidence and known
limitations belong in the release notes, not a workflow-generated source commit.
