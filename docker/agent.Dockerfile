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

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl nodejs npm \
 && rm -rf /var/lib/apt/lists/*

ARG CLAUDE_CODE_VERSION=2.1.233
ARG CODEX_VERSION=0.147.0
RUN npm install -g --no-fund --no-audit \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force

# execd replaces the entrypoint; this only matters if the image is run by hand.
CMD ["sleep", "infinity"]
