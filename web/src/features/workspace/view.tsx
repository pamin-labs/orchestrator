import type { InferResponseType } from "hono/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { GRP_STATES } from "../../../src/contracts/states.ts";
import { api, groupAction, type PanelFrame, readApi } from "../lib/api";
import { clock, cn } from "../lib/utils";
import { Empty, Meta } from "../ui/bits";
import { Button } from "../ui/button";
import { ask } from "../ui/confirm";

/**
 * What this group's container is, and what it is saying right now.
 *
 * The clone and the install are the first two minutes of a requirement and the
 * longest thing that happens before any work — and until this existed they were
 * two grey dashes and a spinner. A boss watching a group that has not started
 * yet has exactly one question, "is it stuck", and the answer is in the output
 * neither pane was showing.
 *
 * A tab on the requirement rather than a sixth peer view: a container belongs to
 * one group, so a top-level 工作区 had to open with a list of groups to pick from
 * — asking the boss to re-find the requirement they had just been reading. The
 * `Bootstrap` strip at the top of the same page is the other half and not a
 * duplicate: it interrupts while a rebuild runs, this is where you go to look.
 *
 * The log is in memory on the server, capped and gone on restart (`sandboxlog.ts`)
 * — said on the panel rather than implied, because the outcome that matters is
 * already a line in 记录 and this must not read as a second copy of it.
 */

const LineSchema = z.object({ at: z.number(), kind: z.enum(["cmd", "out", "end"]), text: z.string() });
type Line = z.infer<typeof LineSchema>;
const SandboxInfoSchema: z.ZodType<InferResponseType<typeof api.sandbox.$get, 200>> = z.object({
  group: z.object({ id: z.number(), name: z.string(), status: z.enum(GRP_STATES), branch: z.string().nullable() }),
  sandbox: z.object({
    id: z.string().nullable(),
    at: z.number().nullable(),
    image: z.string(),
    cpu: z.string(),
    memory: z.string(),
    ttlSeconds: z.number(),
    mounts: z.array(z.object({ mountPath: z.string(), hostPath: z.string(), readOnly: z.boolean() })),
  }),
  lines: z.array(LineSchema),
});
type SandboxInfo = z.infer<typeof SandboxInfoSchema>;

/** A live frame from this group's container, rather than from an agent in it. */
const fromSandbox = (f: PanelFrame, grpId: number): boolean =>
  f.grpId === grpId && f.agentId == null && (f.cls === "tool" || f.cls === "state") && f.author === "orchestrator";

export function Workspace({ frames, grpId }: { frames: PanelFrame[]; grpId: number }) {
  const [info, setInfo] = useState<SandboxInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async (id: number) =>
    setInfo(await readApi(api.sandbox.$get({ query: { grp: String(id) } }), SandboxInfoSchema));
  useEffect(() => {
    setInfo(null);
    void load(grpId);
  }, [grpId]);

  // The stored tail, then whatever has arrived since this panel opened. Both,
  // because either one alone is the bug: the tail stops at page load and the
  // live feed starts there.
  const live = useMemo(
    () => frames.filter((f) => fromSandbox(f, grpId)).map((f) => ({ at: f.at, kind: kindOf(f.text), text: f.text })),
    [frames, grpId],
  );
  const lines = useMemo(() => {
    const seen = new Set((info?.lines ?? []).map((l) => `${l.at}:${l.text}`));
    return [...(info?.lines ?? []), ...live.filter((l) => !seen.has(`${l.at}:${l.text}`))];
  }, [info, live]);

  const tail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    tail.current?.scrollTo({ top: tail.current.scrollHeight });
  }, [lines.length]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <Meta>{info?.sandbox.id ? "容器在跑" : "还没有容器"}</Meta>
        {info && (
          <>
            <Fact k="镜像" v={info.sandbox.image} />
            <Fact k="规格" v={`${info.sandbox.cpu || "默认"} core · ${info.sandbox.memory}`} />
            <Fact k="分支" v={info.group.branch ?? "还没切"} />
            {info.sandbox.at && <Fact k="开出来" v={clock(info.sandbox.at)} />}
            <Fact k="TTL" v={`${Math.round(info.sandbox.ttlSeconds / 3600)}h`} />
          </>
        )}
        <Button
          className="ml-auto"
          variant="quiet"
          size="sm"
          disabled={busy}
          onClick={async () => {
            const go = await ask({
              title: "重开容器",
              // No duration here: nothing times a rebuild, and clone plus install
              // already says what it costs.
              body: "容器会被扔掉，下一个 turn 重建：重新 clone 分支、重装依赖。没提交的改动会丢。",
              yes: "重开",
            });
            if (!go) return;
            setBusy(true);
            await groupAction(grpId, "rebuild");
            await load(grpId);
            setBusy(false);
          }}
        >
          重开容器
        </Button>
      </div>

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
      <div ref={tail} className="min-h-0 flex-1 overflow-y-auto rounded-md border border-rule bg-sunk px-3 py-2">
        {!lines.length ? (
          <Empty>容器还没说话。克隆和装依赖会在这里逐行出现。</Empty>
        ) : (
          lines.map((l) => (
            <div
              key={`${l.at}:${l.kind}:${l.text}`}
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
      <Meta className="mt-1.5 block">日志在服务端内存里，最多 500 行，重启就没了。结论那条在「记录」里。</Meta>
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
