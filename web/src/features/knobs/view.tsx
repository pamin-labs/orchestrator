import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { api, mutate, readApi } from "../../shared/api";
import { KNOB_SHAPE, WANTS, readNumber, showNumber } from "./units";
import type { ModelSources } from "./models";
import {
  Amount,
  DurationAmount,
  Box,
  Embedding,
  Caps,
  CountAmount,
  IndexModel,
  LANGUAGE_SUGGESTIONS,
  Ladder,
  Lines,
  ModelTable,
  PERCENT,
  Pairs,
  Permission,
  Windows,
} from "./editors";
import {
  type Complaint,
  type Editor,
  type Knob,
  NO_COMPLAINT,
  type PairKind,
  TABLES,
  TIERS,
  badCell,
  durationScale,
  invalidFlag,
  labelledBy,
  mateValue,
  rec,
  rowChanged,
  selfNamed,
  textOf,
} from "./model";
import { Combobox } from "../../ui/combobox";
import { Field, FieldContent, FieldGroup, FieldLabel, FieldLegend, FieldSet, FieldTitle } from "../../ui/field";
import { cn } from "../../ui/cn";
import { Empty, Head, Meta, Working } from "../../ui/bits";
import { Button } from "../../ui/button";
import { Segment, Toggles } from "../../ui/segment";
import { Switch } from "../../ui/switch";
import { Help, Tip } from "../../ui/tooltip";
import { z } from "zod";
import type { Json } from "../../../../src/contracts/json";
import {
  ConfigSchema,
  endonymOf,
  localeOf,
  SettingWriteSchema,
  type SettingWrite,
} from "../../../../src/contracts/config";
import type { InferResponseType } from "hono/client";
import { Trans } from "@lingui/react/macro";
import { t } from "@lingui/core/macro";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { i18n } from "../../i18n";

/**
 * The operating knobs, as rows.
 *
 * Every number here is a measurement someone paid for, so each row carries its
 * reason as a `?`. The server sends value, default and whether it was overridden;
 * the labels and the reasons live here, because they are copy.
 *
 * A value is shown in the unit it means, a table-shaped value gets a table rather
 * than a line of JSON, and a refusal is drawn where the value is.
 */

const RawKnobSchema = z.object({
  path: z.string(),
  type: z.string(),
  value: z.json(),
  default: z.json(),
  overridden: z.boolean(),
});
type SettingsResponse = InferResponseType<typeof api.settings.$get, 200>;
const KnobSchema = z.custom<Knob>((value) => {
  const row = RawKnobSchema.safeParse(value);
  return (
    row.success &&
    SettingWriteSchema.safeParse({ path: row.data.path, value: row.data.value }).success &&
    SettingWriteSchema.safeParse({ path: row.data.path, value: row.data.default }).success
  );
});
const SettingsResponseSchema: z.ZodType<SettingsResponse> = z.object({ settings: z.array(KnobSchema) });

/** Every knob pane, as the values themselves: a caller that walks them all —
 *  the render check does — should not have to assert its way back to the type. */
export const KNOB_SECTIONS = ["ops", "models", "internals", "notify", "boxdefaults", "repo"] as const;
export type KnobSection = (typeof KNOB_SECTIONS)[number];

/**
 * Knobs a section deliberately does not draw, because another control owns them.
 *
 * Exported so the coverage check can tell "owned elsewhere" from "forgotten" —
 * the second is what put thirteen keys on the API and nowhere on the page.
 */
/**
 * `sandbox.server` and `sandbox.image` belong to the 沙箱 pane, which validates an
 * address and lists what the registry actually holds.
 *
 * `embedding.model` and `indexModel.model` belong to the `PAIRED` row their
 * runtime is picked on: that row already draws the model as a picker offering
 * only what the chosen runtime can run, and a second row for the same value was
 * a free-text box holding the same string one line below it.
 */
/**
 * `embedding.endpoint` and `embedding.credential` joined them: they were two
 * empty boxes under a segment reading 本地, which is a form for a mode nobody
 * had chosen. The embedding row draws them when remote is pressed.
 */
export const KNOBS_ELSEWHERE = new Set([
  "sandbox.server",
  "sandbox.image",
  "embedding.model",
  "indexModel.model",
  "embedding.endpoint",
  "embedding.credential",
]);

/**
 * A run of rows under one subject. The first group of a section is the section's
 * own subject and carries no legend — `Head` has already named it — while a later
 * group names itself, because eighteen rows in one undivided list is a list whose
 * bottom half nobody reads.
 */
export interface KnobGroup {
  legend?: MessageDescriptor;
  paths: string[];
}

/**
 * `msg` at module scope, `i18n._` at call scope. A descriptor is locale-free
 * data, so a table built once at import is still right after the locale changes
 * — which a resolved string would not be: it freezes at first evaluation.
 */
