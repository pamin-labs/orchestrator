# Rollback operations

Rollback means restoring a known compatible application and data state, not
force-moving a published release tag.

## Application-only change

Stop intake, let or cancel active work through graceful shutdown, deploy the
last known-good immutable artifact by digest/checksum, then run readiness and a
representative read/write smoke. Preserve the failed version's logs, request
IDs, database copy, and release manifest for diagnosis.

## Database or protocol change

Before migration, record the database backup location, schema version, selected
source SHA, and validation queries. Roll back the binary only when its supported
schema includes the migrated version. Otherwise restore the backup while intake
is stopped, verify the schema stamp and invariant queries, then start the
compatible binary.

An irreversible migration requires an ADR and forward-fix procedure before
release. Do not improvise reverse SQL against the only copy of production data.

## Bad published release

Do not overwrite artifacts, checksums, attestations, tags, or image digests.
Mark the release with a prominent warning, stop `latest` from pointing at the
bad digest by publishing a new fixed version, and document affected versions and
operator action in release notes/security advisory as appropriate.

After recovery, add a regression gate for the failed property and record the
verified cause in an ADR only if it changes an architectural decision.
