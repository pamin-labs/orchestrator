/**
 * One editor per knob shape, and the units they carry.
 *
 * Split out of `view.tsx`, which now holds the page, the row and the dispatch —
 * these are the leaves. Each takes an `Editor` and writes a `Json`; none of them
 * knows about sections, fetching or the settings write path, which is what makes
 * them separable at all.
 */
import { Fragment, useEffect, useState } from "react";
import { X } from "lucide-react";
import { cn } from "../../ui/cn";
import { Combobox } from "../../ui/combobox";
import { Field, FieldContent, FieldTitle } from "../../ui/field";
import { Input, Meta, Textarea } from "../../ui/bits";
import { Button } from "../../ui/button";
import { Segment, Segments } from "../../ui/segment";
import { Tip } from "../../ui/tooltip";
import type { Json } from "../../../../src/contracts/json";
import { allModels, cheapest, modelsByRuntime, type ModelSources } from "./models";

import {
  type NotifyState,
  type PairKind,
  TIERS,
  TIERS_ONLY,
  TIER_GRID,
  notifyState,
  runtimeSwitch,
  textOf,
} from "./model";
import { COUNT_UNITS, countOf, splitCount } from "./units";

export const PERCENT = ["%"] as const;

/** The window every model without a row of its own falls back to. Not a model. */
const DEFAULT_KEY = "default";

/**
 * Unit sets where "none" is a real answer, so the toggle may be turned all the
 * way off. Counts qualify — 45 is forty-five — and durations do not.
 */
const BARE_OK = new Set<string>(COUNT_UNITS);

/**
 * Suggestions, not a set. `output.language` is an instruction to a model, and a
 * model writes whatever it is told to — the list is here to save typing and to
 * say what the field wants, not to have an opinion about which languages exist.
 */
export const LANGUAGES = [
  "中文",
  "繁體中文",
  "English",
  "日本語",
  "한국어",
  "Español",
  "Français",
  "Deutsch",
  "Português",
  "Italiano",
  "Nederlands",
  "Polski",
  "Svenska",
  "Русский",
  "Українська",
  "Türkçe",
  "Čeština",
  "Română",
  "Magyar",
  "Ελληνικά",
  "العربية",
  "עברית",
  "हिन्दी",
  "ไทย",
  "Tiếng Việt",
  "Bahasa Indonesia",
];

/**
 * One box, written when it loses focus.
 *
 * Uncontrolled and keyed on the stored value: a refused edit keeps the text that
 * was typed (so it can be fixed rather than retyped) and an accepted one snaps
 * to what the server actually holds, which is how `20 分钟` appears after
 * someone types `1200s`.
 */
/**
 * A number and its unit, as two controls instead of one string to spell.
 *
 * The parser stays — `20 分钟`, `3h`, `8M` all still work — but splitting them
 * leaves digits as the only free text, and the input refuses everything else.
 *
 * Integer-only, which is why `splitCount` exists next to `fmtCount`: the reading
 * format prints 8500000 as `8.5M`, and 8.5 is not something a spinner can step
 * or an integer field can hold. The picker shows 8500k instead.
 */
export function Amount<U extends string>({
  n,
  unit,
  units,
  invalid,
  label,
  onCommit,
}: {
  n: number;
  unit: U;
  units: readonly U[];
  invalid?: boolean;
  label: string;
  onCommit: (n: number, unit: U) => void;
}) {
  // Held locally so that changing the unit keeps the digits already typed, and
  // so a value the server snapped to a different unit re-splits on the way back.
  const [draft, setDraft] = useState(String(n));
  useEffect(() => setDraft(String(n)), [n, unit]);

  const send = (raw: string, u: U) => {
    const v = Number(raw);
    if (raw !== "" && Number.isInteger(v) && v >= 0) onCommit(v, u);
    else setDraft(String(n));
  };

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Input
        type="number"
        inputMode="numeric"
        min={0}
        step={1}
        value={draft}
        aria-label={label}
        aria-invalid={invalid || undefined}
        // Shrinks rather than holding 6.5rem: three of these share the tier grid
        // with a label column, and a fixed width pushed the unit toggle off the
        // right edge of the dialog.
        className="min-w-0 max-w-[6.5rem] flex-1 py-0.5 font-mono text-[0.75rem] aria-[invalid=true]:border-accent"
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={(e) => send(e.currentTarget.value, unit)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") {
            setDraft(String(n));
            e.currentTarget.blur();
          }
        }}
      />
      {/* One unit is not a choice, it is a suffix. */}
      {units.length === 1 ? (
        <Meta>{units[0]}</Meta>
      ) : (
        <Segments
          value={unit}
          // Nothing selected *is* the answer when a bare number is legal, so the
          // empty member is never drawn: pressing the lit one turns it off,
          // which is what a toggle group already means. A unit set with no empty
          // member (毫秒/秒/分钟/小时) keeps what it had, because there is no
          // such thing as a duration without one.
          onValueChange={(u) => {
            const wanted = u || (BARE_OK.has(unit) ? "" : unit);
            const selected = units.find((candidate) => candidate === wanted);
            if (selected !== undefined) send(draft, selected);
          }}
          aria-label={`${label} 的单位`}
          className="shrink-0"
        >
          {units.filter(Boolean).map((u) => (
            <Segment key={u} value={u}>
              {u}
            </Segment>
          ))}
        </Segments>
      )}
    </div>
  );
}