export const SECTIONS: Record<KnobSection, { title: MessageDescriptor; note: MessageDescriptor; groups: KnobGroup[] }> =
  {
    ops: {
      title: msg`How agents run`,
      // Three groups, one subject: how hard the fleet is pushed, what one turn is
      // allowed, and when to decide it is stuck. They were 调度 and 轮次与上下文,
      // two panes apart — with `leaseTimeoutMs` in the first and `turnTimeoutMs`
      // in the second, both answering "how long may one piece of agent work
      // take", and a comment in each explaining why it was not next to the
      // other.
      note: msg`How hard the fleet is pushed, and when to stop waiting on it`,
      groups: [
        {
          paths: [
            "maxGroups",
            "leaseSlots",
            // Beside the slots they hold and the retries they feed, not under
            // 轮次与上下文: a lease is a compile, and neither number bounds a turn.
            "leaseTimeoutMs",
            "installTimeoutMs",
            "gateRetries",
            "autoAdvance",
            "autoAcceptTiers",
            "parkAfterPausedMs",
          ],
        },
        {
          legend: msg`One turn`,
          paths: [
            "turnTimeoutMs",
            "maxTurnsPerJob",
            "sessionRotateFraction",
            "ctxBudgetChars",
            "unreadDigestThreshold",
            "feedbackSedimentThreshold",
          ],
        },
        {
          // The interval was settable and every threshold it enforces was not, so
          // the one knob on the page changed how often the rules ran and nothing
          // about what they decided. They are one subject and they read as one.
          legend: msg`Watchdog`,
          paths: [
            "watchdogIntervalMs",
            "watchdog.idleTurns",
            "watchdog.sameFile",
            "watchdog.reemitMs",
            "watchdog.nudgeAfterMs",
            "watchdog.nudgeReemitMs",
            "watchdog.pausedNotifyMs",
            "watchdog.repoMapEveryMs",
          ],
        },
      ],
    },
    models: {
      title: msg`Models & budget`,
      note: msg`Which model runs what, and what it may spend`,
      groups: [
        { paths: ["difficultyModel", "sliceBudgetTokens", "contextWindow", "indexModel.runtime", "language"] },
        {
          // How `orch ctx query` finds anything. Its own group because it is the
          // one block on this pane that is not about spend at all, and because
          // the two halves — the tree walk and the vectors — are read together.
          legend: msg`Retrieval`,
          paths: ["pageindex.enabled", "pageindex.depth", "pageindex.width", "embedding.mode"],
        },
      ],
    },
    internals: {
      title: msg`Plumbing`,
      // Everything in the first two groups bounds a wait on something outside this
      // process: GitHub, a container, the network. They were eighteen literals
      // across seven files, and the only ones anybody could change were the three
      // turn budgets. The third group is this machine's own plumbing, which sat
      // under 轮次与上下文 where it was neither a turn nor a context.
      // Named for when you come here rather than for what it holds: nothing on
      // this pane changes what the fleet decides, only how patiently it waits and
      // how much it keeps. The three groups were split across 调度 and
      // 等待与存储 on a naming axis — a poll size is not a wait — where the axis
      // that actually separates them is whether anybody ever touches them.
      note: msg`Timeouts, polling and retention. Come here when something is broken`,
      groups: [
        {
          legend: msg`Timeouts`,
          paths: [
            "timeouts.githubApiMs",
            "timeouts.credentialCheckMs",
            "timeouts.sandboxPingMs",
            "timeouts.networkPingMs",
            "timeouts.tokenRefreshMs",
            "timeouts.usageReadMs",
            "timeouts.transferMs",
          ],
        },
        {
          legend: msg`Polling intervals`,
          paths: [
            "intervals.recheckMs",
            "intervals.usagePollMs",
            "intervals.usageBackoffMs",
            // A page size, not a wait — which is why it never fitted under
            // 调度 either. What it bounds is how much of GitHub one poll reads.
            "prPoll.prs",
            "prPoll.messages",
            "prPoll.checks",
            "prPoll.threads",
            "prPoll.threadComments",
          ],
        },
        {
          legend: msg`Storage & streams`,
          paths: ["dbPoolSize", "eventRetentionMs", "streamBacklog", "telemetryCacheMs"],
        },
      ],
    },
    repo: {
      title: msg`Repositories`,
      note: msg`How a checkout is read when GitHub cannot be asked`,
      // Under 拉取请求 until somebody read its own tooltip: this is tried when a
      // project has no base branch of its own *and* the remote cannot be reached
      // to supply `default_branch`. That is a fact about a checkout, and the last
      // place it applies is a pull request — which is why it renders under
      // GitHub, where the reader is already looking at repositories.
      groups: [{ paths: ["baseBranchFallbacks"] }],
    },
    notify: {
      title: msg`Notifications`,
      note: msg`How to alert you`,
      groups: [
        { paths: ["notifyWebhook", "timeouts.webhookMs", "intervals.notifyBatchMs", "intervals.notifyBackoffMs"] },
      ],
    },
    boxdefaults: {
      title: msg`Sandbox defaults`,
      note: msg`Used when a project has not set its own`,
      // Not `sandbox.server` or `sandbox.image`: the pane this section renders
      // inside owns both, with an address row that validates and an image row that
      // lists what the registry has. A knob row for the image is a plain text box,
      // which is how "the image dropdown disappeared" happened — two controls for
      // one value, and the reader found the other one.
      groups: [
        {
          // `skillsDir` is here rather than under 轮次与上下文 because it is the
          // same fact as `sandbox.cacheDirs`: a host directory mounted into every
          // container, which fails the same way when the sandbox server's
          // allowed_host_paths does not list it.
          paths: [
            "sandbox.cpu",
            "sandbox.memory",
            "sandbox.ttlSeconds",
            "sandbox.denyDomains",
            "sandbox.cacheDirs",
            "skillsDir",
          ],
        },
      ],
    },
  };

/**
 * Label, the reason the default is what it is, and what an empty box would mean.
 *
 * The reasons are verbatim from the yaml this replaced. The labels are short on
 * purpose: they share one column with every other row on the page, and a label
 * that wraps to three lines pushes its own value out of line with the value
 * above it, which is the whole reason the values are in a column.
 */
/** `ph` is either — `8Gi` and `127.0.0.1:8080` are examples of the value and
 *  stay verbatim, while "Empty = 1/4 of host cores" is a sentence. */
export const COPY: Record<
  string,
  { label: MessageDescriptor; why?: MessageDescriptor; ph?: MessageDescriptor | string }
