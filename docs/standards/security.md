# Security standard

## Trust boundaries

The browser/panel, agent protocol, mailbox files, config, database migrations,
provider output, GitHub, repository content, and subprocess arguments are trust
boundaries. Parse inputs before use and keep authorization separate from
authentication.

- Agent identity is derived from its scoped token, never from a caller-supplied
  role/group field.
- `orch lease` selects a registered resource and schema-validated arguments. It
  never accepts a free shell command.
- Repository content executes only in an agent container. The credentialed
  utility container never checks out or executes it and disables Git hooks.
- Real model/GitHub credentials remain outside agent containers. Do not log,
  return, mount, persist, or attach them to errors.
- Validate and normalize paths before access; resolve symlinks where the
  security property depends on the final target. Reject traversal and ambiguous
  encodings.
- Build database and shell operations with parameters/argument arrays. Never
  interpolate untrusted text into SQL or a shell.
- Outbound URLs enforce allowed scheme/host/address behavior and resist DNS
  rebinding/SSRF where credentials may be substituted.
- Logs use the existing scrub/mask path. Stack traces, prompts, user text,
  tokens, host paths, and provider bodies are not public error detail or metric
  labels.
- Dependencies, actions, and permissions are minimized. Fork PR workflows do
  not receive secrets or write tokens.

## Enforcement owners

CodeQL owns source data-flow SAST; Fallow owns reachable security candidates;
`bun audit` owns current lockfile vulnerabilities; GitHub Dependency Review owns
PR dependency/licence changes; Trivy owns filesystem/container vulnerabilities
and SBOM; actionlint and zizmor own workflow syntax and security. Do not add a
second scanner for the same class without replacing the first in the
[`enforcement matrix`](enforcement-matrix.md).

Fallow's candidates are unverified by construction, so each one carries a
recorded decision and a reason in
[`../operations/security-candidates.md`](../operations/security-candidates.md).
A candidate is fixed at the point its value enters the process, or annotated on
the line with why that sink cannot be driven; nothing stays undispositioned.

Report vulnerabilities through the private process in
[`../../SECURITY.md`](../../SECURITY.md). GitHub repository settings must enable
secret scanning and push protection; this cannot be guaranteed by workflow
files.
