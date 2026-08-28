#!/usr/bin/env bash
# Does the agent image do what the role files promise?
#
# It was built, digest-verified, scanned and SBOM'd by three workflows and never
# once asked to run a command. So "does `mise install` write shims" — which
# mise's own `--help` denies, pointing at `mise activate` instead — was answered
# on a laptop, and a broken toolchain layer would have surfaced as every group in
# every non-JS project reporting a repository it cannot build.
#
# One script, three callers: preflight (which already builds this image),
# `security.yml` on every pull request, and `release.yml` on both architectures.
# A check that lives in one workflow answers about one moment.
set -euo pipefail

image="${1:?usage: image-smoke.sh <image-tag>}"

# What the image is for. `rg` prints its version on the first line only.
docker run --rm "$image" sh -c '
  set -eux
  bun --version
  node --version
  npm --version
  git --version
  mise --version
  lizard --version
  rg --version | head -1
'

# The toolchain path end to end, which is the whole reason mise is in the image:
# a repository pins a version, and the tool is on PATH afterwards — through the
# shims directory, since nothing here has an interactive shell to activate in.
probe="$(mktemp -d)"
trap 'rm -rf "$probe"' EXIT
echo 'jq 1.7.1' > "$probe/.tool-versions"
docker run --rm -v "$probe:/probe" -w /probe "$image" sh -c '
  set -eux
  mise install --yes
  jq --version | grep -q 1.7.1
'
