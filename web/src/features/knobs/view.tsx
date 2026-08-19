import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import i18n from "../../i18n";
import { api, mutate, readApi } from "../../shared/api";
import { DURATION_UNITS, KNOB_SHAPE, WANTS, msOf, readNumber, showNumber, splitDuration } from "./units";
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

export type KnobSection = "sched" | "models" | "turn" | "boxdefaults" | "notify";

/** Which rows a section shows, in the order they are shown. Title/note come
 *  from `knobs.sections.<section>` in the locale resources. */
const SECTIONS: Record<KnobSection, { paths: string[] }> = {
  sched: {
    paths: ["maxGroups", "leaseSlots", "watchdogIntervalMs", "autoAdvance", "autoAcceptTiers", "parkAfterPausedMs"],
  },
  models: {
    paths: [
      "difficultyModel",
      "indexModel.runtime",
      "contextWindow",
      "sliceBudgetTokens",
      "language",
      "embedding.mode",
      "embedding.endpoint",
      "embedding.credential",
    ],
  },
  turn: {
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
    ],
  },
  notify: {
    paths: ["notifyWebhook"],
  },
  boxdefaults: {
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
const WHY_KEYS = new Set([
  "maxGroups",
  "leaseSlots",
  "watchdogIntervalMs",
  "autoAdvance",
  "autoAcceptTiers",
  "parkAfterPausedMs",
  "difficultyModel",
  "embedding.mode",
  "embedding.endpoint",
  "embedding.credential",
  "indexModel.runtime",
  "contextWindow",
  "sliceBudgetTokens",
  "language",
  "turnTimeoutMs",
  "maxTurnsPerJob",
  "sessionRotateFraction",
  "ctxBudgetChars",
  "unreadDigestThreshold",
  "feedbackSedimentThreshold",
  "gateRetries",
  "leaseTimeoutMs",
  "installTimeoutMs",
  "sandbox.server",
  "sandbox.image",
  "sandbox.cpu",
  "sandbox.memory",
  "sandbox.ttlSeconds",
  "sandbox.denyDomains",
  "sandbox.cacheDirs",
  "notifyWebhook",
  "skillsDir",
]);

const PH_KEYS = new Set([
  "sandbox.server",
  "sandbox.cpu",
  "sandbox.memory",
  "sandbox.denyDomains",
  "sandbox.cacheDirs",
  "notifyWebhook",
]);

/** The two rows whose value is a map, and what an unnamed key box suggests. */
const PAIRS: Record<string, { kind: PairKind; keyPh: string }> = {
  leaseSlots: { kind: "int", keyPh: "闸门名" },
  "sandbox.cacheDirs": { kind: "text", keyPh: "挂载点" },
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
  const { t } = useTranslation();
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
        saved && <Meta className="mb-1 block">{t("knobs.ui.saved", { time: saved })}</Meta>
      ) : (
        <Head title={t(`knobs.sections.${section}.title`)} note={t(`knobs.sections.${section}.note`)}>
          {/* Clear of the dialog's close button, which is absolutely positioned
              over this band and was sitting on the last character of the time. */}
          {saved && <Meta className="mr-7">{t("knobs.ui.saved", { time: saved })}</Meta>}
        </Head>
      )}
      {knobs === null ? (
        <Meta className="block py-2">{t("knobs.ui.loading")}</Meta>
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

/** The reason and placeholder for a knob; the label itself is `labelFor`, below. */
const copyFor = (k: Knob) => ({
  why: WHY_KEYS.has(k.path) ? i18n.t(`knobs.why.${k.path}`) : undefined,
  ph: PH_KEYS.has(k.path) ? i18n.t(`knobs.ph.${k.path}`) : undefined,
});

/**
 * A knob's label, from the locale resources, falling back to its raw path for
 * a knob nobody has written copy for yet.
 *
 * The `i18n` singleton, not `useTranslation()` — every call site below `Row`
 * is a plain function, not a component, and there is nothing a local hook
 * would add: `Row`'s own ancestor (`Knobs`) already calls `useTranslation()`,
 * so a locale switch re-renders this whole subtree regardless, and both paths
 * read the exact same instance underneath.
 */
const labelFor = (k: Knob) => i18n.t(`knobs.labels.${k.path}`, k.path);

function KnobLabel({ knob, id }: { knob: Knob; id: string }) {
  const copy = copyFor(knob);
  const label = labelFor(knob);
  const title = selfNamed(knob.path, knob.type);
  return (
    <div className="flex min-w-0 items-baseline gap-1.5">
      {title ? <FieldTitle id={id}>{label}</FieldTitle> : <FieldLabel htmlFor={id}>{label}</FieldLabel>}
      {copy.why && <Help>{copy.why}</Help>}
    </div>
  );
}

function ResetOverride({ onReset }: { onReset: () => void }) {
  return (
    <Tip label={i18n.t("knobs.ui.resetTip")}>
      <Button
        variant="quiet"
        size="sm"
        aria-label={i18n.t("knobs.ui.resetTip")}
        className="shrink-0"
        onClick={onReset}
      >
        <RotateCcw className="size-3" />
        {i18n.t("knobs.ui.resetLabel")}
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
        {bad.why && <span className="text-[0.6875rem] leading-snug text-accent">{bad.why}</span>}
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
        keyPh={keyPh(knob, i18n.t(`knobs.pairs.${knob.path}.keyPh`, pairs.keyPh))}
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
        label={labelFor(knob)}
        invalid={bad === ""}
        onCommit={(next, u) => onWrite(Math.round(msOf(next, u) / scale))}
      />
    );
  }
  if (shape === "count") {
    return <CountAmount value={now} label={labelFor(knob)} invalid={bad === ""} onWrite={onWrite} />;
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
        label={labelFor(knob)}
        invalid={bad === ""}
        onCommit={(pct) => {
          if (pct <= 0 || pct > 100) return onRefuse(i18n.t("knobs.wants.percent", WANTS.percent), "");
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
        if (n === null) {
          return onRefuse(shape ? i18n.t(`knobs.wants.${shape}`, WANTS[shape]) : i18n.t("knobs.wants.number", "要一个数字"), "");
        }
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
