import { useEffect, useState } from "react";
import { GripVertical, X } from "lucide-react";
import { Head, Input, Meta } from "../ui/bits";
import { Button } from "../ui/button";
import { Field, FieldContent, FieldGroup, FieldLabel, FieldTitle, InputGroup } from "../ui/field";
import { Segment, Segments, Toggle, Toggles } from "../ui/segment";
import { Combobox } from "../ui/combobox";
import { cn } from "../lib/utils";
import { api, readApi } from "../lib/api";
import { z } from "zod";
import type { InferResponseType } from "hono/client";
import { StoredProjectConfigSchema } from "../../../src/config-schema.ts";

const projectConfigPost = api.project[":id"].config.$post;
export type ProjectPatch = NonNullable<Parameters<typeof projectConfigPost>[0]>["json"];
type SandboxPatch = NonNullable<ProjectPatch["sandbox"]>;

/**
 * What this repository does differently, and nothing that is true of all of them.
 *
 * Two sections of the settings dialog. The fetch lives in the dialog, because the
 * left rail has to know whether a gate is configured before the section is opened
 * — a dot that only appears once you have looked is a dot that does nothing.
 */

export type ProjectConfigResponse = InferResponseType<(typeof api.project)[":id"]["config"]["$get"], 200>;
const ConfigSchema: z.ZodType<ProjectConfigResponse["config"]> = StoredProjectConfigSchema;
export const ProjectConfigSchema: z.ZodType<ProjectConfigResponse> = z.object({
  repoPath: z.string(),
  config: ConfigSchema,
  resources: z.array(z.object({ name: z.string(), template: z.string() })),
  baseBranch: z.string().nullable(),
  baseBranchNow: z.string(),
  branches: z.array(z.string()),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

/** Handle, order, name, command. Fixed, so the commands line up down the page. */
const GATE_ROW = "grid grid-cols-[1.25rem_1.5rem_7rem_minmax(0,1fr)] items-baseline gap-x-3 px-2";

/**
 * Which checks run before a slice can be accepted, and in what order.
 *
 * The list used to render in the catalogue's alphabetical order while labelling
 * each row with its position in the run order, so the screen read 4, 1, 3, 2. The
 * order is the whole point of the section, so it is the order of the rows: the
 * ones that run are on top, numbered, draggable; the ones that do not are under a
 * rule, unnumbered. Position, number and the 关掉的 heading say the same thing
 * three ways, which is what makes it unmistakable without inventing a checkbox.
 *
 * Reordering is the platform's own drag and drop. Radix has no drag primitive and
 * a library for one list is a dependency for a hundred lines we would not read;
 * `Alt` plus an arrow key does the same thing for the keyboard, which native drag
 * does not cover on its own.
 */
export function Gates({ d, patch }: { d: ProjectConfig; patch: (b: ProjectPatch) => void }) {
  const [drag, setDrag] = useState<string | null>(null);
  const gates = d.config.gates ?? [];
  const on = gates.filter((g) => d.resources.some((r) => r.name === g));
  const off = d.resources.filter((r) => !on.includes(r.name));
  const tpl = (name: string) => d.resources.find((r) => r.name === name)?.template ?? "";

  const move = (from: number, to: number) => {
    if (from < 0 || to < 0 || from === to) return;
    const next = [...on];
    next.splice(to, 0, next.splice(from, 1)[0]!);
    patch({ gates: next });
  };

  return (
    <>
      <Head title="闸门" note="从上往下跑，拖着改顺序" />
      {!d.resources.length ? (
        <Meta className="block py-2">没探到可跑的命令。</Meta>
      ) : (
        <>
          <div
            className={cn(
              GATE_ROW,
              // Same hairline as every row under it: this is the table's first
              // row, not a boundary between two kinds of thing.
              "sticky top-0 z-10 border-b border-rule-soft bg-paper pb-1.5 text-[0.6875rem] text-ink-3",
            )}
          >
            <span />
            <span>顺序</span>
            <span>名字</span>
            <span>命令</span>
          </div>
          <Toggles value={gates} onValueChange={(next) => patch({ gates: next })}>
            {on.map((name, i) => (
              <Toggle
                key={name}
                value={name}
                className={cn(GATE_ROW, "py-2", drag === name && "opacity-50")}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (drag) move(on.indexOf(drag), i);
                  setDrag(null);
                }}
                onKeyDown={(e) => {
                  if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
                  e.preventDefault();
                  move(i, i + (e.key === "ArrowUp" ? -1 : 1));
                }}
              >
                {/* The handle drags, not the row: the row is the on/off switch, and
                    a drag that ends on the element it started from also reads as a
                    click, which would turn the gate off on every reorder. */}
                <span
                  draggable
                  onDragStart={() => setDrag(name)}
                  onDragEnd={() => setDrag(null)}
                  className="cursor-grab active:cursor-grabbing"
                >
                  <GripVertical size={12} strokeWidth={2} className="translate-y-0.5 text-ink-3" />
                </span>
                {/* The digit alone. 「第 N 道」 wrapped to two lines in a column this
                    narrow, and the header already says what the column is. */}
                <Meta>{i + 1}</Meta>
                <span className="truncate text-[0.8125rem]">{name}</span>
                <Meta className="min-w-0 truncate">{tpl(name)}</Meta>
              </Toggle>
            ))}
            {off.length > 0 && (
              // Space, not a rule: the rows below draw their own, and a heavier
              // line here made the break between 开着的 and 关掉的 look like one
              // more row boundary.
              <div className="flex items-baseline gap-3 px-2 pt-6 pb-1.5">
                <Meta>关掉的</Meta>
                <Meta className="text-ink-3">点一下加到最后一道</Meta>
              </div>
            )}
            {off.map((res) => (
              <Toggle key={res.name} value={res.name} className={cn(GATE_ROW, "py-2")}>
                <span />
                <span />
                <span className="truncate text-[0.8125rem]">{res.name}</span>
                <Meta className="min-w-0 truncate">{res.template}</Meta>
              </Toggle>
            ))}
          </Toggles>
          {!on.length && <Meta className="mt-2 block text-accent">一道都没开，LLM 审阅底下就没有地板。</Meta>}
        </>
      )}
    </>
  );
}

