import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { api, mutate, readApi } from "../../shared/api";
import { DURATION_UNITS, KNOB_SHAPE, WANTS, msOf, readNumber, showNumber, splitDuration, unitLabel } from "./units";
import type { ModelSources } from "./models";
import {
  Amount,
  Box,
  Embedding,
  Caps,
  CountAmount,
  IndexModel,
  LANGUAGES,
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
import { Field, FieldContent, FieldGroup, FieldLabel, FieldTitle } from "../../ui/field";
import { Head, Meta } from "../../ui/bits";
import { Button } from "../../ui/button";
import { Segment, Toggles } from "../../ui/segment";
import { Switch } from "../../ui/switch";
import { Help, Tip } from "../../ui/tooltip";
import { z } from "zod";
import type { Json } from "../../../../src/contracts/json";
import { ConfigSchema, SettingWriteSchema, type SettingWrite } from "../../../../src/contracts/config";
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

export type KnobSection = "sched" | "models" | "turn" | "boxdefaults" | "notify" | "waits";

/** Which rows a section shows, in the order they are shown. */
/**
 * Knobs a section deliberately does not draw, because another control owns them.
 *
 * Exported so the coverage check can tell "owned elsewhere" from "forgotten" —
 * the second is what put thirteen keys on the API and nowhere on the page.
 */
export const KNOBS_ELSEWHERE = new Set(["sandbox.server", "sandbox.image"]);

/**
 * `msg` at module scope, `i18n._` at call scope. A descriptor is locale-free
 * data, so a table built once at import is still right after the locale changes
 * — which a resolved string would not be: it freezes at first evaluation.
 */
export const SECTIONS: Record<KnobSection, { title: MessageDescriptor; note: MessageDescriptor; paths: string[] }> = {
  sched: {
    title: msg`Scheduling`,
    note: msg`Concurrent work limits and queuing`,
    paths: [
      "maxGroups",
      "leaseSlots",
      "watchdogIntervalMs",
      "autoAdvance",
      "autoAcceptTiers",
      "parkAfterPausedMs",
      "watchdog.idleTurns",
      "watchdog.sameFile",
      "watchdog.reemitMs",
      "watchdog.nudgeAfterMs",
      "watchdog.nudgeReemitMs",
      "watchdog.pausedNotifyMs",
      "watchdog.repoMapEveryMs",
      "prPoll.prs",
      "prPoll.messages",
      "prPoll.checks",
      "prPoll.threads",
      "prPoll.threadComments",
      "baseBranchFallbacks",
    ],
  },
  models: {
    title: msg`Models & budget`,
    note: msg`Cost-controlling settings`,
    paths: [
      "difficultyModel",
      "indexModel.runtime",
      "contextWindow",
      "sliceBudgetTokens",
      "language",
      "embedding.mode",
      "embedding.endpoint",
      "embedding.credential",
      "embedding.model",
      "indexModel.model",
      "pageindex.enabled",
      "pageindex.depth",
      "pageindex.width",
    ],
  },
  turn: {
    title: msg`Turns & context`,
    note: msg`Turn duration and context limits`,
    paths: [
      "turnTimeoutMs",
      "maxTurnsPerJob",
      "sessionRotateFraction",
      "ctxBudgetChars",
      "unreadDigestThreshold",
      "feedbackSedimentThreshold",
      "gateRetries",
      "leaseTimeoutMs",
      "installTimeoutMs",
      "skillsDir",
      "telemetryCacheMs",
      "eventRetentionMs",
      "streamBacklog",
    ],
  },
  waits: {
    title: msg`Waiting and retries`,
    // Everything here bounds a wait on something outside this process: GitHub, a
    // container, the network. They were eighteen literals across seven files, and
    // the only ones anybody could change were the three turn budgets.
    note: msg`How long to wait on something outside before calling it a timeout`,
    paths: [
      "timeouts.githubApiMs",
      "timeouts.credentialCheckMs",
      "timeouts.sandboxPingMs",
      "timeouts.networkPingMs",
      "timeouts.tokenRefreshMs",
      "timeouts.usageReadMs",
      "timeouts.transferMs",
      "intervals.recheckMs",
      "intervals.usagePollMs",
      "intervals.usageBackoffMs",
      "dbPoolSize",
    ],
  },
  notify: {
    title: msg`Notifications`,
    note: msg`How to alert you`,
    paths: ["notifyWebhook", "timeouts.webhookMs", "intervals.notifyBatchMs", "intervals.notifyBackoffMs"],
  },
  boxdefaults: {
    title: msg`Sandbox defaults`,
    note: msg`Used when a project has not set its own`,
    // Not `sandbox.server` or `sandbox.image`: the pane this section renders
    // inside owns both, with an address row that validates and an image row that
    // lists what the registry has. A knob row for the image is a plain text box,
    // which is how "the image dropdown disappeared" happened — two controls for
    // one value, and the reader found the other one.
    paths: ["sandbox.cpu", "sandbox.memory", "sandbox.ttlSeconds", "sandbox.denyDomains", "sandbox.cacheDirs"],
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
const COPY: Record<string, { label: MessageDescriptor; why?: MessageDescriptor; ph?: MessageDescriptor | string }> = {
  maxGroups: {
    label: msg`Concurrent jobs`,
    why: msg`The first ceiling usually isn't this: two groups can't own overlapping paths, so low-modularity projects can't reach 10; then account-level rate limits. Raising this, watch cache hit rate on the cost page—high concurrency on one subscription throttles there first.`,
  },
  leaseSlots: {
    label: msg`Gate concurrency`,
    why: msg`A lease is real compilation or testing. Ten concurrent will trash the machine; dead leases hold slots until timeout. Browser gets 1 alone—each is a real Chromium—or all gates queue behind one screenshot.`,
  },
  watchdogIntervalMs: {
    label: msg`Watchdog interval`,
    why: msg`How often deterministic rules run. Also how long queued work waits without an explicit tick before dispatch.`,
  },
  autoAdvance: {
    label: msg`Auto-advance when approved`,
    why: msg`Disabled: a group finishes a slice and stops until morning, defeating the whole purpose of this system. Cost stated clearly: if a slice goes wrong, the next ones are built on it—when you revert that slice, the whole group pauses and explains, not silently under-rewriting completed work.`,
  },
  autoAcceptTiers: {
    label: msg`Auto-accept tiers`,
    why: msg`After passing all four gates (self-review / audit / test run / QA), the fifth—your manual eye—is skipped. Defaults to trivial and normal; hard still waits for you. That glance is least valuable on the two cheapest tiers.`,
  },
  parkAfterPausedMs: {
    label: msg`Archive after paused`,
    why: msg`Archive releases the sandbox. Groups parked too long hog concurrency slots for nothing.`,
  },
  difficultyModel: {
    label: msg`Difficulty → Model`,
    why: msg`Dispatcher tags each slice; this table maps tags to models. Which CLI role uses which is in roles/*.yaml; here we choose model per difficulty per CLI. Changes only affect newly hired agents—model is frozen at hire time.`,
  },
  "embedding.mode": {
    label: msg`Embedding mode`,
    why: msg`Local or remote. Today neither accepts retrieval—ADR 031 field-tested rejected vectors: same-language ranking works, cross-language fails when unrelated text in one language covers truly relevant text in another, and cross-language is the only reason this exists. Reopening condition is a runnable check (bun run embedding:check), and its remote half won't run—it needs an endpoint you pick. This switch lets that rejection be disproven. Remote sends corpus, corpus holds your requirements and acceptance criteria—default is local; going remote is a decision.`,
  },
  "embedding.endpoint": {
    label: msg`Remote endpoint`,
    why: msg`Full /v1/embeddings address, OpenAI-shaped. Write full, not just hostname—which path a provider uses is pure guesswork. Used only when mode is remote.`,
  },
  "embedding.credential": {
    label: msg`Remote credential name`,
    why: msg`The name of that line in 'Model account', not the key itself. Key in config is key in shell history and every backup.`,
  },
  "indexModel.runtime": {
    label: msg`Index model`,
    why: msg`The single most-called model call across the whole system: pure summarization, no decision-making, no tools, no blackboard. First thing to move off a premium subscription.`,
  },
  contextWindow: {
    label: msg`Context window`,
    why: msg`The denominator for session rotation. Both CLI agents report real values in a turn, and that takes priority; this table manages the first turn of a session. When we pinned 200k, strong models rotated constantly in the 12% of a 1M window, discarding built-up cache prefix each time.`,
  },
  sliceBudgetTokens: {
    label: msg`Token limit per slice`,
    why: msg`From 16 real slices here: trivial average 4.0M (one outlier 12.0M), normal average 7.3M, tail 16.1M. Cap above 'worst finished slice', below 'the outlier'—this ceiling is for already-lost agents, not today's bad run. Changes affect new slices only.`,
  },
  language: {
    label: msg`Output language`,
    why: msg`Governs journals, channel messages, the questions it asks you, and status summaries. An agent writes those, so any language works — the list only saves typing, it is not the set. Code, commit messages, branch names, PRs and error messages stay English. The orchestrator's own two dozen status lines exist in Chinese and English only; any other language falls back to English, which does not affect what the agents write. Changing this rotates every session in the fleet — it is part of the cache prefix.`,
  },
  turnTimeoutMs: {
    label: msg`Turn timeout`,
    why: msg`Exceeded, watchdog kills it. Real max single-turn was 8.2 minutes.`,
  },
  maxTurnsPerJob: {
    label: msg`Max steps per turn`,
    why: msg`Real data: 259 turns, median 36 steps, p90 93, max 144. The 23% over 60 steps ate 59% of the cache-read bill, because every step re-reads the full transcript. 36 is work; the tail is an agent lost, grepping. Cut the tail, median doesn't move. Changing this rotates the whole fleet through a session.`,
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
  "sandbox.server": {
    label: msg`Sandbox server`,
    ph: "127.0.0.1:8080",
    why: msg`Where opensandbox-server lives. Must be dns+nft mode or credential injection silently fails. Doesn't have to be this machine—Tailscale peer or cloud machine, SDK only talks HTTP.`,
  },
  "sandbox.image": {
    label: msg`Default image`,
    why: msg`Only two sources: our releases (ghcr.io/pamin-labs/…) and local builds without registry prefix. Agents run here with your code—swap in an untrusted image and you've handed the boundary to someone else, invisibly from the panel.`,
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
    why: msg`Blacklist, not whitelist—whitelist is the one that's incomplete (every registry, every docs site). Credential security doesn't rely on it: real tokens live in the sidecar, sandbox gets format-valid fakes.`,
  },
  "sandbox.cacheDirs": {
    label: msg`Shared cache directories`,
    ph: "/root/.bun/install/cache",
    why: msg`Host directories shared across all sandboxes, 'mount point in container: host path'. Cache package managers only. Real test: this repo, group two's bun install—no share 2.9s, shared 1.2s. Small because repo is small; monorepo sees minutes. Disabled by default because the worst incident here was all worktrees sharing node_modules; two gates install together, groups mistake EEXIST for their own broken build. Also needs that path listed in sandbox server's allowed_host_paths.`,
  },
  notifyWebhook: {
    label: msg`Forward to webhook`,
    ph: msg`Empty: only this page notifies you`,
    why: msg`Empty: only this page notifies you. Filled: each notification POSTs JSON (title / message / url)—ntfy, Bark, group bot, or what you wrote this afternoon, all work. Scrubbed before egress—this is the only channel that sends content off this machine.`,
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
 * Two settings the page shows as one row, because they are one decision.
 *
 * The settings table splits any object with fixed keys into a path each, so the
 * server offers `indexModel.runtime` and `indexModel.model` and never
 * `indexModel` — asking for the latter draws nothing. Shown together because a
 * model belongs to a CLI: two rows invite codex plus an Anthropic model, which
 * boots and then fails on every index call.
 */
const PAIRED: Record<string, string> = {
  "indexModel.runtime": "indexModel.model",
  "embedding.mode": "embedding.model",
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

  // Every section of this dialog reads the same machine settings, so they share
  // one entry rather than each mounting its own effect and asking again.
  //
  // The throw keeps a failed re-read from emptying the page: `readApi` has
  // already shown the refusal, and returning `null` would replace the knobs with
  // 读取中…. An error leaves the last good answer in place.
  const { data: knobs = null } = useQuery({
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
  const rows = (knobs ?? []).filter((k) => spec.paths.includes(k.path));
  rows.sort((a, b) => spec.paths.indexOf(a.path) - spec.paths.indexOf(b.path));

  return (
    // The dialog's shared label column is 5rem. These labels are sentences
    // rather than nouns — 暂停多久后封存 — so the five knob panes share a wider
    // one among themselves rather than each row wrapping to three lines.
    <div className="[--label:8.5rem]">
      {/* Where a save button would be. There is none: a field is written when it
          loses focus, and this says the write landed. */}
      {bare ? (
        saved && <Meta className="mb-1 block">已保存 {saved}</Meta>
      ) : (
        <Head title={i18n._(spec.title)} note={i18n._(spec.note)}>
          {/* Clear of the dialog's close button, which is absolutely positioned
              over this band and was sitting on the last character of the time. */}
          {saved && <Meta className="mr-7">已保存 {saved}</Meta>}
        </Head>
      )}
      {knobs === null ? (
        <Meta className="block py-2">
          <Trans>Loading…</Trans>
        </Meta>
      ) : (
        // The permission is a row of this list, not a block above it: two
        // `FieldGroup`s stacked leave exactly one missing hairline where they
        // meet, which reads as a list that lost a row.
        <FieldGroup>
          {section === "notify" && <Permission />}
          {rows.map((k) => {
            const mate = knobs.find((x) => x.path === PAIRED[k.path]) ?? null;
            return <Row key={k.path} knob={k} mate={mate} src={src} onWrite={write} />;
          })}
        </FieldGroup>
      )}
    </div>
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

function resetKnobs(knob: Knob, mate: Knob | null, write: (target: Knob, value: Json) => void) {
  write(knob, knob.default);
  if (mate) write(mate, mate.default);
}

function Row({ knob, mate, src, onWrite }: { knob: Knob; mate: Knob | null; src: ModelSources; onWrite: Write }) {
  // What is wrong, and which box it is wrong in. A table row can hold six boxes
  // and "要一个数量" under all of them says nothing about which.
  const [bad, setBad] = useState<Complaint>(NO_COMPLAINT);
  const id = `knob-${knob.path.replace(/\W/g, "-")}`;

  const put = async (target: Knob, value: Json) => {
    const why = await saveKnob(target, value, onWrite);
    setBad(why ? { why, at: "" } : NO_COMPLAINT);
  };

  return (
    <Field data-invalid={invalidFlag(bad)} aria-labelledby={labelledBy(knob.path, knob.type, id)}>
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
            mate={mate}
            src={src}
            bad={badCell(bad)}
            onWrite={(v) => void put(knob, v)}
            onWriteMate={(v) => void put(mate ?? knob, v)}
            onRefuse={(why, at) => setBad({ why, at })}
            onClear={() => setBad(NO_COMPLAINT)}
          />
          {/* Neutral, not the accent: the accent means "waiting on you" and this
              is only "not the shipped value". */}
          {rowChanged(knob, mate) && (
            <ResetOverride onReset={() => resetKnobs(knob, mate, (target, next) => void put(target, next))} />
          )}
        </div>
        {bad.why && <span className="text-meta leading-snug text-accent">{bad.why}</span>}
      </FieldContent>
    </Field>
  );
}

function modelValue({ knob, mate, src, onWrite, onWriteMate }: Editor) {
  // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- this renderer intentionally owns only model knobs
  switch (knob.path) {
    case "difficultyModel":
      return <ModelTable table={ConfigSchema.shape.difficultyModel.parse(knob.value)} src={src} onWrite={onWrite} />;
    case "sliceBudgetTokens":
      return <Caps caps={ConfigSchema.shape.sliceBudgetTokens.parse(knob.value)} onWrite={onWrite} />;
    case "embedding.mode":
      return (
        <Embedding
          mode={ConfigSchema.shape.embedding.shape.mode.parse(knob.value)}
          model={ConfigSchema.shape.embedding.shape.model.catch("").parse(mateValue(mate))}
          onMode={onWrite}
          onModel={onWriteMate}
        />
      );
    case "indexModel.runtime":
      return (
        <IndexModel
          runtime={ConfigSchema.shape.indexModel.shape.runtime.parse(knob.value)}
          model={ConfigSchema.shape.indexModel.shape.model.catch("").parse(mateValue(mate))}
          src={src}
          onRuntime={onWrite}
          onModel={onWriteMate}
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
    default:
      return null;
  }
}

function choiceValue({ knob, onWrite }: Editor) {
  // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- this renderer intentionally owns only choice knobs
  switch (knob.path) {
    case "language":
      // Any language, suggested rather than restricted: this governs what the
      // *agents* write, and a model writes whatever it is told to. `say()`'s
      // table is only the orchestrator's own status lines — a smaller fact, and
      // it is in the row's note.
      return (
        <Combobox
          free
          value={ConfigSchema.shape.language.parse(knob.value)}
          options={LANGUAGES}
          placeholder="中文 / English / 日本語 …"
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
    const { n, unit } = splitDuration(now * scale);
    return (
      <Amount
        n={n}
        unit={unit}
        units={DURATION_UNITS}
        labelOf={unitLabel}
        label={copyFor(knob).label}
        invalid={bad === ""}
        onCommit={(next, u) => onWrite(Math.round(msOf(next, u) / scale))}
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
          if (pct <= 0 || pct > 100) return onRefuse(WANTS.percent, "");
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
        if (n === null) return onRefuse(shape ? WANTS[shape] : t`A number`, "");
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
