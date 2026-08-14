import { useEffect, useMemo, useRef, useState } from "react";
import { Empty, Head, Meta } from "../ui/bits";
import { Button } from "../ui/button";
import { ask } from "../ui/confirm";
import { pull, post, type Frame, type State } from "../lib/api";
import { clock, cn } from "../lib/utils";

/**
 * What each group's container is, and what it is saying right now.
 *
 * The clone and the install are the first two minutes of a requirement and the
 * longest thing that happens before any work — and until this existed they were
 * two grey dashes and a spinner. A boss watching a group that has not started
 * yet has exactly one question, "is it stuck", and the answer is in the output
 * neither pane was showing.
 *
 * The log is in memory on the server, capped and gone on restart (`sandboxlog.ts`)
 * — said on the panel rather than implied, because the outcome that matters is
 * already a line in 记录 and this must not read as a second copy of it.
 */

interface Mount {
  mountPath: string;
  hostPath: string;
  readOnly: boolean;
}

interface Line {
  at: number;
  kind: "cmd" | "out" | "end";
  text: string;
}

interface SandboxInfo {
  group: { id: number; name: string; status: string; branch: string | null };
  sandbox: {
    id: string | null;
    at: number | null;
    image: string;
    cpu: string;
    memory: string;
    ttlSeconds: number;
    mounts: Mount[];
  };
  lines: Line[];
}

/** A live frame from this group's container, rather than from an agent in it. */
const fromSandbox = (f: Frame, grpId: number): boolean =>
  f.grpId === grpId && f.agentId == null && (f.cls === "tool" || f.cls === "state") && f.author === "orchestrator";

export function Workspace({ st, frames, projectId }: { st: State; frames: Frame[]; projectId: number }) {
  const groups = useMemo(
    () => st.groups.filter((g) => g.project_id === projectId && g.status !== "DISSOLVED"),
    [st.groups, projectId],
  );
  const [pick, setPick] = useState<number | null>(null);
  const here = groups.some((g) => g.id === pick) ? pick! : (groups[0]?.id ?? null);

  const [info, setInfo] = useState<SandboxInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async (grpId: number) => setInfo(await pull<SandboxInfo>(`/api/sandbox?grp=${grpId}`));
  useEffect(() => {
    setInfo(null);
    if (here) void load(here);
  }, [here]);

  // The stored tail, then whatever has arrived since this panel opened. Both,
  // because either one alone is the bug: the tail stops at page load and the
  // live feed starts there.
  const live = useMemo(
    () => (here ? frames.filter((f) => fromSandbox(f, here)).map((f) => ({ at: f.at, kind: kindOf(f.text), text: f.text })) : []),
    [frames, here],
  );
  const lines = useMemo(() => {
    const seen = new Set((info?.lines ?? []).map((l) => `${l.at}:${l.text}`));
    return [...(info?.lines ?? []), ...live.filter((l) => !seen.has(`${l.at}:${l.text}`))];
  }, [info, live]);

  const tail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    tail.current?.scrollTo({ top: tail.current.scrollHeight });
  }, [lines.length]);

  if (!groups.length) return <Empty>这个项目还没有组。丢一个需求进来，第一个容器会在批了之后开出来。</Empty>;

  return (
    <div className="grid min-h-0 grid-cols-[13rem_minmax(0,1fr)] gap-6">
      <nav className="flex min-h-0 flex-col gap-0.5 overflow-y-auto pr-1">
        {groups.map((g) => (
          <button
            key={g.id}
            onClick={() => setPick(g.id)}
            className={cn(
              "flex cursor-pointer items-baseline gap-2 rounded-md px-2 py-1 text-left transition-colors",
              g.id === here ? "bg-sunk text-ink" : "text-ink-2 hover:bg-sunk",
            )}
          >
            <span className="min-w-0 flex-1 truncate text-[0.8125rem]">{g.name}</span>
            <Meta>{g.status}</Meta>
          </button>
        ))}
      </nav>

      <div className="flex min-h-0 flex-col">
        <Head title={info?.group.name ?? "工作区"} note={info?.sandbox.id ? "容器在跑" : "还没有容器"}>
          <Button
            variant="quiet"
            size="sm"
            disabled={busy || !here}
            onClick={async () => {
              const go = await ask({
                title: "重开容器",
                body: "容器会被扔掉，下一个 turn 重建：重新 clone 分支、重装依赖，要几分钟。没提交的改动会丢。",
                yes: "重开",
              });
              if (!go || !here) return;
              setBusy(true);
              await post(`/api/groups/${here}/rebuild`);
              await load(here);
              setBusy(false);
            }}
          >
            重开容器
          </Button>
        </Head>

        {info && (
          <div className="mb-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <Fact k="镜像" v={info.sandbox.image} />
            <Fact k="规格" v={`${info.sandbox.cpu || "默认"} core · ${info.sandbox.memory}`} />
            <Fact k="分支" v={info.group.branch ?? "还没切"} />
            {info.sandbox.at && <Fact k="开出来" v={clock(info.sandbox.at)} />}
            <Fact k="TTL" v={`${Math.round(info.sandbox.ttlSeconds / 3600)}h`} />
          </div>
        )}

        {info?.sandbox.mounts.length ? (
          <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1">
            {info.sandbox.mounts.map((m) => (
              <Meta key={m.mountPath} title={m.hostPath}>
                {m.mountPath}
                {m.readOnly ? " 只读" : ""}
              </Meta>
            ))}
          </div>
        ) : null}

        {/* Not `Pane`: this one needs its own ref to stay pinned to the newest
            line, and the scroll rules are the same ones Pane applies. */}
        <div
          ref={tail}
          className="min-h-0 flex-1 overflow-y-auto rounded-md border border-rule bg-sunk px-3 py-2"
        >
          {!lines.length ? (
            <Empty>容器还没说话。克隆和装依赖会在这里逐行出现。</Empty>
          ) : (
            lines.map((l, i) => (
              <div
                key={`${l.at}-${i}`}
                className={cn(
                  "whitespace-pre-wrap font-mono text-[0.6875rem] leading-relaxed",
                  l.kind === "cmd" ? "text-ink" : l.kind === "end" ? "text-ink-2" : "text-ink-3",
                )}
              >
                {l.text}
              </div>
            ))
          )}
        </div>
        <Meta className="mt-1.5 block">
          日志在服务端内存里，最多 500 行，重启就没了。结论那条在「记录」里。
        </Meta>
      </div>
    </div>
  );
}

/** `$ ` is what the server prefixes a command with; ok / exit N is how one ends. */
const kindOf = (text: string): Line["kind"] =>
  text.startsWith("$ ") ? "cmd" : text === "ok" || /^exit -?\d+$/.test(text) ? "end" : "out";

const Fact = ({ k, v }: { k: string; v: string }) => (
  <span className="flex items-baseline gap-1.5">
    <Meta>{k}</Meta>
    <span className="font-mono text-[0.75rem] text-ink-2">{v}</span>
  </span>
);