> = {
  maxGroups: {
    label: msg`Concurrent jobs`,
    why: msg`Requirements running at once. You will usually hit a different ceiling first: two groups cannot own overlapping paths, and one account has its own rate limit. Raising it, watch the cache hit rate on the cost page.`,
  },
  leaseSlots: {
    label: msg`Gate concurrency`,
    why: msg`How many gates may run at once. A lease is a real compile or test run, so ten concurrent will trash the machine. Browser is capped at 1 on its own: each one is a real Chromium.`,
  },
  watchdogIntervalMs: {
    label: msg`Watchdog interval`,
    why: msg`How often deterministic rules run. Also how long queued work waits without an explicit tick before dispatch.`,
  },
  autoAdvance: {
    label: msg`Auto-advance when approved`,
    why: msg`On, a group starts the next slice without waiting for you. Off, it finishes one and stops. The cost: later slices build on an earlier one, so reverting it pauses the whole group.`,
  },
  autoAcceptTiers: {
    label: msg`Auto-accept tiers`,
    why: msg`Which tiers skip your final look after passing all four gates. Trivial and normal by default; hard still waits for you.`,
  },
  parkAfterPausedMs: {
    label: msg`Archive after paused`,
    why: msg`Archive releases the sandbox. Groups parked too long hog concurrency slots for nothing.`,
  },
  "watchdog.idleTurns": {
    label: msg`Turns without progress`,
    why: msg`Turns in a row that changed nothing before the watchdog calls it stuck. Below three it fires on an agent that is still reading; far above it, a loop runs all afternoon unnoticed.`,
  },
  "watchdog.sameFile": {
    label: msg`Edits to one file`,
    why: msg`The other half of stuck: the same file rewritten this many times running. An agent converging touches its neighbours; an agent stuck rewrites one file until the budget is gone.`,
  },
  "watchdog.reemitMs": {
    label: msg`Repeat a stuck notice`,
    why: msg`How long before the same stuck report is worth saying again. Shorter turns one stuck group into a feed of its own.`,
  },
  "watchdog.nudgeAfterMs": {
    label: msg`Nudge a silent group`,
    why: msg`Silence this long and the group is asked what it is doing. Not a failure — a long compile is silent too — so this is hours rather than minutes.`,
  },
  "watchdog.nudgeReemitMs": {
    label: msg`Repeat the nudge`,
    why: msg`How long before a group that answered nothing is nudged again. Longer than the first wait, or the nudge becomes the noise it was meant to cut through.`,
  },
  "watchdog.pausedNotifyMs": {
    label: msg`Remind about paused`,
    why: msg`A paused group is waiting on you and costs a concurrency slot while it waits. This is how often it says so before 'Archive after paused' takes the slot back.`,
  },
  "watchdog.repoMapEveryMs": {
    label: msg`Recheck the repo map`,
    why: msg`How often the shared repository map is re-checked. Deliberately far longer than the watchdog tick: the map only changes on a push, and checking costs a container round trip.`,
  },
  baseBranchFallbacks: {
    label: msg`Base branch fallbacks`,
    ph: msg`One branch name per line, most likely first`,
    why: msg`Tried in order, and only when nothing else answered: a project's own base branch wins, then GitHub's default_branch. This is what a repository falls back to when its remote cannot be reached.`,
  },
  "prPoll.prs": {
    label: msg`Pull requests per poll`,
    why: msg`How many open pull requests one poll asks GitHub about. Node counts are what a GraphQL query costs, so every number in this group is a ceiling bought with quota.`,
  },
  "prPoll.messages": {
    label: msg`Conversation comments`,
    why: msg`Comments on the pull request itself, newest first. Past this, the oldest are never read — which is a reviewer's first comment going unanswered.`,
  },
  "prPoll.checks": {
    label: msg`Check runs`,
    why: msg`One CI run can post fifty of these. Set below what your workflow produces and the fleet decides a pull request is green while a check it never saw is red.`,
  },
  "prPoll.threads": {
    label: msg`Review threads`,
    why: msg`Line-level review threads read per pull request. Set it below what the repository actually produces and the oldest threads are never seen.`,
  },
  "prPoll.threadComments": {
    label: msg`Replies per thread`,
    why: msg`How far down one review thread the poll reads. A long argument in a thread is the case this truncates.`,
  },
  difficultyModel: {
    label: msg`Difficulty → Model`,
    why: msg`Which model handles each difficulty, per CLI. Which role uses which CLI is in roles/*.yaml. Only affects newly hired agents — a model is frozen at hire time.`,
  },
  "embedding.mode": {
    label: msg`Embedding mode`,
    why: msg`Local runs on this machine; remote sends text to an endpoint you choose. Neither is used for retrieval yet — measured, cross-language search was worse than the keyword search it would replace. Remote means your requirements and acceptance criteria leave this machine, so local is the default and remote is a decision.`,
  },
  "embedding.endpoint": {
    label: msg`Remote endpoint`,
    why: msg`Full /v1/embeddings address, OpenAI-shaped. Write full, not just hostname—which path a provider uses is pure guesswork. Used only when mode is remote.`,
  },
  "embedding.credential": {
    label: msg`Remote credential name`,
    why: msg`The name of that line in 'Model account', not the key itself. Key in config is key in shell history and every backup.`,
  },
  "pageindex.enabled": {
    label: msg`Walk the index tree`,
    why: msg`On, a question walks the index tree before it is answered — one model call. Off skips the walk entirely and falls through to keyword search, which is the comparison this switch is for.`,
  },
  "pageindex.depth": {
    label: msg`Walk depth`,
    why: msg`Levels of the tree one question may descend, and each level is a serial model call with its own 60s timeout — two per question at 3. This is the single knob on the most frequent model spend here.`,
  },
  "pageindex.width": {
    label: msg`Walk width`,
    why: msg`How many nodes the model may name at one level. Width costs tokens in a single call, where depth costs another call.`,
  },
  "indexModel.runtime": {
    label: msg`Index model`,
    why: msg`The single most-called model call across the whole system: pure summarization, no decision-making, no tools, no blackboard. First thing to move off a premium subscription.`,
  },
  contextWindow: {
    label: msg`Context window`,
    why: msg`Assumed context window per model, used for the first turn of a session — after that the CLI reports the real number. Set it too low and a large-context model restarts constantly, throwing away its cache each time.`,
  },
  sliceBudgetTokens: {
    label: msg`Token limit per slice`,
    why: msg`Token ceiling for one slice. Set it above your worst finished slice and below the outliers — it exists to stop an agent that is lost, not to trim a slow day. New slices only.`,
  },
  language: {
    label: msg`Output language`,
    why: msg`What the agents write in. Code, commits, branches, PRs and errors stay English. Changing it restarts every session.`,
  },
  turnTimeoutMs: {
    label: msg`Turn timeout`,
    why: msg`Exceeded, watchdog kills it. Real max single-turn was 8.2 minutes.`,
  },
  maxTurnsPerJob: {
    label: msg`Max steps per turn`,
    why: msg`Steps one turn may take before it is cut off. Most turns finish in about 36; the long tail is an agent lost rather than working, and it costs the most because every step re-reads the transcript. Changing it restarts every session.`,
  },
  sessionRotateFraction: {
    label: msg`Session rotation threshold`,
    why: msg`Swap sessions when context hits this much of the window. Fallback trigger; real rotation is slice-end—clean semantic boundary, cheap handoff.`,
  },
  ctxBudgetChars: {
    label: msg`Context response limit`,
    why: msg`Roughly 4k token. This answer lands in the transcript, and every remaining turn in the session re-reads it—so a generous answer keeps billing long after the question is answered.`,
  },
  unreadDigestThreshold: {
    label: msg`Unread digest threshold`,
    why: msg`Max channel messages to cram into one delta per turn.`,
  },
  feedbackSedimentThreshold: {
    label: msg`Feedback threshold to become a rule`,
    why: msg`When the same thing surfaces N times, it should be a project rule, not the N+1-th complaint.`,
  },
  gateRetries: {
    label: msg`Gate retries`,
    why: msg`After a slice fails several times straight, escalate to a person instead of retrying the same path.`,
  },
  leaseTimeoutMs: {
    label: msg`Lease timeout`,
    why: msg`Big projects compile for hours; no ceiling means one hung build occupies a lease slot forever, slots are global and scarce—one dead command halts the whole fleet's gates.`,
  },
  installTimeoutMs: {
    label: msg`Install timeout`,
    why: msg`Same magnitude as lease, same category—real compilation. Too tight fails like 'this project is broken' not 'timeout', and groups get stuck either way.`,
  },
  "timeouts.githubApiMs": {
    label: msg`GitHub API call`,
    why: msg`One REST call whose answer is work somebody asked for—opening a pull request, reading a review. Longer than the credential check below because something is blocked on it.`,
  },
  "timeouts.credentialCheckMs": {
    label: msg`Credential check`,
    why: msg`'Do you still accept this credential': GitHub's /user, a provider's /v1/models. Short because a slow answer reports 'not verified' rather than failing, and nothing waits on it.`,
  },
  "timeouts.sandboxPingMs": {
    label: msg`Sandbox server ping`,
    why: msg`Is the sandbox server up, and does it take our key. Usually loopback, and its answer only fills in a report—where the network ping below gates the whole fleet.`,
  },
  "timeouts.networkPingMs": {
    label: msg`Network ping`,
    why: msg`Is there a network at all: a HEAD to every provider origin, run inside the watchdog tick. Deliberately the shortest wait here—a slow answer must not hold a tick open.`,
  },
  "timeouts.tokenRefreshMs": {
    label: msg`Token refresh`,
    why: msg`The codex refresh-token exchange, run in the utility container. Longer than a usage read: it starts a process and makes an OAuth round trip.`,
  },
  "timeouts.usageReadMs": {
    label: msg`Usage read`,
    why: msg`Reading how much of the subscription window is left, curl'd from the utility container. Nothing is blocked on it; the header simply shows no percentage.`,
  },
  "timeouts.transferMs": {
    label: msg`Clone, fetch or image pull`,
    why: msg`One network operation that moves a repository or an image — clone, fetch, submodule init, image pull. Minutes rather than seconds.`,
  },
  "intervals.recheckMs": {
    label: msg`Recheck reachability`,
    why: msg`How long 'we asked recently' lasts — both the reachability probe's interval and how long a credential verdict stays cached for this page.`,
  },
  "intervals.usagePollMs": {
    label: msg`Poll subscription usage`,
    why: msg`The usage endpoint is undocumented and answers a faster poller with 429 for hours—and your own /status spends from the same budget. Ten minutes inside a five-hour window is a 3% error at worst.`,
  },
  "intervals.usageBackoffMs": {
    label: msg`Back off after a 429`,
    why: msg`How long the usage endpoint is left alone once it has refused. Shorter than the refusal lasts and the poll simply keeps earning fresh ones.`,
  },
  "timeouts.webhookMs": {
    label: msg`Webhook timeout`,
    why: msg`How long the POST above may take. The answer is discarded either way—this only stops a webhook that never replies from holding a notification.`,
  },
  "intervals.notifyBatchMs": {
    label: msg`Batch window`,
    why: msg`How long a notification waits for company before it is sent. This is the knob between one alert an hour and one per event.`,
  },
  "intervals.notifyBackoffMs": {
    label: msg`Reminder ladder`,
    why: msg`How long an unanswered notification waits before each repeat. It holds at the last step for as long as nobody answers. At least one step: an empty ladder repeats every tick.`,
  },
  dbPoolSize: {
    label: msg`Database connections`,
    why: msg`Database connections held open. The panel's snapshot needs about twenty at once, so less than that makes it wait in waves; more buys nothing. Lower it only if your Postgres caps connections.`,
  },
  eventRetentionMs: {
    label: msg`Keep machine events`,
    why: msg`How long the rest of a group's events are kept. The conversation itself — what was said, asked and escalated — is never dropped.`,
  },
  streamBacklog: {
    label: msg`Live stream backlog`,
    why: msg`How many live frames wait for one slow tab before they are dropped. A tab that stopped reading is the only thing here that grows without bound. Dropping is safe: the panel re-reads its state on the next event.`,
  },
  telemetryCacheMs: {
    label: msg`Timing report cache`,
    why: msg`How long one System timing report is reused. Computing it is expensive enough that every other request waits behind it, and the underlying data only updates on a heartbeat anyway.`,
  },
  "sandbox.server": {
    label: msg`Sandbox server`,
    ph: "127.0.0.1:8080",
    why: msg`Where opensandbox-server lives. Must be dns+nft mode or credential injection silently fails. Doesn't have to be this machine—Tailscale peer or cloud machine, SDK only talks HTTP.`,
  },
  "sandbox.image": {
    label: msg`Default image`,
    why: msg`Two sources only: our releases (ghcr.io/pamin-labs/…) and local builds with no registry prefix. Agents run your code inside this image, so an untrusted one hands away the boundary — and the panel cannot tell.`,
  },
  "sandbox.cpu": {
    label: msg`CPU`,
    ph: msg`Empty = 1/4 of host cores`,
    why: msg`Empty = 1/4 of host cores. SDK's own default is 1; tsc --noEmit here takes 7.6s (3.2s on 6 cores).`,
  },
  "sandbox.memory": { label: msg`Memory`, ph: "8Gi", why: msg`Memory ceiling per sandbox.` },
  "sandbox.ttlSeconds": {
    label: msg`Sandbox TTL`,
    why: msg`Renewed when a turn starts, so this is 'recover after idle', not 'task time limit'.`,
  },
  "sandbox.denyDomains": {
    label: msg`Denied domains`,
    ph: msg`One domain per line; empty allows all`,
    why: msg`Domains the sandbox may not reach. A blocklist, not an allowlist — an allowlist would have to name every registry and docs site. Credentials do not depend on this: the sandbox only ever holds fakes.`,
  },
  "sandbox.cacheDirs": {
    label: msg`Shared cache directories`,
    ph: "/root/.bun/install/cache",
    why: msg`Host directories every sandbox mounts, as 'path in container: path on host'. For package-manager caches only — sharing anything a build writes to makes two groups collide. The path must also be in the sandbox server's allowed_host_paths.`,
  },
  notifyWebhook: {
    label: msg`Forward to webhook`,
    ph: msg`Empty: only this page notifies you`,
    why: msg`Empty, only this page notifies you. Filled, each notification POSTs JSON (title / message / url) — ntfy, Bark, a group bot, anything. Content is scrubbed first: this is the only channel that leaves the machine.`,
  },
  skillsDir: {
    label: msg`Skills staging directory`,
    why: msg`Checked skills copy here, read-only mounted to each sandbox. Changes here need sync to sandbox server's allowed_host_paths or container launch fails—loud failure beats silent empty mount.`,
  },
};