/**
 * The container every agent in this repository works inside.
 *
 * Widths follow the values. Six identical full-width boxes for `8Gi` and a path
 * is a wall of frames that says nothing about what goes in them.
 */
export function Sandbox({ d, busy, patch }: { d: ProjectConfig; busy: boolean; patch: (b: ProjectPatch) => void }) {
  const sandbox = d.config.sandbox ?? {};
  const set = <K extends keyof SandboxPatch>(k: K, v: SandboxPatch[K]) => {
    const next: SandboxPatch = { ...sandbox };
    if (v === undefined) delete next[k];
    else next[k] = v;
    patch({ sandbox: next });
  };

  return (
    <>
      <Head title="沙盒" note="灰字是默认值" />
      {/* The label column is the dialog's, not this pane's: settings.tsx sets it
          once so a switch between panes does not move every value sideways. */}
      <FieldGroup>
        {/* Every new group is cut from this branch, every rebase goes onto it, and
            every diff the boss reads is measured against it. Empty means whatever
            the remote's HEAD says, which is re-checked when the remote renames it. */}
        <Row
          label="基线分支"
          value={d.baseBranch ?? ""}
          placeholder={`${d.baseBranchNow}（远端说的）`}
          width="max-w-[14rem]"
          busy={busy}
          onSave={(v) => patch({ baseBranch: v || null })}
          /* GitHub already knows the branch names, so typing one from memory is
             a test nobody should have to sit. Still a box, not a Select: a
             branch that does not exist yet is a legitimate answer, and a login
             that cannot list them must not take the field away. */
          options={d.branches ?? []}
        />
        <Row
          label="装依赖"
          value={d.config.install ?? ""}
          placeholder="留空由 bootstrap 读仓库判断"
          busy={busy}
          onSave={(v) => patch({ install: v || null })}
        />
        <ImageRow value={sandbox.image ?? ""} busy={busy} onSave={(v) => set("image", v || undefined)} />
        <Row
          label="CPU"
          value={sandbox.cpu ?? ""}
          placeholder="宿主核数的 1/4"
          width="max-w-[9rem]"
          busy={busy}
          onSave={(v) => set("cpu", v || undefined)}
        />
        <Row
          label="内存"
          value={sandbox.memory ?? ""}
          placeholder="8Gi"
          width="max-w-[9rem]"
          busy={busy}
          onSave={(v) => set("memory", v || undefined)}
        />
        <DomainsRow
          value={sandbox.denyDomains ?? []}
          busy={busy}
          onSave={(v) => set("denyDomains", v.length ? v : undefined)}
        />
        <Row
          label="共享缓存"
          value={Object.entries(sandbox.cacheDirs ?? {})
            .map(([k, v]) => `${k}:${v}`)
            .join(" ")}
          placeholder="/root/.bun/install/cache:/var/tmp/orch-cache"
          busy={busy}
          onSave={(v) =>
            set(
              "cacheDirs",
              Object.fromEntries(
                v
                  .split(/\s+/)
                  .filter(Boolean)
                  .map((pair): [string, string] => {
                    const i = pair.lastIndexOf(":");
                    return i > 0 ? [pair.slice(0, i), pair.slice(i + 1)] : [pair, ""];
                  })
                  .filter(([, host]) => host),
              ),
            )
          }
        />
      </FieldGroup>
    </>
  );
}

