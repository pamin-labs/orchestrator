import type { InferResponseType } from "hono/client";
import { useEffect, useMemo, useRef, useTransition } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { GRP_STATES } from "../../../../src/contracts/states.ts";
import { api, groupAction, readApi } from "../../shared/api";
import type { PanelFrame } from "../../shared/stream";
import { clock } from "../../shared/format";
import { cn } from "../../ui/cn";
import { Empty, Meta } from "../../ui/bits";
import { Button } from "../../ui/button";
import { ask } from "../../ui/confirm";
import { Trans, useLingui } from "@lingui/react/macro";

/**
 * What this group's container is, and what it is saying right now.
 *
 * The clone and the install are the first two minutes of a requirement and the
 * longest thing before any work — and until this existed they were two grey dashes
 * and a spinner. A boss watching a group that has not started has one question,
 * "is it stuck", and the answer was in output neither pane showed.
 */
/**
 * A tab on the requirement rather than a sixth peer view: a container belongs to one
 * group, so a top-level 工作区 would open with a list of groups to pick from, asking
 * the boss to re-find what they were just reading. The `Bootstrap` strip is the other
 * half — it interrupts while a rebuild runs, this is where you go to look.
 *
 * The log is in memory, capped and gone on restart — said on the panel rather than
 * implied, because the outcome that matters is already a line in 记录.
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
  const { t } = useLingui();
  const queries = useQueryClient();
  const [busy, startTransition] = useTransition();
  // The group is the key. This was `useState` filled from a bare `.then()`, so
  // moving between two requirements while the first read was in flight put one
  // group's image, spec, branch and TTL under the other group's name — on the
  // one pane whose whole purpose is answering "is *this* container stuck".
  const { data: info = null } = useQuery({
    queryKey: ["sandbox", grpId],
    queryFn: (): Promise<SandboxInfo | null> =>
      readApi(api.sandbox.$get({ query: { grp: String(grpId) } }), SandboxInfoSchema),
  });

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
        <Meta>{info?.sandbox.id ? t`Container running` : t`No container yet`}</Meta>
        {info && (
          <>
            <Fact k={t`Image`} v={info.sandbox.image} />
            <Fact k={t`Spec`} v={`${info.sandbox.cpu || t`Default`} core · ${info.sandbox.memory}`} />
            <Fact k={t`Branch`} v={info.group.branch ?? t`Not checked out`} />
            {info.sandbox.at && <Fact k={t`Started at`} v={clock(info.sandbox.at)} />}
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
              title: t`Restart container`,
              // No duration here: nothing times a rebuild, and clone plus install
              // already says what it costs.
              body: t`Container will be discarded. The next turn will rebuild it: re-clone the branch, reinstall dependencies. Uncommitted changes will be lost.`,
              yes: t`Restart`,
            });
            if (!go) return;
            // The confirm is outside: the transition covers the rebuild and the
            // re-read that proves it happened, not the question.
            startTransition(async () => {
              await groupAction(grpId, "rebuild");
              await queries.invalidateQueries({ queryKey: ["sandbox", grpId] });
            });
          }}
        >
          <Trans>Restart container</Trans>
        </Button>
      </div>

      {info?.sandbox.mounts.length ? (
        <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1">
          {info.sandbox.mounts.map((m) => (
            <Meta key={m.mountPath} title={m.hostPath}>
              {m.mountPath}
              {m.readOnly ? t` read-only` : ""}
            </Meta>
          ))}
        </div>
      ) : null}

      {/* Not `Pane`: this one needs its own ref to stay pinned to the newest
          line, and the scroll rules are the same ones Pane applies. */}
      <div ref={tail} className="min-h-0 flex-1 overflow-y-auto rounded-md border border-rule bg-sunk px-3 py-2">
        {!lines.length ? (
          <Empty>
            <Trans>
              Container hasn't started yet. Clone and dependency installation output will appear here line by line.
            </Trans>
          </Empty>
        ) : (
          lines.map((l) => (
            <div
              key={`${l.at}:${l.kind}:${l.text}`}
              className={cn(
                "whitespace-pre-wrap font-mono text-meta leading-relaxed",
                l.kind === "cmd" ? "text-ink" : l.kind === "end" ? "text-ink-2" : "text-ink-3",
              )}
            >
              {l.text}
            </div>
          ))
        )}
      </div>
      <Meta className="mt-1.5 block">
        <Trans>
          Logs are stored in server memory, max 500 lines, cleared on restart. The conclusion is in "Notes".
        </Trans>
      </Meta>
    </div>
  );
}

/** `$ ` is what the server prefixes a command with; ok / exit N is how one ends. */
const kindOf = (text: string): Line["kind"] =>
  text.startsWith("$ ") ? "cmd" : text === "ok" || /^exit -?\d+$/.test(text) ? "end" : "out";

const Fact = ({ k, v }: { k: string; v: string }) => (
  <span className="flex items-baseline gap-1.5">
    <Meta>{k}</Meta>
    <span className="font-mono text-secondary text-ink-2">{v}</span>
  </span>
);
