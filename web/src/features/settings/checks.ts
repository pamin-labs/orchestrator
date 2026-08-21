import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { i18n } from "../../i18n";
import type { Said } from "../../../../src/contracts/said.ts";

/**
 * What a host check can say, declared where `lingui extract` can see it.
 *
 * ADR 041: the server names the sentence and the panel renders it. The id is
 * written out rather than hashed from the English, because the server sends it
 * — a hashed id would change the day somebody reworded a sentence on the other
 * side of the wire.
 */
/**
 * Not exported: `checkText` below is the only reader, and `lingui extract` finds
 * a `msg` call by parsing the file rather than by importing it. This is the one
 * place the English of a check is written on this side of the wire.
 */
const CHECKS: Record<string, MessageDescriptor> = {
  "check.database.ok": msg({ id: "check.database.ok", message: "migrated and queryable" }),
  "check.preflight.failed": msg({ id: "check.preflight.failed", message: "the checks could not run: {error}" }),
  "check.docker.running": msg({ id: "check.docker.running", message: "running" }),
  "check.docker.silent": msg({ id: "check.docker.silent", message: "installed, but the daemon is not answering" }),
  "check.docker.absent": msg({ id: "check.docker.absent", message: "not reachable" }),
  "check.docker.fix.start": msg({
    id: "check.docker.fix.start",
    message: "Start Docker Desktop, or run colima start, and wait for it to report running.",
  }),
  "check.docker.fix.install": msg({
    id: "check.docker.fix.install",
    message: "Install Docker — or Colima, or Podman, anything that provides a docker socket — and start it.",
  }),
  "check.uvx.present": msg({ id: "check.uvx.present", message: "uvx available" }),
  "check.uvx.absent": msg({ id: "check.uvx.absent", message: "no uvx on PATH" }),
  "check.uvx.fix": msg({
    id: "check.uvx.fix",
    message: "Run brew install uv. opensandbox-server is a Python package, so without uv there is nothing to start.",
  }),
  "check.server.reachable": msg({ id: "check.server.reachable", message: "reachable" }),
  "check.server.keyMissing": msg({
    id: "check.server.keyMissing",
    message: "server requires an API key and none was sent",
  }),
  "check.server.keyRejected": msg({ id: "check.server.keyRejected", message: "server rejected the API key" }),
  "check.server.http": msg({ id: "check.server.http", message: "HTTP {status}" }),
  "check.server.unreachable": msg({ id: "check.server.unreachable", message: "cannot reach it: {error}" }),
  "check.server.fix.contained": msg({
    id: "check.server.fix.contained",
    message:
      "Run uvx opensandbox-server on the host, not here: this orchestrator is inside a container and the sandbox server needs the host's docker. Then point ORCH_SANDBOX_SERVER at it — host.docker.internal:8080 on Docker Desktop, the host IP or --network host on Linux.",
  }),
  "check.server.fix.host": msg({
    id: "check.server.fix.host",
    message:
      'Run uvx opensandbox-server --config ~/.sandbox.toml listening on {server}, with [egress] mode = "dns+nft".',
  }),
  "check.host.elsewhere": msg({
    id: "check.host.elsewhere",
    message: "docker, uv and the egress image belong to the machine running the sandbox server, not to this one",
  }),
  "check.host.fix": msg({
    id: "check.host.fix",
    message: "On that machine: install docker, run uvx opensandbox-server, and docker pull opensandbox/egress:v1.1.6.",
  }),
  "check.serverAuth.open": msg({
    id: "check.serverAuth.open",
    message: "the server asks for no API key, so any process on this machine can enter a container",
  }),
  "check.serverAuth.fix": msg({
    id: "check.serverAuth.fix",
    message:
      'Set [server] api_key = "…" in the server\'s TOML, restart it, then Settings → Sandbox server → Read from server. The containers hold the checkout, the mailbox token and the CLI logins.',
  }),
  "check.egress.none": msg({ id: "check.egress.none", message: "no opensandbox/egress image pulled" }),
  "check.egress.stale": msg({ id: "check.egress.stale", message: "only {stale}, which is too old" }),
  "check.egress.mixed": msg({ id: "check.egress.mixed", message: "{good} (also has {stale} — check [egress] image)" }),
  "check.egress.ok": msg({ id: "check.egress.ok", message: "{good}" }),
  "check.egress.fix": msg({
    id: "check.egress.fix",
    message:
      "Run docker pull opensandbox/egress:v1.1.6, then point [egress] image at it. v1.1.4 403s every scoped package as soon as a credential is bound.",
  }),
  "check.image.absent": msg({ id: "check.image.absent", message: "{image} is not on this machine" }),
  "check.image.fix": msg({
    id: "check.image.fix",
    message:
      "Run docker build -f docker/agent.Dockerfile -t {image} . — an image with no registry prefix can only be built locally.",
  }),
  "check.skills.staged": msg({ id: "check.skills.staged", message: "{count} staged at {path}" }),
  "check.skills.none": msg({ id: "check.skills.none", message: "no skills ticked" }),
  "check.skills.fix.contained": msg({
    id: "check.skills.fix.contained",
    message:
      "{path} is a path inside this container, and the mount is made by the sandbox server's docker, which resolves it on its own filesystem. Use one absolute path on both sides (-v <host path>:{path}) and add it to the sandbox server's allowed_host_paths. A mismatch does not fail; it mounts an empty directory.",
  }),
  "check.skills.fix.host": msg({
    id: "check.skills.fix.host",
    message:
      "Add {path} to the sandbox server's allowed_host_paths, or every group fails to open a container. Tick the skills in Settings.",
  }),
  "check.paths.noConfig": msg({
    id: "check.paths.noConfig",
    message: "no opensandbox-server config file found, so there is nothing to check against",
  }),
  "check.paths.missing": msg({ id: "check.paths.missing", message: "{config} does not list {missing}" }),
  "check.paths.covered": msg({ id: "check.paths.covered", message: "{config} covers all {count} paths to be mounted" }),
  "check.paths.fix": msg({
    id: "check.paths.fix",
    message:
      "Put this line in the [sandbox] section of {config}, then restart opensandbox-server: allowed_host_paths = [{line}]",
  }),
  "check.cred.absent": msg({ id: "check.cred.absent", message: "not configured" }),
  "check.cred.accepted": msg({ id: "check.cred.accepted", message: "{mode} · accepted" }),
  "check.cred.rejected": msg({ id: "check.cred.rejected", message: "{mode} · the provider rejected this credential" }),
  "check.cred.unverified": msg({ id: "check.cred.unverified", message: "{mode} · not verified (HTTP {status})" }),
  "check.cred.unreachable": msg({ id: "check.cred.unreachable", message: "{mode} · unreachable, not verified" }),
  "check.cred.githubRejected": msg({
    id: "check.cred.githubRejected",
    message: "{mode} · GitHub no longer accepts this token",
  }),
  "check.cred.stored": msg({ id: "check.cred.stored", message: "{mode} · stored" }),
  "check.cred.expired": msg({ id: "check.cred.expired", message: "{mode} · expired — sign in again" }),
  "check.cred.daysLeft": msg({ id: "check.cred.daysLeft", message: "{mode} · {days} days left" }),
  "check.cred.expiringToday": msg({ id: "check.cred.expiringToday", message: "{mode} · expires within a day" }),
  "check.cred.fix.claude": msg({
    id: "check.cred.fix.claude",
    message:
      "Settings → Claude → sign in. It runs the official claude setup-token inside the utility container, so nothing is installed here; paste the code that page gives you back into the input and it is stored. Good for a year.",
  }),
  "check.cred.fix.github": msg({
    id: "check.cred.fix.github",
    message:
      "Connect GitHub once in Settings. Branches are pushed with it — without one, every slice is refused at its last step.",
  }),
  "check.cred.fix.codex": msg({
    id: "check.cred.fix.codex",
    message:
      "Settings → codex → sign in, which runs the official device-code flow; codex is not installed here. Pasting an API key works too.",
  }),
  "check.codex.stale": msg({
    id: "check.codex.stale",
    message:
      "this ChatGPT login is old enough to need renewing — the next container renews it, and if that keeps failing the auth.json has to be pasted again",
  }),
  "check.codex.fresh": msg({
    id: "check.codex.fresh",
    message: "the login is fresh; renewal runs inside the utility container, so codex is not needed here",
  }),
  "check.codex.fix": msg({
    id: "check.codex.fix",
    message:
      "Renewal runs the real codex inside the utility container. If it keeps failing, paste ~/.codex/auth.json again in Settings, or switch to an API key — an API key never needs renewing.",
  }),
};

/**
 * The sentence this build declares, in the reader's language.
 *
 * `values` on the descriptor is Lingui's own fallback path: the catalogue's
 * translation when the locale has one, the `message` beside the id when it does
 * not — which is every row under English, since English loads no catalogue
 * (`web/src/i18n.ts`).
 */
/**
 * `english` is the other case: an id this build has never heard of, from a
 * server newer than it. That is what keeps adding a check non-breaking.
 */
export function checkText(said: Said | undefined, english: string): string {
  const descriptor = said && CHECKS[said.id];
  if (!descriptor || !said) return english;
  // Spread only when there are arguments: `exactOptionalPropertyTypes` refuses
  // an explicit `values: undefined` on a descriptor whose `values` is optional.
  return i18n._(said.values ? { ...descriptor, values: said.values } : descriptor);
}