/** The two rows whose value is a map, and what an unnamed key box suggests. */
const PAIRS: Record<string, { kind: PairKind; keyPh: MessageDescriptor }> = {
  leaseSlots: { kind: "int", keyPh: msg`gate name` },
  "sandbox.cacheDirs": { kind: "text", keyPh: msg`mount point` },
};

/**
 * Settings the page shows as one row, because they are one decision.
 *
 * The settings table splits any object with fixed keys into a path each, so the
 * server offers `indexModel.runtime` and `indexModel.model` and never
 * `indexModel` — asking for the latter draws nothing. Shown together because a
 * model belongs to a CLI: two rows invite codex plus an Anthropic model, which
 * boots and then fails on every index call.
 */
/**
 * The embedding row takes all three of its remote fields for a second reason.
 *
 * `ConfigSchema` refuses `mode: remote` unless the endpoint parses as a URL and
 * a credential is named, so the write that flips the mode bounces until they are
 * filled — and rows gated on the *stored* mode would still be hidden at exactly
 * the moment somebody needs to type in them. One control owns the whole
 * decision, and it reveals the fields on the press rather than on the write.
 */
const PAIRED: Record<string, string[]> = {
  "indexModel.runtime": ["indexModel.model"],
  "embedding.mode": ["embedding.model", "embedding.endpoint", "embedding.credential"],
};

