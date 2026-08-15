import { useEffect, useState } from "react";
import { GripVertical } from "lucide-react";
import { Head, Input, Meta } from "../ui/bits";
import { Button } from "../ui/button";
import { Field, FieldContent, FieldGroup, FieldLabel, FieldTitle, InputGroup } from "../ui/field";
import { Segment, Segments, Toggle, Toggles } from "../ui/segment";
import { Combobox } from "../ui/combobox";
import { cn } from "../lib/utils";
import { pull } from "../lib/api";

/**
 * What this repository does differently, and nothing that is true of all of them.
 *
 * Two sections of the settings dialog. The fetch lives in the dialog, because the
 * left rail has to know whether a gate is configured before the section is opened
 * — a dot that only appears once you have looked is a dot that does nothing.
 */

export interface Config {
  gates?: string[];
  install?: string | null;
  sandbox?: {
    image?: string;
    cpu?: string;
    memory?: string;
    denyDomains?: string[];
    cacheDirs?: Record<string, string>;
  };
}

export interface ProjectConfig {
  repoPath: string;
  config: Config;
  resources: Array<{ name: string; template: string }>;
  /** What the boss pinned, or null for "ask the remote". */
  baseBranch: string | null;
  /** What that resolves to right now. */
  baseBranchNow: string;
  /** What the remote has. Empty when GitHub could not be asked — not a failure. */
  branches?: string[];
}

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
export function Gates({ d, patch }: { d: ProjectConfig; patch: (b: Record<string, unknown>) => void }) {
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
              "sticky top-0 z-10 border-b border-rule bg-paper pb-1.5 text-[0.6875rem] text-ink-3",
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
              <div className="flex items-baseline gap-3 border-b border-rule px-2 pt-3 pb-1.5">
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
          {!on.length && (
            <Meta className="mt-2 block text-accent">一道都没开，LLM 审阅底下就没有地板。</Meta>
          )}
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
export function Sandbox({
  d, busy, patch,
}: {
  d: ProjectConfig;
  busy: boolean;
  patch: (b: Record<string, unknown>) => void;
}) {
  const sandbox = d.config.sandbox ?? {};
  const set = (k: string, v: unknown) => patch({ sandbox: { ...sandbox, [k]: v } });

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
        <Row
          label="禁止访问"
          value={(sandbox.denyDomains ?? []).join(" ")}
          placeholder="域名，空格分隔"
          busy={busy}
          onSave={(v) => set("denyDomains", v.split(/\s+/).filter(Boolean))}
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
                  .map((pair) => {
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
interface ImageChoices {
  published: string[];
  local: string[];
  note: { published?: string; local?: string };
}

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
function ImageRow({ value, busy, onSave }: { value: string; busy: boolean; onSave: (v: string) => void }) {
  const [src, setSrc] = useState<"remote" | "local">(value && !value.startsWith("ghcr.io/") ? "local" : "remote");
  const [c, setC] = useState<ImageChoices | null>(null);
  useEffect(() => {
    void pull<ImageChoices>("/api/sandbox/images").then(setC);
  }, []);

  const options = (src === "remote" ? c?.published : c?.local) ?? [];
  const note = src === "remote" ? c?.note.published : c?.note.local;
  return (
    <Field aria-labelledby="cfg-image">
      <FieldTitle id="cfg-image">镜像</FieldTitle>
      <FieldContent className="flex-col items-start gap-1.5">
        <div className="flex w-full items-center gap-2">
          <Segments value={src} onValueChange={(v) => setSrc(v as "remote" | "local")}>
            <Segment value="remote">远程</Segment>
            <Segment value="local">本地</Segment>
          </Segments>
          <Combobox
            value={value}
            options={options}
            placeholder={c ? "ghcr.io/pamin-labs/orch-agent:latest（默认）" : "读取中…"}
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
          width={props.width}
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