/** A count knob as digits plus k/M. */
export function CountAmount({
  value,
  label,
  invalid,
  onWrite,
}: {
  value: number;
  label: string;
  invalid?: boolean;
  onWrite: (n: number) => void;
}) {
  const { n, unit } = splitCount(value);
  return (
    <Amount
      n={n}
      unit={unit}
      units={COUNT_UNITS}
      label={label}
      {...(invalid !== undefined ? { invalid } : {})}
      onCommit={(next, u) => onWrite(countOf(next, u))}
    />
  );
}

/**
 * Every model this config names, for whichever runtime is being picked.
 *
 * Free text on purpose: see `Combobox`'s `free`. The list spares the typing for
 * the models already in play and does not pretend to know what an account has —
 * neither CLI will tell us.
 */
function ModelPick({
  value,
  options,
  disabled,
  onCommit,
}: {
  value: string;
  options: string[];
  disabled?: boolean;
  onCommit: (v: string) => void;
}) {
  return (
    <Combobox
      free
      {...(disabled !== undefined ? { disabled } : {})}
      value={value}
      options={options}
      placeholder="模型 id"
      empty="还没有别的模型，直接写就行"
      onCommit={onCommit}
    />
  );
}

export function Box({
  value,
  onCommit,
  onUnchanged,
  invalid,
  className,
  ...rest
}: {
  value: string;
  onCommit: (raw: string) => void;
  /**
   * Left as it was found — which is a state worth hearing about, because it is
   * how a complaint goes stale: refuse `nope`, press Escape, and the box holds
   * the stored value again while the row still says what was wrong with a string
   * that is no longer in it.
   */
  onUnchanged?: () => void;
  invalid?: boolean;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "defaultValue" | "onChange">) {
  return (
    <Input
      key={value}
      defaultValue={value}
      spellCheck={false}
      aria-invalid={invalid || undefined}
      {...rest}
      className={cn("min-w-0 flex-1 py-0.5 font-mono text-[0.75rem]", "aria-[invalid=true]:border-accent", className)}
      onBlur={(e) => {
        const raw = e.currentTarget.value.trim();
        if (raw !== value) onCommit(raw);
        else onUnchanged?.();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") {
          e.currentTarget.value = value;
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function RemoveRow({ name, onRemove }: { name: string; onRemove?: () => void }) {
  if (!onRemove) return <span className="w-7 shrink-0" />;
  return (
    <Tip label="删掉这一行">
      <Button variant="quiet" size="sm" aria-label={`删掉 ${name}`} className="shrink-0" onClick={onRemove}>
        <X className="size-3" />
      </Button>
    </Tip>
  );
}

/**
 * A map the boss fills in: model id to window, mount point to host path.
 *
 * Its keys are not ours to enumerate — a model we have not shipped is exactly
 * what this is for — so it is rows plus one empty row, not a form. Naming the
 * empty row is what adds an entry; there is no ＋ button, because a button that
 * makes a blank row and a blank row are the same thing one click apart.
 */
export function Pairs({
  map,
  kind,
  keyPh,
  bad,
  onWrite,
  onRefuse,
  onClear,
}: {
  map: Record<string, Json>;
  kind: PairKind;
  keyPh: string;
  bad: string | null;
  onWrite: (v: Json) => void;
  onRefuse: (why: string, at: string) => void;
  onClear: () => void;
}) {
  const entries = Object.entries(map);
  const show = textOf;
  // A number gets the same 9rem a number gets on every other row of this page;
  // only a path needs the rest of the width.
  const vw = kind === "text" ? "" : "w-[9rem] flex-none";
  const commit = (k: string, raw: string) => {
    if (kind === "text") return onWrite({ ...map, [k]: raw });
    if (!/^\d+$/.test(raw)) return onRefuse("要一个整数", k);
    const n = Number(raw);
    onWrite({ ...map, [k]: n });
  };

  return (
    <div className="flex w-full flex-col gap-1">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-center gap-1.5">
          <Box
            value={k}
            aria-label={`${k} 的名字`}
            className="w-[13rem] flex-none"
            onCommit={(next) => {
              const name = next.trim();
              if (!name) return onRefuse("名字不能空着，要删就按右边的 ×", k);
              // Rebuilt in place rather than deleted and re-added, so a rename
              // does not send the row to the bottom of the list mid-edit.
              onWrite(Object.fromEntries(entries.map(([ek, ev]) => [ek === k ? name : ek, ev])));
            }}
          />
          <Box
            value={show(v)}
            invalid={bad === k}
            aria-label={k}
            className={vw}
            onUnchanged={onClear}
            onCommit={(raw) => commit(k, raw)}
          />
          <RemoveRow name={k} onRemove={() => onWrite(Object.fromEntries(entries.filter(([ek]) => ek !== k)))} />
        </div>
      ))}
      <div className="flex items-center gap-1.5">
        <Box
          // Remounted once a row lands, so the box that added it comes back empty.
          key={`add-${entries.length}`}
          value=""
          placeholder={keyPh}
          aria-label="加一项"
          className="w-[13rem] flex-none"
          // Same reason as the window table: an integer knob here is
          // `z.number().int().positive()`, so a row born at 0 is a row the
          // server refuses and the boss cannot create.
          onCommit={(k) => {
            const name = k.trim();
            if (name) onWrite({ ...map, [name]: kind === "text" ? "" : 1 });
          }}
        />
        <Meta>填个名字就多一行</Meta>
      </div>
    </div>
  );
}

/** A list of one-per-line strings. Nothing here is ordered, so nothing sorts it. */
export function Lines({ list, ph, onWrite }: { list: string[]; ph: string | undefined; onWrite: (v: Json) => void }) {
  const text = list.join("\n");
  return (
    <Textarea
      key={text}
      defaultValue={text}
      placeholder={ph}
      rows={Math.min(6, Math.max(2, list.length + 1))}
      spellCheck={false}
      onBlur={(e) => {
        const next = e.currentTarget.value
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
        if (JSON.stringify(next) !== JSON.stringify(list)) onWrite(next);
      }}
    />
  );
}

/**
 * Runtime by difficulty, drawn as the grid it is. The rows are whichever
 * runtimes the config holds rather than a fixed pair, so a third CLI needs no
 * change here.
 */
export function ModelTable({
  table,
  src,
  onWrite,
}: {
  table: Record<string, Record<string, string>>;
  src: ModelSources;
  onWrite: (v: Json) => void;
}) {
  const byRuntime = modelsByRuntime(src);
  return (
    <div className={cn(TIER_GRID, "items-center gap-x-2 gap-y-1")}>
      <span />
      {TIERS.map((t) => (
        <Meta key={t}>{t}</Meta>
      ))}
      {Object.entries(table).map(([runtime, row]) => (
        <Fragment key={runtime}>
          <Meta className="truncate">{runtime}</Meta>
          {TIERS.map((t) => (
            // Offered that runtime's models only. Pasting a gpt id into the
            // claude row is a model that runtime cannot run, and the turn that
            // finds out is the one that fails.
            <ModelPick
              key={t}
              value={row?.[t] ?? ""}
              options={byRuntime[runtime] ?? []}
              onCommit={(m) => onWrite({ ...table, [runtime]: { ...row, [t]: m } })}
            />
          ))}
        </Fragment>
      ))}
    </div>
  );
}

/**
 * Model to context window: a picker for the key, digits and a unit for the value.
 *
 * Not `Pairs` — a model id is not free text. It has to match what a role is run
 * with character for character, and a typo is silent: the model falls back to
 * the `default` window and rotates its session at a fraction of its real size.
 * Models named elsewhere in the config are offered; anything else can still be
 * typed, because that is how a new one gets added at all.
 */
export function Windows({
  map,
  src,
  onWrite,
}: {
  map: Record<string, number>;
  src: ModelSources;
  onWrite: (v: Json) => void;
}) {
  // `default` first and always present: it is the window every model without a
  // row falls back to, and deleting it drops all of them to `MIN_CONTEXT` — a
  // fleet-wide rotation nothing reports. Sorted, because the fallback belongs
  // above the exceptions to it.
  const entries = Object.entries({ default: 0, ...map }).sort(([a], [b]) =>
    a === DEFAULT_KEY ? -1 : b === DEFAULT_KEY ? 1 : 0,
  );
  const taken = new Set(entries.map(([k]) => k));
  const free = allModels(src).filter((m) => !taken.has(m));
  return (
    <div className="flex w-full flex-col gap-1">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-center gap-1.5">
          <div className="w-[13rem] flex-none">
            <ModelPick
              value={k}
              // Its own name plus the unclaimed ones: a list that dropped the
              // current value would show the row's own key as no match.
              options={[k, ...free]}
              disabled={k === DEFAULT_KEY}
              onCommit={(name) => {
                if (!name.trim() || name === k) return;
                onWrite(Object.fromEntries(entries.map(([ek, ev]) => [ek === k ? name : ek, ev])));
              }}
            />
          </div>
          <CountAmount value={Number(v)} label={k} onWrite={(n) => onWrite({ ...map, [k]: n })} />
          <RemoveRow
            name={k}
            {...(k !== DEFAULT_KEY
              ? { onRemove: () => onWrite(Object.fromEntries(entries.filter(([ek]) => ek !== k))) }
              : {})}
          />
        </div>
      ))}
      <div className="flex items-center gap-1.5">
        <div className="w-[13rem] flex-none">
          <ModelPick
            key={`add-${entries.length}`}
            value=""
            options={free}
            // Born at the fallback window, not at 0. A row is written the moment
            // it is named — there is nowhere to put a value first — and 0 is
            // refused by the schema (`z.number().int().positive()`), so a row
            // born at 0 is one the boss cannot create. The fallback is the honest
            // guess anyway: it is what this model was already sized by.
            onCommit={(name) => {
              if (name.trim()) onWrite({ ...map, [name.trim()]: Number(map[DEFAULT_KEY]) || 200_000 });
            }}
          />
        </div>
        <Meta>{free.length ? "选一个模型就多一行" : "填个模型 id 就多一行"}</Meta>
      </div>
    </div>
  );
}

