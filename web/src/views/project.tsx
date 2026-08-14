import { useEffect, useState } from "react";
import { H2, Input, Meta, Pane } from "../ui/bits";
import { Button } from "../ui/button";
import { Field, FieldGroup, FieldLabel, InputGroup } from "../ui/field";
import { Toggle, Toggles } from "../ui/segment";
import { pull, post } from "../lib/api";

/**
 * What this repository does differently, and nothing that is true of all of them.
 *
 * Same grid as 设置, because it answers the same shape of question one scope
 * down: credentials and the host belong to the machine, gates and the sandbox
 * belong to the repo. Placeholders carry the defaults, so an empty field is a
 * statement rather than a blank waiting to be filled.
 */

interface Config {
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

interface Loaded {
  repoPath: string;
  config: Config;
  resources: Array<{ name: string; template: string }>;
}

export function ProjectSettings({ projectId }: { projectId: number }) {
  const [d, setD] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => setD(await pull<Loaded>(`/api/project/${projectId}/config`));
  useEffect(() => {
    void load();
  }, [projectId]);

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    await post(`/api/project/${projectId}/config`, body);
    setBusy(false);
    void load();
  };

  if (!d) return <Meta className="block py-2">读取中…</Meta>;
  const gates = d.config.gates ?? [];
  const sandbox = d.config.sandbox ?? {};
  const set = (k: string, v: unknown) => patch({ sandbox: { ...sandbox, [k]: v } });

  return (
    <Pane className="max-w-[46rem]">
      <H2 className="mb-1.5">闸门</H2>
      <Toggles
        value={gates}
        // Pressed order is running order, so a gate switched back on goes to the
        // end rather than back to wherever it used to sit.
        onValueChange={(next) => patch({ gates: next })}
        className="border-t border-rule"
      >
        {d.resources.map((res) => (
          <Toggle
            key={res.name}
            value={res.name}
            className="grid grid-cols-[10rem_minmax(0,1fr)] items-baseline gap-x-4"
          >
            <span className="text-[0.8125rem]">{res.name}</span>
            <span className="flex min-w-0 items-baseline gap-2">
              <Meta className="min-w-0 flex-1 truncate">{res.template}</Meta>
              {gates.includes(res.name) && <Meta>第 {gates.indexOf(res.name) + 1} 道</Meta>}
            </span>
          </Toggle>
        ))}
      </Toggles>
      {!d.resources.length && <Meta className="block py-2">没探到可跑的命令。</Meta>}
      {d.resources.length > 0 && !gates.length && (
        <Meta className="mt-1.5 block text-accent">一道都没开，LLM 审阅底下就没有地板。</Meta>
      )}

      <H2 className="mt-9 mb-1.5">沙盒</H2>
      <FieldGroup>
        <Row
          label="装依赖"
          value={d.config.install ?? ""}
          placeholder="留空由 bootstrap 读仓库判断"
          busy={busy}
          onSave={(v) => patch({ install: v || null })}
        />
        <Row
          label="镜像"
          value={sandbox.image ?? ""}
          placeholder="orch/agent:1"
          busy={busy}
          onSave={(v) => set("image", v || undefined)}
        />
        <Row
          label="CPU"
          value={sandbox.cpu ?? ""}
          placeholder="宿主核数的 1/4"
          busy={busy}
          onSave={(v) => set("cpu", v || undefined)}
        />
        <Row
          label="内存"
          value={sandbox.memory ?? ""}
          placeholder="8Gi"
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
    </Pane>
  );
}

/** Label, value, and a save that only appears once there is something to save. */
function Row(props: {
  label: string;
  value: string;
  placeholder: string;
  busy: boolean;
  onSave: (v: string) => void;
}) {
  const [v, setV] = useState(props.value);
  useEffect(() => setV(props.value), [props.value]);
  const dirty = v.trim() !== props.value.trim();

  const id = `cfg-${props.label}`;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{props.label}</FieldLabel>
      <InputGroup>
        <Input
          id={id}
          className="min-w-0 flex-1 font-mono"
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
    </Field>
  );
}