/** Label, value, and a save that only appears once there is something to save. */
/**
 * The domains this project's containers may not reach.
 *
 * A space-separated text box was the wrong shape twice over. It cannot show what
 * is in the list — `api.openai.com registry.npmjs.org internal.corp` is one
 * string the eye has to parse — and it cannot say that one entry is wrong, so a
 * pasted `https://evil.example.com/x` was stored verbatim and matched nothing.
 * Egress rules that silently match nothing are the worst kind: the pane says the
 * domain is blocked and it is not.
 *
 * One chip per domain, each removable, and what is typed is reduced to a host
 * before it lands. Nothing bigger: shadcn has no tag input, and this is an
 * `<input>`, a list, and two keys.
 */
function DomainsRow({ value, busy, onSave }: { value: string[]; busy: boolean; onSave: (v: string[]) => void }) {
  const [draft, setDraft] = useState("");

  // Whatever is pasted, reduced to the thing the sidecar matches on. A URL, a
  // trailing slash, a port, capitals — all of them are somebody meaning a host.
  const host = (raw: string) =>
    raw
      .trim()
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, "")
      .replace(/[/?#].*$/, "")
      .replace(/:\d+$/, "");
  const add = () => {
    const h = host(draft);
    setDraft("");
    if (h && !value.includes(h)) onSave([...value, h]);
  };

  return (
    <Field aria-labelledby="cfg-deny">
      <FieldTitle id="cfg-deny">禁止访问</FieldTitle>
      <FieldContent className="flex-col items-start gap-1.5">
        {value.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {value.map((d) => (
              <span
                key={d}
                className="flex items-center gap-1 rounded-sm bg-sunk py-0.5 pr-1 pl-1.5 font-mono text-[0.6875rem] text-ink-2"
              >
                {d}
                <button
                  type="button"
                  aria-label={`不再禁止 ${d}`}
                  disabled={busy}
                  // Same trick as the combobox list: without it the box blurs
                  // first, `add` commits the half-typed draft against the old
                  // list, and this click then saves `value` from before that —
                  // dropping the domain just added. preventDefault on mousedown
                  // stops the blur; the click still fires.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onSave(value.filter((x) => x !== d))}
                  className="cursor-pointer rounded-sm px-1 text-ink-3 hover:text-accent disabled:opacity-40"
                >
                  <X size={10} strokeWidth={2.5} />
                </button>
              </span>
            ))}
          </div>
        )}
        <Input
          className="min-w-0 max-w-[22rem] font-mono"
          placeholder={value.length ? "再加一个" : "留空 = 出站不拦（README 那节）"}
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={add}
          onKeyDown={(e) => {
            if (e.key === "Enter") return add();
            // The one thing a chip list has to get right: backspace on an empty
            // box takes the last chip, or the only way to undo a typo is to aim.
            if (e.key === "Backspace" && !draft && value.length) onSave(value.slice(0, -1));
          }}
        />
      </FieldContent>
    </Field>
  );
}

type ImageChoices = InferResponseType<typeof api.sandbox.images.$get, 200>;
export const ImageChoicesSchema = z
  .object({
    published: z.array(z.string()),
    local: z.array(z.string()),
    note: z.object({ published: z.string().optional(), local: z.string().optional() }),
    current: z.string(),
  })
  .transform(
    ({ note, ...choices }): ImageChoices => ({
      ...choices,
      note: {
        ...(note.published !== undefined ? { published: note.published } : {}),
        ...(note.local !== undefined ? { local: note.local } : {}),
      },
    }),
  );