/**
 * Rows that only mean something under another row's value.
 *
 * A depth for a tree walk that is switched off, or a timeout for a webhook
 * nobody set, is a control over something that cannot happen — and reads as a
 * setting somebody forgot to fill in. Written as predicates rather than a value
 * to match, because "is not empty" is as common a gate here as "equals".
 */
const ONLY_WHEN: Record<string, (at: (path: string) => Json | undefined) => boolean> = {
  "pageindex.depth": (at) => at("pageindex.enabled") === true,
  "pageindex.width": (at) => at("pageindex.enabled") === true,
  "timeouts.webhookMs": (at) => at("notifyWebhook") !== "",
};

type Write = (write: SettingWrite) => Promise<{ ok: boolean; text: string }>;

export function Knobs({
  section,
  /**
   * Skip this component's own title band.
   *
   * For a section rendered inside a `FieldSet` that already names it — otherwise
   * the pane shows the name twice, once as a legend and once as a heading, which
   * reads as two groups where there is one.
   */
  bare = false,
}: {
  section: KnobSection;
  bare?: boolean;
}) {
  const queries = useQueryClient();
  const [saved, setSaved] = useState<string | null>(null);
  const savedAt = (at: string): string => t`Saved ${at}`;

  // Every section of this dialog reads the same machine settings, so they share
  // one entry rather than each mounting its own effect and asking again.
  //
  // The throw keeps a failed re-read from emptying the page: `readApi` has
  // already shown the refusal, and returning `null` would replace the knobs with
  // 读取中…. An error leaves the last good answer in place.
  const { data: knobs = null, isError } = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const d = await readApi(api.settings.$get(), SettingsResponseSchema);
      if (!d) throw new Error("settings read failed");
      return d.settings;
    },
  });

  const write: Write = async (body) => {
    // Destructured: `post` returns `{ok, text}`, so `if (!ok)` on the object
    // itself is always false and a refused write still says 已保存. `quiet`
    // because the row shows the reason where the value is.
    const r = await mutate(api.settings.$post({ json: body }), true);
    if (r.ok) {
      setSaved(new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }));
      await queries.invalidateQueries({ queryKey: ["settings"] });
    }
    return r;
  };

  const spec = SECTIONS[section];
  // Built from every knob, not from this section's rows: the model pickers on
  // 模型与预算 read three different paths, and a section that shows one of them
  // still needs the other two to know what to offer.
  const at = (path: string) => (knobs ?? []).find((k) => k.path === path)?.value;
  const indexRuntime = ConfigSchema.shape.indexModel.shape.runtime.optional().parse(at("indexModel.runtime"));
  const indexModel = ConfigSchema.shape.indexModel.shape.model.optional().parse(at("indexModel.model"));
  const difficultyModel = ConfigSchema.shape.difficultyModel.optional().parse(at("difficultyModel"));
  const contextWindow = ConfigSchema.shape.contextWindow.optional().parse(at("contextWindow"));
  const src: ModelSources = {
    ...(difficultyModel !== undefined ? { difficultyModel } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    indexModel: {
      ...(indexRuntime !== undefined ? { runtime: indexRuntime } : {}),
      ...(indexModel !== undefined ? { model: indexModel } : {}),
    },
  };
  // Per group, in the order the group lists them. A path the server did not send
  // simply has no row, a row whose gate is shut is not drawn at all, and a group
  // left with none draws nothing rather than an empty legend over a hairline.
  const rowsOf = (paths: string[]) =>
    paths
      .filter((path) => ONLY_WHEN[path]?.(at) ?? true)
      .flatMap((path) => (knobs ?? []).filter((k) => k.path === path));

  return (
    // The dialog's shared label column is 5rem. These labels are sentences
    // rather than nouns — 暂停多久后封存 — so the five knob panes share a wider
    // one among themselves rather than each row wrapping to three lines.
    <div className="[--label:8.5rem]">
      {/* Where a save button would be. There is none: a field is written when it
          loses focus, and this says the write landed. */}
      {bare ? (
        saved && <Meta className="mb-1 block">{savedAt(saved)}</Meta>
      ) : (
        <Head title={i18n._(spec.title)} note={i18n._(spec.note)}>
          {/* Clear of the dialog's close button, which is absolutely positioned
              over this band and was sitting on the last character of the time. */}
          {saved && <Meta className="mr-7">{savedAt(saved)}</Meta>}
        </Head>
      )}
      {/* Three states, not two. A read that failed used to leave 读取中… on the
          screen forever, which is a page claiming to be busy while nothing is in
          flight — and the toast that said otherwise is long gone by the time
          anybody looks. */}
      {knobs === null && isError ? (
        <Empty>
          <Trans>Couldn't read the settings from the server.</Trans>{" "}
          <Button variant="quiet" size="sm" onClick={() => void queries.refetchQueries({ queryKey: ["settings"] })}>
            <RotateCcw className="size-3" />
            <Trans>Try again</Trans>
          </Button>
        </Empty>
      ) : knobs === null ? (
        <Working>
          <Trans>Loading…</Trans>
        </Working>
      ) : (
        // Space between groups, hairlines inside them: a legend that sat on the
        // same rule as the row above it made a section boundary and a row
        // boundary look like the same thing.
        //
        // A wider label column than the shared default, because these labels are
        // the longest in the dialog — "Clone, fetch or image pull" wrapped at
        // 10rem, and one row taller than its neighbours breaks the column the
        // eye is reading down.
        <div className="flex flex-col gap-5 [--label:13rem]">
          {spec.groups.map((group, i) => (
            <Group
              key={group.paths[0]}
              group={group}
              rows={rowsOf(group.paths)}
              knobs={knobs}
              src={src}
              // The permission belongs to the first group's list rather than
              // above it: two `FieldGroup`s stacked leave exactly one missing
              // hairline where they meet, which reads as a list that lost a row.
              permission={i === 0 && section === "notify"}
              onWrite={write}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** One run of rows, with the legend that names it when it has one. */
function Group({
  group,
  rows,
  knobs,
  src,
  permission,
  onWrite,
}: {
  group: KnobGroup;
  rows: Knob[];
  /** Every knob, not just this group's: a `PAIRED` row's other halves can sit anywhere. */
  knobs: Knob[];
  src: ModelSources;
  permission: boolean;
  onWrite: Write;
}) {
  if (!rows.length && !permission) return null;
  // Two columns once a group is long enough to scroll for. Every row here is a
  // label and one narrow control, so half the width was empty and the reader
  // paid for it in scrolling — 调度 was thirteen rows in a dialog that shows
  // nine. A tab would have shortened it too, by hiding half of it behind a
  // click; this hides nothing.
  const wide = rows.length > 6 && !permission;
  // A row whose editor is more than one control — a map, a pair table, a ladder,
  // a list of lines — takes the whole width. In a two-column grid it sets the
  // height of its row, so the single control beside it sits above a hole the
  // size of the map. `object` and `array` are exactly those editors.
  const tall = (k: Knob) => k.type === "object" || k.type === "array";
  const body = (
    <FieldGroup className={wide ? "grid grid-cols-2 gap-x-10 divide-y-0 [--label:9.5rem]" : undefined}>
      {permission && <Permission />}
      {rows.map((k) => (
        <Row
          key={k.path}
          knob={k}
          // The hairline is per row rather than from `divide-y`, which in a grid
          // draws between grid *items* and would rule the two columns apart.
          className={wide ? cn("border-rule-soft border-b", tall(k) && "col-span-2") : undefined}
          mates={(PAIRED[k.path] ?? []).flatMap((path) => knobs.filter((x) => x.path === path))}
          src={src}
          onWrite={onWrite}
        />
      ))}
    </FieldGroup>
  );
  if (!group.legend) return body;
  return (
    <FieldSet>
      {/* `label`, not `legend`: this names a run of rows inside a pane whose own
          name is already in the band above, so it sits at the row scale rather
          than competing with it. */}
      <FieldLegend variant="label">{i18n._(group.legend)}</FieldLegend>
      {body}
    </FieldSet>
  );
}

/** Label and reason for a knob, falling back to the raw path. */
/** Resolved here rather than in the table: a descriptor is what survives a
 *  locale change, and this runs on every render. */
const said = (m: MessageDescriptor | string | undefined): string | undefined =>
  m === undefined || typeof m === "string" ? m : i18n._(m);

const copyFor = (k: Knob): { label: string; why: string | undefined; ph: string | undefined } => {
  const c = COPY[k.path];
  return { label: c ? i18n._(c.label) : k.path, why: said(c?.why), ph: said(c?.ph) };
};

function KnobLabel({ knob, id }: { knob: Knob; id: string }) {
  const copy = copyFor(knob);
  const title = selfNamed(knob.path, knob.type);
  return (
    <div className="flex min-w-0 items-baseline gap-1.5">
      {title ? <FieldTitle id={id}>{copy.label}</FieldTitle> : <FieldLabel htmlFor={id}>{copy.label}</FieldLabel>}
      {copy.why && <Help>{copy.why}</Help>}
    </div>
  );
}

function ResetOverride({ onReset }: { onReset: () => void }) {
  return (
    <Tip label={t`Reset to default`}>
      <Button variant="quiet" size="sm" aria-label={t`Reset to default`} className="shrink-0" onClick={onReset}>
        <RotateCcw className="size-3" />
        <Trans>Modified</Trans>
      </Button>
    </Tip>
  );
}

async function saveKnob(target: Knob, value: Json, onWrite: Write): Promise<string | null> {
  // Typing the shipped value back is not an override. Otherwise the row reads
  // 已改 while being identical to the default, and clearing appears to do nothing.
  const same = JSON.stringify(value) === JSON.stringify(target.default);
  const body = SettingWriteSchema.safeParse({ path: target.path, value: same ? null : value });
  if (!body.success) return z.prettifyError(body.error);
  const result = await onWrite(body.data);
  return result.ok ? null : result.text;
}

function resetKnobs(knob: Knob, mates: Knob[], write: (target: Knob, value: Json) => void) {
  for (const target of [knob, ...mates]) write(target, target.default);
}

function Row({
  knob,
  mates,
  src,
  className,
  onWrite,
}: {
  knob: Knob;
  mates: Knob[];
  src: ModelSources;
  className?: string | undefined;
  onWrite: Write;
}) {
  // What is wrong, and which box it is wrong in. A table row can hold six boxes
  // and "要一个数量" under all of them says nothing about which.
  const [bad, setBad] = useState<Complaint>(NO_COMPLAINT);
  const id = `knob-${knob.path.replace(/\W/g, "-")}`;

  const put = async (target: Knob, value: Json) => {
    const why = await saveKnob(target, value, onWrite);
    setBad(why ? { why, at: "" } : NO_COMPLAINT);
  };

  // A wide table gets its label above it, not beside it. The label column is
  // sized for the longest name in the pane, so a four-character one next to a
  // grid that starts past it leaves a column of nothing — which is what the
  // model pane looked like: three tables, each indented past 13rem of blank.
  const stacked = TABLES.has(knob.path);

  return (
    <Field
      orientation={stacked ? "vertical" : "horizontal"}
      className={className}
      data-invalid={invalidFlag(bad)}
      aria-labelledby={labelledBy(knob.path, knob.type, id)}
    >
      {/* The `?` is a sibling of the label, not a child of it: inside a
          `<label htmlFor>` every click on it would also focus the field it
          explains, which is a control that moves the cursor somewhere else. */}
      <KnobLabel knob={knob} id={id} />
      <FieldContent className="flex-col items-stretch gap-1">
        <div
          data-block={TABLES.has(knob.path)}
          className="flex w-full items-center gap-2 data-[block=true]:items-start"
        >
          <Value
            id={id}
            knob={knob}
            mates={mates}
            src={src}
            bad={badCell(bad)}
            onWrite={(v) => void put(knob, v)}
            onWriteMate={(path, v) => void put(mates.find((m) => m.path === path) ?? knob, v)}
            onRefuse={(why, at) => setBad({ why, at })}
            onClear={() => setBad(NO_COMPLAINT)}
          />
          {/* Neutral, not the accent: the accent means "waiting on you" and this
              is only "not the shipped value". */}
          {rowChanged(knob, mates) && (
            <ResetOverride onReset={() => resetKnobs(knob, mates, (target, next) => void put(target, next))} />
          )}
        </div>
        {bad.why && <span className="text-meta leading-snug text-accent">{bad.why}</span>}
      </FieldContent>
    </Field>
  );
}

function modelValue({ knob, mates, src, onWrite, onWriteMate }: Editor) {
  // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- this renderer intentionally owns only model knobs
  switch (knob.path) {
    case "difficultyModel":
      return <ModelTable table={ConfigSchema.shape.difficultyModel.parse(knob.value)} src={src} onWrite={onWrite} />;
    case "sliceBudgetTokens":
      return <Caps caps={ConfigSchema.shape.sliceBudgetTokens.parse(knob.value)} onWrite={onWrite} />;
    case "embedding.mode": {
      const shape = ConfigSchema.shape.embedding.shape;
      return (
        <Embedding
          mode={shape.mode.parse(knob.value)}
          model={shape.model.catch("").parse(mateValue(mates, "embedding.model"))}
          endpoint={shape.endpoint.catch("").parse(mateValue(mates, "embedding.endpoint"))}
          credential={shape.credential.catch("").parse(mateValue(mates, "embedding.credential"))}
          onMode={onWrite}
          onField={onWriteMate}
        />
      );
    }
    case "indexModel.runtime":
      return (
        <IndexModel
          runtime={ConfigSchema.shape.indexModel.shape.runtime.parse(knob.value)}
          model={ConfigSchema.shape.indexModel.shape.model.catch("").parse(mateValue(mates, "indexModel.model"))}
          src={src}
          onRuntime={onWrite}
          onModel={(v) => onWriteMate("indexModel.model", v)}
        />
      );
    default:
      return null;
  }
}

/** The key box's own placeholder, or what the kind of map suggests instead. */
const keyPh = (knob: Knob, fallback: string) => copyFor(knob).ph ?? fallback;

function mapValue({ knob, src, bad, onWrite, onRefuse, onClear }: Editor) {
  // Both map editors are the same control; only the key box and what a value has
  // to parse as differ, so they are one branch rather than two near-identical ones.
  const pairs = PAIRS[knob.path];
  if (pairs) {
    return (
      <Pairs
        map={rec(knob.value)}
        kind={pairs.kind}
        keyPh={keyPh(knob, i18n._(pairs.keyPh))}
        bad={bad}
        onWrite={onWrite}
        onRefuse={onRefuse}
        onClear={onClear}
      />
    );
  }
  // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- this renderer intentionally owns only map knobs
  switch (knob.path) {
    case "contextWindow":
      return <Windows map={ConfigSchema.shape.contextWindow.parse(knob.value)} src={src} onWrite={onWrite} />;
    case "sandbox.denyDomains":
      return (
        <Lines
          list={ConfigSchema.shape.sandbox.shape.denyDomains.parse(knob.value)}
          ph={copyFor(knob).ph}
          onWrite={onWrite}
        />
      );
    case "baseBranchFallbacks":
      // A list of names, in preference order, which is exactly what a textarea
      // preserves. It was a text box holding `["main","master"]`, where adding a
      // third meant getting JSON right by hand.
      return (
        <Lines
          list={ConfigSchema.shape.baseBranchFallbacks.parse(knob.value)}
          ph={copyFor(knob).ph}
          onWrite={onWrite}
        />
      );
    case "intervals.notifyBackoffMs":
      return <Ladder list={ConfigSchema.shape.intervals.shape.notifyBackoffMs.parse(knob.value)} onWrite={onWrite} />;
    default:
      return null;
  }
}

/** What this browser is reading in, as the language names itself. Read off the
 *  active locale rather than the stored preference: what leads the list should be
 *  the language actually on screen. */
const reading = (): string => endonymOf(localeOf(i18n.locale));

function choiceValue({ knob, onWrite }: Editor) {
  // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- this renderer intentionally owns only choice knobs
  switch (knob.path) {
    case "language":
      // Any language, suggested rather than restricted: this governs what the
      // *agents* write, and a model writes whatever it is told to. `say()`'s
      // table is only the orchestrator's own status lines — a smaller fact, and
      // it is in the row's note.
      // The panel's own language leads the list, because "same as what I am
      // reading" is the answer most of the time and typing it is the only way to
      // get it otherwise. It writes that language's name, not a "follow" token:
      // the server never learns what this browser is set to — that lives in
      // `localStorage` — so a value promising to track it would be a lie the
      // moment the reader changed panes.
      return (
        <Combobox
          free
          value={ConfigSchema.shape.language.parse(knob.value)}
          options={[reading(), ...LANGUAGE_SUGGESTIONS.filter((l) => l !== reading())]}
          placeholder={LANGUAGE_SUGGESTIONS.slice(0, 3).join(" / ")}
          onCommit={onWrite}
        />
      );
    case "autoAcceptTiers":
      return (
        <Toggles
          value={ConfigSchema.shape.autoAcceptTiers.parse(knob.value)}
          // Sorted back into tier order before it is written: a toggle group
          // hands back the order things were pressed in, and ["normal",
          // "trivial"] is the shipped default with its elements swapped — which
          // this page would then have to call 已改.
          onValueChange={(picked) => onWrite(TIERS.filter((t) => picked.includes(t)))}
          className="flex items-center gap-0.5"
        >
          {TIERS.map((t) => (
            <Segment key={t} value={t}>
              {t}
            </Segment>
          ))}
        </Toggles>
      );
    default: // @skip-exhaustive-check: this renderer owns only choice knobs
      return null;
  }
}

function Value(props: Editor) {
  // Six are structured values. They stay out of the scalar parser because a
  // labelled table can keep keys valid where a JSON text box cannot.
  return modelValue(props) ?? mapValue(props) ?? choiceValue(props) ?? scalarValue(props);
}

/**
 * A number and its unit, for the four shapes a stored number can have.
 *
 * A duration or a count is a number and a unit, so it gets two controls. The
 * text parser below still handles the rest — and still accepts `3h` typed into
 * the digits box's sibling — but nobody has to spell anything.
 */
function numberValue({ id, knob, bad, onWrite, onRefuse, onClear }: Editor) {
  const shape = KNOB_SHAPE[knob.path];
  const now = Number(knob.value);
  const scale = durationScale(shape);

  if (scale) {
    return (
      <DurationAmount
        ms={now * scale}
        label={copyFor(knob).label}
        invalid={bad === ""}
        onWrite={(next) => onWrite(Math.round(next / scale))}
      />
    );
  }
  if (shape === "count") {
    return <CountAmount value={now} label={copyFor(knob).label} invalid={bad === ""} onWrite={onWrite} />;
  }
  // Stored as a fraction of one and read as a percentage, which is the row
  // where a typo is quietest: `6` typed over `60%` is a legal fraction and
  // means every turn rotates its session. Digits plus a fixed suffix leaves no
  // way to type the number in the other scale by accident.
  if (shape === "percent") {
    return (
      <Amount
        n={Math.round(now * 1000) / 10}
        unit="%"
        units={PERCENT}
        label={copyFor(knob).label}
        invalid={bad === ""}
        onCommit={(pct) => {
          if (pct <= 0 || pct > 100) return onRefuse(i18n._(WANTS.percent), "");
          // Divided, not multiplied: 600 / 1000 is the same double as 0.6.
          onWrite(Math.round(pct * 10) / 1000);
        }}
      />
    );
  }
  return (
    <Box
      id={id}
      value={showNumber(now, shape)}
      invalid={bad === ""}
      className="w-[9rem] flex-none"
      onUnchanged={onClear}
      onCommit={(raw) => {
        const n = readNumber(raw, now, shape);
        if (n === null) return onRefuse(shape ? i18n._(WANTS[shape]) : t`A number`, "");
        onWrite(n);
      }}
    />
  );
}

function scalarValue(editor: Editor) {
  const { id, knob, bad, onWrite, onClear } = editor;
  // Named by the row's own title rather than by an id of its own — a `<label
  // htmlFor>` and a `FieldTitle` cannot both hold the same id, and the switch
  // is the thing that needs the name.
  if (knob.type === "boolean") {
    return <Switch aria-labelledby={id} checked={Boolean(knob.value)} onCheckedChange={onWrite} />;
  }
  if (knob.type === "number") return numberValue(editor);
  return (
    <Box
      id={id}
      value={textOf(knob.value)}
      placeholder={copyFor(knob).ph}
      invalid={bad === ""}
      onUnchanged={onClear}
      onCommit={onWrite}
    />
  );
}
