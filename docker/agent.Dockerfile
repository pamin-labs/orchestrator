# What a group's sandbox is.
#
# bun runs the orch CLI and this project's own gates; node is here because
# `tsc` needs it and `oven/bun:1` alone does not have it; git because the
# checkout is a clone the agent commits to. The agent CLIs are installed at
# build time rather than per sandbox: every group would otherwise pay the same
# npm install before its first turn.
#
# Why an image at all, rather than a bare `ubuntu:24.04` the agent sets up
# itself — measured on this machine, per sandbox:
#
#   orch/agent:1                     3.8s to a usable sandbox
#   ubuntu:24.04                     2.4s to create
#     + git/node/npm via apt       297.9s
#     + claude + codex via npm      40.6s
#                                  ------
#                                  340.9s, and every group pays it again
#
# The bare image is the smaller pull, paid once; the toolchain is the larger
# cost, paid per group. 1.5GB on disk buys back five and a half minutes at the
# start of every requirement.
#
# Deliberately not opensandbox/code-interpreter either — 7GB for a superset
# nothing here uses (docs/adr/005).
# Pinned to the **manifest list**, not to one platform's manifest inside it.
#
# `sha256:50317d83…` was here, and that is the digest of the linux/amd64 image
# specifically — `docker manifest inspect` on it answers with a single manifest
# and no platform list. BuildKit still honours `--platform linux/arm64` against
# it by emulating, and it still sets `TARGETARCH=arm64` while the container
# underneath runs amd64 userspace. The Node install below therefore fetched an
# arm64 tarball into an amd64 container: the binary landed in the right place,
# at the right size, on PATH, and could not execute. `npm` went on working,
# because it is a shebang script that fell through to the base image's
# `node -> bun` shim, so the failure surfaced as bun complaining about a repl
# three lines from its cause.
#
# `sha256:e10577f0…` is the OCI image index, which carries both platforms. It
# is still an immutable pin — the index digest changes if any platform's image
# changes — and it is the one `TARGETARCH` can be trusted against, which is why
# Docker's own guidance is to pin the list rather than a member of it.
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4

# `upgrade` before `install`, and it is not belt-and-braces. A base image is a
# snapshot: `oven/bun:1.3.14` is pinned by digest, so every Debian package in it
# is frozen at whatever was current when that image was built, security updates
# included. Trivy counted 60 HIGH/CRITICAL after the Node change and the bulk of
# them were `perl` — pulled in by `git` — and `util-linux`, every one with a
# `deb13uN` fix already published. Installing without upgrading is choosing the
# snapshot's versions on purpose.
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends git ca-certificates curl xz-utils ripgrep \
 && rm -rf /var/lib/apt/lists/*

# `ripgrep` is here because the alternative costs tokens, not seconds. GNU grep
# does not read `.gitignore`, so a search runs into `node_modules/`, `dist/` and
# `coverage/` — and `load.ts` records that tool results are 90% of a transcript,
# so one search that finds the dependency tree can outweigh the whole 16k context
# budget the retrieval layer exists to protect. Measured in this image: 1.2 MB to
# download, 4.9 MB installed, and no dependency of its own.
#
# Not the copy codex vendors. There is a working ripgrep 15.2.0 inside
# `@openai/codex/.../codex-path/rg`, but it is off `PATH`, its directory is named
# for the architecture, and it belongs to a package that updates on its own
# schedule. claude ships none at all — checked in a live container, which is the
# only place that question has an answer.

# Node from nodejs.org, not from apt, and the difference is a hundred CVEs.
#
# Debian's `npm` package is a metapackage over the registry: installing it pulls
# `libnode-dev`, `libnode115` and the whole `node-*` set — `node-lodash`,
# `node-postcss`, `node-undici`, `node-minimatch` and dozens more — each frozen
# at whatever Debian shipped and each its own advisory surface. Trivy counted
# **145 HIGH/CRITICAL** in this image's Debian layer with that line in place,
# and none of them were reachable from anything this container runs: they are
# libraries nothing here imports, installed because a package manager thought
# `npm` needed them.
#
# The upstream tarball is one self-contained toolchain — node, npm and nothing
# else — on the current LTS rather than on Debian's, and it updates by changing
# two lines here rather than by waiting for a distribution rebuild.
#
# Checksummed against the release's own `SHASUMS256.txt`, because a tarball
# fetched over the network into an image that later holds credentials is exactly
# the place an unverified download is worth refusing.
# `TARGETARCH`, which BuildKit sets to the platform being built *for* — the
# documented mechanism, and the one that stays correct under cross-compilation
# where the builder and the target differ. It is only trustworthy because the
# `FROM` above pins the manifest list; against a single-platform digest the two
# disagree and the mismatch is silent.
ARG NODE_VERSION=24.19.0
ARG TARGETARCH
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) arch=x64; sha=14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647 ;; \
      arm64) arch=arm64; sha=01443c1e1a29e531ccad5a46fefa6df490d2189c49f7955904aecdbb0fe86fdc ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    archive="node-v${NODE_VERSION}-linux-${arch}.tar.xz"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${archive}"; \
    echo "${sha}  ${archive}" | sha256sum --check -; \
    tar -xJf "${archive}" -C /usr/local --strip-components=1 --no-same-owner \
      --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md; \
    rm "${archive}"; \
    node --version; \
    npm --version

# npm before the CLIs, and pinned like everything else here.
#
# The seven advisories left after the Debian layer was upgraded were all in
# npm's own bundled dependencies — `tar`, `undici`, `brace-expansion`,
# `ip-address` — frozen at whatever the Node tarball shipped with. They are not
# ours and not Debian's, and the only thing that moves them is npm itself.
# Upgrading first also means the two CLIs below are installed by the version
# that stays.
ARG NPM_VERSION=12.0.2
RUN npm install -g --no-fund --no-audit "npm@${NPM_VERSION}"

ARG CLAUDE_CODE_VERSION=2.1.233
ARG CODEX_VERSION=0.147.0
RUN npm install -g --no-fund --no-audit \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force

# execd replaces the entrypoint; this only matters if the image is run by hand.
CMD ["sleep", "infinity"]
