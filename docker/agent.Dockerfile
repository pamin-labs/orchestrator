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
FROM oven/bun:1.3.14@sha256:50317d83cd5a5ae1d8b35b3379c69f57ce1a0dbf4def91f0965653d767851834

# `upgrade` before `install`, and it is not belt-and-braces. A base image is a
# snapshot: `oven/bun:1.3.14` is pinned by digest, so every Debian package in it
# is frozen at whatever was current when that image was built, security updates
# included. Trivy counted 60 HIGH/CRITICAL after the Node change and the bulk of
# them were `perl` — pulled in by `git` — and `util-linux`, every one with a
# `deb13uN` fix already published. Installing without upgrading is choosing the
# snapshot's versions on purpose.
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends git ca-certificates curl xz-utils \
 && rm -rf /var/lib/apt/lists/*

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
