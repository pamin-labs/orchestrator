import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { z } from "zod";
import { SaidSchema } from "../../../src/contracts/said.ts";
import { i18n } from "../i18n";

/**
 * Every sentence the orchestrator says about its own work, declared once.
 *
 * This file is the only author. `lingui extract` puts these ids straight into
 * the ten `.po` files, `scripts/i18n-messages.ts` folds the `ev.` ones back into
 * `src/platform/text/messages.generated.ts`, and the server renders from that.
 * It lives under `web/src` on purpose: invariant 4 forbids `src/mech` importing
 * a web module, so nobody can drag the babel macro into the server runtime.
 */
/**
 * Explicit ids, not hashed — the server has to name these over the wire, and a
 * hash is not a name anything else can hold. The cost is that `.po` loses the
 * English `msgid` a translator reads; it comes back as `en.po`'s `msgstr`,
 * which `lingui extract` fills for an explicit id (measured).
 */
/**
 * Rendered through the descriptor, never `i18n._(id, values)`.
 *
 * `web/src/i18n.ts` loads `{}` for English on purpose: ADR 041's hashed ids fall
 * back to the macro's `message`, which is why an English reader fetches no
 * catalog at all. An explicit id has no such fallback — measured,
 * `i18n._("ev.group.merged")` renders the string `ev.group.merged`, to every
 * English reader, for every message. The descriptor carries `message`, so going
 * through it keeps English free instead of buying it a catalog chunk.
 */