/**
 * Which image a group's container is made from — picked, never typed.
 *
 * A typed image name is the shape of field that fails four steps later: the typo
 * is not caught here, it is a container that will not create, on a group that
 * has already been dispatched and told the boss it started. And the set of legal
 * answers is small and knowable — the sandbox refuses anything that is not ours
 * or built here — so both lists can just be shown.
 *
 * 远程 first because it is the answer for everybody who is not developing this
 * project: the published image is pulled on first use and needs nothing on this
 * machine. 本地 is the other half of that rule, and it is exactly what a bare
 * tag means.
 *
 * Empty lists say which kind of empty they are. "Nothing published yet" and
 * "could not reach ghcr.io" send a reader to different places.
 */
export function ImageRow({
  value,
  busy,
  onSave,
  label = "镜像",
  placeholder,
}: {
  value: string;
  busy: boolean;
  onSave: (v: string) => void;
  label?: string;
  /** What "left empty" means here. The project row inherits; the machine's
   *  default row falls back to the yaml a fresh install ships with. */
  placeholder?: string;
}) {
  const [src, setSrc] = useState<"remote" | "local">(value && !value.startsWith("ghcr.io/") ? "local" : "remote");
  const [c, setC] = useState<ImageChoices | null>(null);
  useEffect(() => {
    void readApi(api.sandbox.images.$get(), ImageChoicesSchema).then(setC);
  }, []);

  const options = (src === "remote" ? c?.published : c?.local) ?? [];
  const note = src === "remote" ? c?.note.published : c?.note.local;
  return (
    <Field aria-labelledby="cfg-image">
      <FieldTitle id="cfg-image">{label}</FieldTitle>
      <FieldContent className="flex-col items-start gap-1.5">
        <div className="flex w-full items-center gap-2">
          <Segments
            value={src}
            onValueChange={(value) => {
              if (value === "remote" || value === "local") setSrc(value);
            }}
          >
            <Segment value="remote">远程</Segment>
            <Segment value="local">本地</Segment>
          </Segments>
          <Combobox
            value={value}
            options={options}
            // The default says 分支: this is the branch picker's control, and a
            // filtered image list telling you there is no matching branch is one
            // word away from reading as a broken page.
            empty="没有匹配的镜像"
            placeholder={c ? (placeholder ?? "跟这台机器的默认") : "读取中…"}
            disabled={busy}
            width="max-w-[22rem]"
            onCommit={onSave}
          />
        </div>
        {note && <Meta>{note}</Meta>}
      </FieldContent>
    </Field>
  );
}

function Row(props: {
  label: string;
  value: string;
  placeholder: string;
  width?: string;
  busy: boolean;
  onSave: (v: string) => void;
  /** Known values. Present means one combobox; absent means a plain box. */
  options?: string[];
}) {
  const [v, setV] = useState(props.value);
  useEffect(() => setV(props.value), [props.value]);
  const dirty = v.trim() !== props.value.trim();

  const id = `cfg-${props.label}`;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{props.label}</FieldLabel>
      {/* One control, not two. A box beside a menu splits one value across two
          widgets: the box cannot say what the valid answers are, and the menu
          cannot take an answer that is not on it yet. A combobox is both. */}
      {props.options ? (
        <Combobox
          value={props.value}
          options={props.options}
          placeholder={props.placeholder}
          disabled={props.busy}
          {...(props.width !== undefined ? { width: props.width } : {})}
          onCommit={props.onSave}
        />
      ) : (
        <InputGroup>
          <Input
            id={id}
            className={cn("min-w-0 flex-1 font-mono", props.width)}
            placeholder={props.placeholder}
            value={v}
            disabled={props.busy}
            onChange={(e) => setV(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && dirty) props.onSave(v.trim());
            }}
          />
          {/* A button that is always there and usually does nothing trains you to
              ignore it. */}
          {dirty && (
            <Button size="sm" variant="go" disabled={props.busy} onClick={() => props.onSave(v.trim())}>
              存下
            </Button>
          )}
        </InputGroup>
      )}
    </Field>
  );
}
