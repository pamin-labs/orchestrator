import { useEffect, useState } from "react";
import { Empty, H2, Input, Meta, Pane } from "../ui/bits";
import { Button } from "../ui/button";
import { Toggle, Toggles } from "../ui/segment";
import { pull, post } from "../lib/api";

/**
 * What this project does differently, and nothing that is true of all of them.
 *
 * The split is the point: credentials and the host belong to the machine and are
 * asked for once, in 设置. Gates, the install command and the sandbox a group
 * gets are properties of the repository, so they live beside the other
 * per-project view rather than in a global page the boss visits once and forgets.
 *
 * Every field here has a working default. The page shows what the default is and
 * lets it be overridden, rather than presenting empty boxes that look required.
 */

interface Config {
  gates?: string[];
  install?: string | null;
  shared?: string[];
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

  return (
    <Pane className="max-w-[52rem]">
      <H2>闸门</H2>
      <Empty>
        每片切片按顺序跑，第一个不过就停下 —— 后面的输出只是噪音。名字来自 resource 表，注册项目时按栈自动探出来的。
      </Empty>
      <Toggles
        value={gates}
        // Ordering is the running order, so a gate that goes back on returns to
        // the end rather than to wherever it used to be.
        onValueChange={(next) => patch({ gates: next })}
        className="mt-2 border-t border-rule"
      >
        {d.resources.map((res) => (
          <Toggle key={res.name} value={res.name}>
            <span className="w-36 shrink-0 text-[0.8125rem]">{res.name}</span>
            <Meta className="min-w-0 flex-1 truncate">{res.template}</Meta>
            {gates.includes(res.name) && <Meta>第 {gates.indexOf(res.name) + 1} 道</Meta>}
          </Toggle>
        ))}
        {!d.resources.length && <Meta className="block py-2">这个项目没有探到可跑的命令。</Meta>}
      </Toggles>
      {!gates.length && (
        <Meta className="mt-2 block leading-relaxed text-bad">
          一道都没开：没有确定性检查的项目，LLM 审阅底下就没有地板。
        </Meta>
      )}

      <H2 className="mt-9">装依赖</H2>
      <Field
        value={d.config.install ?? ""}
        placeholder="bun install / poetry install / make bootstrap …"
        note="每个组建好 checkout 之后跑一次，在它自己的沙盒里。留空就交给 bootstrap 角色读仓库自己判断，判断出来的结果会写回这里。"
        busy={busy}
        onSave={(v) => patch({ install: v || null })}
      />

      <H2 className="mt-9">沙盒</H2>
      <Empty>留空就用全局默认。只有这个仓库和别人不一样的地方才需要填。</Empty>
      <div className="mt-2 space-y-3">
        <Field
          label="镜像"
          value={sandbox.image ?? ""}
          placeholder="orch/agent:1"
          note="要有这个项目的工具链。默认那个带 bun、node、git 和两个 CLI。"
          busy={busy}
          onSave={(v) => patch({ sandbox: { ...sandbox, image: v || undefined } })}
        />
        <Field
          label="CPU"
          value={sandbox.cpu ?? ""}
          placeholder="宿主核数的 1/4"
          note="闸门慢下来先看这个：SDK 自己的默认是 1 核，这个仓库的 tsc 因此从 3.2s 变 7.6s。"
          busy={busy}
          onSave={(v) => patch({ sandbox: { ...sandbox, cpu: v || undefined } })}
        />
        <Field
          label="禁止访问"
          value={(sandbox.denyDomains ?? []).join(" ")}
          placeholder="空格分隔的域名，留空 = 不禁"
          note="沙盒默认能上网 —— 查文档、装依赖都要。这里是黑名单，不是白名单：白名单才是穷举不完的那个。"
          busy={busy}
          onSave={(v) =>
            patch({ sandbox: { ...sandbox, denyDomains: v.split(/\s+/).filter(Boolean) } })
          }
        />
        <Field
          label="共享缓存"
          value={Object.entries(sandbox.cacheDirs ?? {})
            .map(([k, v]) => `${k}:${v}`)
            .join(" ")}
          placeholder="容器里的路径:宿主路径，空格分隔"
          note="所有沙盒共用的包管理器缓存。实测第二个组的 bun install 从 2.9s 到 1.2s，大项目上差得更多。默认关：共享可写目录是这个仓库最惨那次事故的形状。"
          busy={busy}
          onSave={(v) =>
            patch({
              sandbox: {
                ...sandbox,
                cacheDirs: Object.fromEntries(
                  v
                    .split(/\s+/)
                    .filter(Boolean)
                    .map((pair) => {
                      const i = pair.lastIndexOf(":");
                      return i > 0 ? [pair.slice(0, i), pair.slice(i + 1)] : [pair, ""];
                    })
                    .filter(([, host]) => host),
                ),
              },
            })
          }
        />
      </div>

      <Meta className="mt-8 block">{d.repoPath}</Meta>
    </Pane>
  );
}

/** One value, its default, and why you would change it. Saves on blur or Enter. */
function Field(props: {
  label?: string;
  value: string;
  placeholder: string;
  note: string;
  busy: boolean;
  onSave: (v: string) => void;
}) {
  const [v, setV] = useState(props.value);
  useEffect(() => setV(props.value), [props.value]);
  const dirty = v.trim() !== props.value.trim();

  return (
    <div className="border-t border-rule pt-2">
      <div className="flex flex-wrap items-center gap-2">
        {props.label && <span className="w-20 shrink-0 text-[0.8125rem] text-ink">{props.label}</span>}
        <Input
          className="min-w-0 flex-1 font-mono"
          placeholder={props.placeholder}
          value={v}
          disabled={props.busy}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && dirty) props.onSave(v.trim());
          }}
        />
        {/* Only once there is something to save: a button that is always there
            and usually does nothing trains you to ignore it. */}
        {dirty && (
          <Button size="sm" variant="go" disabled={props.busy} onClick={() => props.onSave(v.trim())}>
            存下
          </Button>
        )}
      </div>
      <Meta className="mt-1 block leading-relaxed">{props.note}</Meta>
    </div>
  );
}
