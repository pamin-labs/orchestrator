# The orchestrator itself, for a machine that has Docker and nothing else.
#
# bun and node are not a big ask, but "I have Docker" is already true of every
# user — the sandboxes are containers, so Docker is not an extra dependency here,
# it is the existing one. That makes an image the cheapest way to run this
# without installing a toolchain.
#
# Built with `bun build --compile`, which is also how the standalone release
# binary is made: one executable with the runtime inside it, so the image needs
# no bun installed and no `node_modules` at all. `ROOT` knows about that layout —
# a compiled binary's modules live in bun's read-only virtual filesystem, so it
# falls back to the executable's own directory, which is where the assets below
# are copied.
#
# READ THIS BEFORE DEPLOYING IT, because two things about this container are not
# like running it on a host:
#
#   1. It does not manage opensandbox-server. Inside a container it cannot see
#      the host's processes or spawn one, so `ensureServer` will report "not
#      running" and stop there. Point `ORCH_SANDBOX_SERVER` at one — another
#      container, a Tailscale peer, or a host address that resolves from here.
#
#   2. The staged skills directory is bind-mounted into every sandbox **by the
#      sandbox server's Docker daemon**, using the path as that daemon sees it.
#      If this container writes skills to a path that means something different
#      over there, the mount succeeds and delivers an empty directory — the exact
#      silent failure this project already has scar tissue for. Mount the same
#      host path at the same absolute path in both, and put it in the sandbox
#      server's `allowed_host_paths`.
FROM oven/bun:1-alpine AS build
WORKDIR /app

# The lockfile first, so a dependency-free change does not reinstall the world.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
# The panel is served from `web/dist` and nothing rebuilds it at runtime; an
# image without this step serves a blank page.
RUN bun run build:web

# One file instead of a dependency tree. `node_modules` is 100MB in the image and
# 460KB once bundled — the same code, minus every file that was only ever there
# so an import could resolve.
#
# It lands in `dist/` and not at the root because `ROOT` is derived from this
# file's own location (`dirname(import.meta.url) + "/.."`), and everything read
# at runtime — config, roles, the panel, the `orch` CLI copied into sandboxes —
# hangs off it.
RUN bun build --compile --minify src/server.ts --outfile /out/orch-server

# Plain alpine: with the runtime compiled into the binary there is nothing left
# for a bun image to provide.
#
# No `git`, and that is a fact about the design rather than a saving. Since 007
# every git command runs inside a container — `sandboxGit` for a group's clone,
# `utilGit` for the mirror and the push — and `makeGitRunner`, the last thing
# that shelled out here, is gone. 17MB of it was in this image because the
# Dockerfile was written from memory of an older architecture.
#
# `wget` for the health check comes with busybox, so no `curl` either.
FROM alpine:3
WORKDIR /app
RUN apk add --no-cache ca-certificates libstdc++

# Named, not `COPY --from=build /app /app`. Copying the whole stage brought the
# build's node_modules, the tests, the docs and the git history along with it —
# 188MB for a tree whose useful part is a few MB.
COPY --from=build /out/orch-server ./orch-server
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/package.json ./package.json
COPY roles ./roles
COPY config ./config
COPY web/index.html ./web/index.html
COPY web/icon.png web/favicon-32.png web/apple-touch-icon.png ./web/
# Not the whole of `src`: this one file is read at runtime and copied into every
# sandbox, so the agents' CLI always matches the orchestrator serving them.
COPY src/orch/cli.ts ./src/orch/cli.ts

# 0.0.0.0 because a port published out of a container is unreachable if the
# process binds loopback. That is a real exposure: this service has no login, so
# whoever reaches it is the boss. Publish it to 127.0.0.1 on the host
# (`-p 127.0.0.1:47821:47821`), or put a reverse proxy with auth in front of it.
# `ORCH_IN_CONTAINER` is read by `inContainer()`. Three of the environment
# checks — docker, uv, the egress image — are questions about the machine running
# the sandbox server, and in here that machine is somebody else's: asked anyway
# they answer "broken" about a deployment that works, and every fix they print is
# a command for a host this process cannot see.
ENV ORCH_IN_CONTAINER=1 \
    ORCH_HOST=0.0.0.0 \
    ORCH_PORT=47821 \
    ORCH_DATA_DIR=/data

# The database, the attachments, the gate logs and the staged skills. Losing this
# volume loses every requirement's history — nothing here is on the remote.
VOLUME ["/data"]
EXPOSE 47821

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -q -O /dev/null "http://127.0.0.1:${ORCH_PORT}/api/state" || exit 1

CMD ["./orch-server"]