const M: Record<string, MessageDescriptor> = {
  "ev.slice.ready": msg({ id: "ev.slice.ready", message: 'S{seq} "{title}" is ready for you' }),
  "ev.slice.accepted": msg({ id: "ev.slice.accepted", message: "accepted: S{seq} {title}" }),
  "ev.slice.accepted_why": msg({ id: "ev.slice.accepted_why", message: "accepted: S{seq} {title} ({why})" }),
  "ev.slice.sentback": msg({ id: "ev.slice.sentback", message: "S{seq} sent back by {from} (attempt {n})" }),
  "ev.slice.failed": msg({
    id: "ev.slice.failed",
    message: "S{seq} failed {from} {n}x — probably the acceptance criteria, not the code",
  }),
  "ev.slice.autoaccept": msg({ id: "ev.slice.autoaccept", message: "{tier} auto-accepted, all three gates passed" }),
  "ev.gate.pass": msg({ id: "ev.gate.pass", message: "gate pass on S{seq}" }),
  "ev.gate.fail": msg({ id: "ev.gate.fail", message: "gate fail on S{seq}" }),
  "ev.gate.reconcile": msg({ id: "ev.gate.reconcile", message: "reconcile failed on S{seq}: {reason}" }),
  "ev.gate.unclaimed": msg({ id: "ev.gate.unclaimed", message: "also changed on S{seq}, unclaimed: {files}" }),
  "ev.group.worktree": msg({ id: "ev.group.worktree", message: "checkout on {branch}" }),
  "ev.group.approved": msg({ id: "ev.group.approved", message: "DRAFT approved" }),
  "ev.group.approve_held": msg({
    id: "ev.group.approve_held",
    message: "approval recorded — held by the boundary: {why}. Starts by itself once that clears",
  }),
  "ev.group.blocked": msg({
    id: "ev.group.blocked",
    message: "blocked by {path}; handed to grp {target} and waiting for it to land",
  }),
  "ev.group.unblocked": msg({ id: "ev.group.unblocked", message: "grp {target} landed; resuming by itself" }),
  "ev.group.dropped": msg({ id: "ev.group.dropped", message: "dropped by the boss" }),
  "ev.group.dropped_why": msg({ id: "ev.group.dropped_why", message: "dropped by the boss: {why}" }),
  "ev.group.merged": msg({ id: "ev.group.merged", message: "merged into main" }),
  "ev.group.paused": msg({ id: "ev.group.paused", message: "PAUSED" }),
  "ev.group.parked": msg({ id: "ev.group.parked", message: "parked: {why}. checkout and checkpoint kept" }),
  "ev.sandbox.rebuild": msg({
    id: "ev.sandbox.rebuild",
    message: "container discarded; the next turn rebuilds it — clone and install. The branch lives in the host repo",
  }),
  "ev.group.resumed": msg({ id: "ev.group.resumed", message: "resumed" }),
  "ev.group.autoadvance": msg({
    id: "ev.group.autoadvance",
    message: "autoAdvance: started the next slice without waiting for you",
  }),
  "ev.pr.opened": msg({ id: "ev.pr.opened", message: "PR #{n} opened" }),
  "ev.pr.queued": msg({ id: "ev.pr.queued", message: "joined the merge queue at position {n}" }),
  "ev.wd.unparked": msg({ id: "ev.wd.unparked", message: "{name} is no longer waiting on anything — woken up" }),
  "ev.wd.stalled": msg({
    id: "ev.wd.stalled",
    message: "group is RUNNING with an empty queue, and one re-queue did not revive it. Last failure: {why}",
  }),
  "ev.wd.turn_timeout": msg({ id: "ev.wd.turn_timeout", message: "turn ran past {min} min and was killed" }),
  "ev.wd.no_progress": msg({
    id: "ev.wd.no_progress",
    message: "{role} finished {n, plural, one {# turn} other {# turns}} without changing a file, a task or a note",
  }),
  "ev.wd.circling": msg({
    id: "ev.wd.circling",
    message:
      "{role} has rewritten {file} {n, plural, one {# turn} other {# turns}} running — probably a design problem, sending it to the Architect",
  }),
  "ev.wd.env_suspect": msg({
    id: "ev.wd.env_suspect",
    message: "{resource} failed {n}x with no code change in between — treat the environment as the suspect",
  }),
  "ev.wd.budget_exhausted": msg({
    id: "ev.wd.budget_exhausted",
    message: "{name} spent its whole budget ({tokens} tokens) and is suspended",
  }),
  "ev.wd.budget_80": msg({ id: "ev.wd.budget_80", message: "{name} is at {pct}% of its budget" }),
  "ev.wd.parked": msg({
    id: "ev.wd.parked",
    message: "{name} parked after waiting {min} min — checkout kept, slot freed",
  }),
  "ev.wd.waiting_on_you": msg({ id: "ev.wd.waiting_on_you", message: "{name} has been waiting {min} min for you" }),
  "ev.wd.unshipped": msg({
    id: "ev.wd.unshipped",
    message: "{name} has every slice accepted, no PR and an empty queue — re-running the branch review",
  }),
  "ev.rl.waiting": msg({
    id: "ev.rl.waiting",
    message:
      "rate limited; everything on this CLI holds until the window reopens (~{at}) and resumes itself — the quota belongs to the account, so no model spends less of it",
  }),
  "ev.rl.resumed": msg({ id: "ev.rl.resumed", message: "quota is back, resuming" }),
  "ev.net.lost": msg({
    id: "ev.net.lost",
    message:
      "the host lost its network; {n, plural, one {# turn} other {# turns}} held and re-queued, requirements left running",
  }),
  "ev.net.back": msg({ id: "ev.net.back", message: "network is back, held work resumes" }),
  "ev.repo.held": msg({
    id: "ev.repo.held",
    message:
      "GitHub no longer accepts this login, so every turn on {repo} is held — retrying cannot help. Reconnect GitHub in settings and they resume on their own. Other projects are unaffected.",
  }),
  "ev.owns.reverted": msg({
    id: "ev.owns.reverted",
    message:
      "{role} wrote {n, plural, one {# file} other {# files}} this group does not own ({files}) — reverted; this CLI's sandbox cannot stop the write, so the check runs after it",
  }),
  "ev.unread.digest": msg({ id: "ev.unread.digest", message: "{n} unread — the Librarian is compressing them" }),
  "ev.sediment": msg({
    id: "ev.sediment",
    message:
      "the same feedback for the {n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}} time; asking the CoS to make it a project rule",
  }),
  "ev.hired": msg({ id: "ev.hired", message: "hired {role}" }),
  "ev.boss.reject_slice": msg({ id: "ev.boss.reject_slice", message: "rejected the slice" }),
  "ev.wd.waiting_card": msg({
    id: "ev.wd.waiting_card",
    message: "{name}'s plan card has been waiting {hours}h for you",
  }),
  "ev.wd.waiting_slice": msg({ id: "ev.wd.waiting_slice", message: "{name} S{seq} has been waiting {hours}h for you" }),
  "ev.wd.waiting_merge": msg({
    id: "ev.wd.waiting_merge",
    message: "{name}'s PR has been at the head of the merge queue for {hours}h",
  }),
  "ev.wd.waiting_merge_blocked": msg({
    id: "ev.wd.waiting_merge_blocked",
    message: "{name}'s PR has been at the head of the merge queue for {hours}h, with {n} behind it",
  }),
  "ev.wd.broke": msg({
    id: "ev.wd.broke",
    message:
      "the watchdog threw this tick and the rules after it did not run: {why}\nIt retries every 30s, but until it is fixed everything it drives — stalled groups, expired sandboxes, the rebase after a base moves, the clocks on what is waiting for you — stays where it is.",
  }),
  "ev.wd.rule_broke": msg({
    id: "ev.wd.rule_broke",
    message: "watchdog rule {rule} ({ruleName}) threw; the rest of the tick ran: {why}",
  }),
  "ev.wd.map_stale": msg({
    id: "ev.wd.map_stale",
    message:
      "the repo map is stuck on its last version: {repo}'s container cannot read HEAD, and a rebuild would only produce a map with no symbols in it",
  }),
  "ev.wd.map_failed": msg({ id: "ev.wd.map_failed", message: "the repo map cannot be refreshed: {repo} — {why}" }),
  "ev.wd.map_no_remote": msg({
    id: "ev.wd.map_no_remote",
    message: "this project has no remote recorded, so there is nothing to mirror",
  }),
  "ev.wd.map_no_reason": msg({ id: "ev.wd.map_no_reason", message: "no reason given, which is itself a bug" }),
  "ev.wd.base_moved": msg({
    id: "ev.wd.base_moved",
    message: "{base} moved to {sha}; {name} is behind it and has been told to rebase first",
  }),
  "ev.wd.waiting_parked": msg({
    id: "ev.wd.waiting_parked",
    message: "{name} has been parked {hours}h — wake it, or drop it?",
  }),
  "ev.wd.sandbox_swept": msg({ id: "ev.wd.sandbox_swept", message: "{name} dissolved; its sandbox is reclaimed" }),
  "ev.wd.sandbox_stale_cred": msg({
    id: "ev.wd.sandbox_stale_cred",
    message: "{name}'s sandbox is bound to a superseded credential; reclaimed, and the next tick rebuilds it",
  }),
  "ev.wd.server_gone": msg({
    id: "ev.wd.server_gone",
    message:
      "opensandbox-server will not start; {n, plural, one {# attempt} other {# attempts}} and no more automatic retries. Run it by hand to see what it says: {cmd}",
  }),
  "ev.wd.server_restart_failed": msg({
    id: "ev.wd.server_restart_failed",
    message: "opensandbox-server was gone and the restart failed (attempt {n}): {why}",
  }),
  "ev.wd.server_restarted": msg({
    id: "ev.wd.server_restarted",
    message: "opensandbox-server was gone and has been restarted (attempt {n}). Held work resumes by itself.",
  }),
  "ev.wd.stale_ask": msg({
    id: "ev.wd.stale_ask",
    message: "{name} reached PR, so the question still hanging on it expired — closed by itself",
  }),
  "ev.notify.batch": msg({
    id: "ev.notify.batch",
    message: "{n, plural, one {# thing needs} other {# things need}} you:",
  }),
  "ev.sandbox.server_bounced": msg({
    id: "ev.sandbox.server_bounced",
    message: "the sandbox server was restarted, so every container it held is gone",
  }),
  "ev.sandbox.server_up": msg({ id: "ev.sandbox.server_up", message: "the sandbox server is up (pid {pid})" }),
  "ev.sandbox.server_was_up": msg({
    id: "ev.sandbox.server_was_up",
    message: "the sandbox server was already running, so this used the one that was there",
  }),
  "ev.sandbox.server_started_by_us": msg({
    id: "ev.sandbox.server_started_by_us",
    message: "the sandbox server is up — we started it (pid {pid})",
  }),
  "ev.sandbox.server_undrivable": msg({
    id: "ev.sandbox.server_undrivable",
    message:
      "the sandbox server is running (pid {pid}) but we cannot drive it: {why}\nIt was left alone rather than restarted, because that process may be yours and pointed at something else. Settings \u2192 Sandbox server has the button.",
  }),
};

const MetaSchema = z.object({ say: SaidSchema.optional() });

/**
 * What the server said, in the language this browser reads.
 *
 * The id if there is one, the stored body if there is not. Every row written
 * before `meta.say` existed has only a body, and `state_change` — the largest
 * kind by emitters — is trimmed at seven days rather than migrated, so the
 * fallback is the migration. An id this build has no descriptor for takes the
 * same path, which is what makes adding one on the server a change that cannot
 * break a panel deployed before it.
 */
export function sayText(meta: unknown, body: string): string {
  const parsed = MetaSchema.safeParse(meta);
  if (!parsed.success || !parsed.data.say) return body;
  const said = parsed.data.say;
  const descriptor = M[said.id];
  if (!descriptor) return body;
  // Spread only when there are values: `exactOptionalPropertyTypes` refuses an
  // explicit `values: undefined` on a descriptor whose `values` is optional.
  return i18n._(said.values ? { ...descriptor, values: said.values } : descriptor);
}