/** The three tiers, as three token caps. */
export function Caps({ caps, onWrite }: { caps: Record<string, number>; onWrite: (v: Json) => void }) {
  return (
    <div className={cn(TIERS_ONLY, "items-center gap-x-2 gap-y-1")}>
      {TIERS.map((t) => (
        <Meta key={t}>{t}</Meta>
      ))}
      {TIERS.map((t) => (
        <CountAmount key={t} value={Number(caps[t] ?? 0)} label={t} onWrite={(n) => onWrite({ ...caps, [t]: n })} />
      ))}
    </div>
  );
}

/**
 * Which CLI, and which model on it. Two settings, one decision, one row.
 *
 * Switching the CLI must not carry the model with it: a gpt id on claude is a
 * model that runtime cannot run, and this is the most frequent model call in the
 * system, so the failure arrives everywhere at once. It moves to the new
 * runtime's `trivial` model, which `difficultyModel` already names — the answer
 * is in the config rather than in a price table nobody would update.
 */
export function IndexModel({
  runtime,
  model,
  src,
  onRuntime,
  onModel,
}: {
  runtime: string;
  model: string;
  src: ModelSources;
  onRuntime: (v: string) => void;
  onModel: (v: string) => void;
}) {
  const byRuntime = modelsByRuntime(src);
  const runtimes = Object.keys(byRuntime).length ? Object.keys(byRuntime) : ["claude", "codex"];
  return (
    <div className="flex w-full items-center gap-2">
      <Segments
        value={runtime}
        onValueChange={(next) => {
          const change = runtimeSwitch(next, runtime, cheapest(src, next), model);
          if (!change) return;
          onRuntime(change.runtime);
          if (change.model) onModel(change.model);
        }}
      >
        {runtimes.map((r) => (
          <Segment key={r} value={r}>
            {r}
          </Segment>
        ))}
      </Segments>
      <ModelPick value={model} options={byRuntime[runtime] ?? []} onCommit={onModel} />
    </div>
  );
}

/**
 * The browser's own permission, asked for where the boss can see why.
 *
 * A button rather than a prompt on load: asking before the page has said
 * anything worth being notified about gets 拒绝, and that decision is sticky.
 */
/** What each answer means, and where the reader has to go to change it. */
const NOTIFY_SAID: Record<NotifyState, string> = {
  unsupported: "这个浏览器不支持",
  granted: "已开。面板在后台也会弹，浏览器整个关掉才收不到——那时重新打开会补上。",
  denied: "被浏览器拒了。要开的话在地址栏左边的站点设置里改，然后刷新。",
  // The only state with anything left to press.
  ask: "",
};

export function Permission() {
  const supported = typeof Notification !== "undefined";
  const [state, setState] = useState(supported ? Notification.permission : "denied");
  const said = NOTIFY_SAID[notifyState(supported, state)];
  return (
    <Field aria-labelledby="notify-perm">
      <FieldTitle id="notify-perm">桌面通知</FieldTitle>
      <FieldContent>
        {said ? (
          <Meta>{said}</Meta>
        ) : (
          <Button size="sm" onClick={() => void Notification.requestPermission().then(setState)}>
            允许通知
          </Button>
        )}
      </FieldContent>
    </Field>
  );
}
