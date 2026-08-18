import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { z } from "zod";
import type { Json } from "../../../src/contracts/json.ts";
import { hc, type InferResponseType } from "hono/client";
import type { ApiType, TelemetryReport } from "../../../src/http/routes/panel.ts";
import { displayJson, readJsonResponse, TextResponseSchema } from "../../../src/contracts/protocol.ts";

/**
 * The payload types, from the server that produces them.
 *
 * These were seventy-two lines of hand-written interfaces re-describing shapes
 * `snapshot()` and `costReport()` already declare — two copies of one truth,
 * neither checked against the other, and the browser's copy was the one that
 * would keep claiming a field was a `string` after a migration renamed the
 * column out from under it.
 *
 * Hono RPC supplies route, param, query and request-body types. Zod still parses
 * responses at runtime: a compile-time contract cannot validate bytes returned
 * by an older or broken server.
 */
import { CostReportSchema, type CostReport } from "../../../src/contracts/cost.ts";
import {
  SnapshotSchema,
  type Agent,
  type Archived,
  type Escalation,
  type Group,
  type Slice,
  type Snapshot,
} from "../../../src/contracts/panel.ts";
import { FrameSchema } from "../../../src/contracts/events.ts";

export type { Agent, Archived, Escalation, Group, Slice };
export type State = Snapshot;
export type Usage = State["usage"][number];
export type Cost = CostReport;
export type AgentCost = CostReport["agents"][number];

/**
 * What every browser request carries: a request id for the log line, and — on
 * anything that is not a safe method — an idempotency key, for the one decision
 * that cannot be taken back.
 */
export function requestHeaders(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
  const method = input instanceof Request ? input.method : (init?.method ?? "GET");
  headers.set("X-Request-ID", crypto.randomUUID());
  if (!["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) {
    headers.set("Idempotency-Key", crypto.randomUUID());
  }
  return headers;
}

const browserFetch: typeof fetch = Object.assign(
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    // fallow-ignore-next-line security-sink -- the only caller is the hono client below, bound to the relative base `/api/v1`, so every request this wrapper sees is same-origin by construction; it adds headers and chooses no destination.
    fetch(input, { ...init, headers: requestHeaders(input, init) }),
  { preconnect: fetch.preconnect },
);

export const api = hc<ApiType>("/api/v1", { fetch: browserFetch });

export const EvidenceSchema: z.ZodType<InferResponseType<(typeof api.slices)[":id"]["evidence"]["$get"], 200>> =
  z.object({
    grp_id: z.number(),
    seq: z.number(),
    title: z.string(),
    accept_spec: z.string(),
    base_sha: z.string().nullable(),
    retries: z.number(),
    stat: z.string(),
    diff: z.string(),
    truncated: z.boolean(),
    scope: z.enum(["slice", "branch"]),
    verdicts: z.array(z.object({ author: z.string(), body: z.string(), at: z.number() })),
    gates: z.array(z.object({ name: z.string(), path: z.string(), size: z.number() })),
  });
export type Evidence = z.infer<typeof EvidenceSchema>;

/**
 * Where a scope's wall clock went — the one read that is not on the RPC client.
 *
 * `/telemetry` is registered outside the chain that produces `ApiType`, because
 * one more route in that inferred type is what tips `hc<ApiType>` over the
 * length TypeScript will serialise; `src/http/routes/panel.ts` says so at the
 * registration. So the URL and the query are built here by hand, in one place,
 * rather than in each of the three views that read it.
 *
 * The response contract survives that: `TelemetryReport` is imported type-only
 * from the route module — which is what the `web` boundary allows from
 * `public-rpc` — and the schema below is annotated with it, so a field the
 * server renames stops compiling here rather than parsing to `undefined` at
 * runtime. Zod still parses the bytes, for the same reason it does everywhere
 * else: a compile-time contract cannot validate what an older server sent.
 */
const StageStatSchema = z.object({
  name: z.string(),
  count: z.number(),
  totalMs: z.number(),
  p50: z.number(),
  p95: z.number(),
  errors: z.number(),
});

export const TelemetryReportSchema: z.ZodType<TelemetryReport> = z.object({
  scope: z.enum(["group", "project", "system"]),
  windowMs: z.number(),
  window: z.object({ from: z.number(), to: z.number() }),
  dataWindow: z.object({ from: z.number(), to: z.number() }).nullable(),
  stages: z.array(StageStatSchema),
  traces: z.array(
    z.object({
      traceId: z.string(),
      name: z.string(),
      startedAt: z.number(),
      durationMs: z.number(),
      failed: z.boolean(),
    }),
  ),
  trend: z.array(z.object({ at: z.number(), count: z.number(), p50: z.number(), p95: z.number() })),
  flame: z.array(z.object({ path: z.string(), totalMs: z.number(), count: z.number() })),
  slices: z.array(
    z.object({
      sliceId: z.number().nullable(),
      totalMs: z.number(),
      count: z.number(),
      errors: z.number(),
    }),
  ),
  trace: z
    .object({
      traceId: z.string(),
      spans: z.array(
        z.object({
          spanId: z.string(),
          parentSpanId: z.string().nullable(),
          name: z.string(),
          startedAt: z.number(),
          durationMs: z.number(),
          status: z.enum(["unset", "ok", "error"]),
        }),
      ),
    })
    .nullable(),
});

export type Telemetry = TelemetryReport;
export type Stage = TelemetryReport["stages"][number];
export type TraceRow = TelemetryReport["traces"][number];
export type Folded = TelemetryReport["flame"][number];
export type Trend = TelemetryReport["trend"][number];

/** Which work to report on: one requirement, one project, or the host itself. */
export type TelemetryScope = { kind: "group" | "project"; id: number } | { kind: "system" };

/**
 * The query string, built once.
 *
 * `system` deliberately sends no `id` — the server refuses a scope that carries
 * both, so a caller that passed one anyway would get a 400 rather than quietly
 * having it ignored.
 */
function telemetryQuery(
  scope: TelemetryScope,
  windowMs?: number,
  chosen?: { from: number; to: number } | null,
  bucketMs?: number,
): string {
  const query = new URLSearchParams({ scope: scope.kind });
  if (scope.kind !== "system") query.set("id", String(scope.id));
  if (windowMs) query.set("windowMs", String(windowMs));
  // An explicit range wins over the duration, and the server says so too. This
  // is what lets a brush select the middle rather than only shorten from now.
  if (chosen) {
    query.set("from", String(Math.round(chosen.from)));
    query.set("to", String(Math.round(chosen.to)));
  }
  // Sent every time rather than only when pinned: the derived value follows the
  // window, so the server would otherwise keep its fixed hour while the reader
  // zoomed past it — which is the bug that emptied the chart.
  if (bucketMs) query.set("bucketMs", String(Math.round(bucketMs)));
  return query.toString();
}

export function readTelemetry(
  scope: TelemetryScope,
  windowMs?: number,
  chosen?: { from: number; to: number } | null,
  bucketMs?: number,
): Promise<Telemetry | null> {
  const url = `/api/v1/telemetry?${telemetryQuery(scope, windowMs, chosen, bucketMs)}`;
  // fallow-ignore-next-line security-sink -- a relative same-origin path built from an enum and two numbers; there is no destination here for a caller to choose.
  return readApi(fetch(url, { headers: requestHeaders(url) }), TelemetryReportSchema);
}

const EMPTY: State = {
  // Assume wired until told otherwise: a mark on the header before the first
  // poll lands would flash on every reload.
  ready: true,
  projects: [],
  groups: [],
  slices: [],
  tasks: [],
  agents: [],
  escalations: [],
  channels: [],
  draftCards: [],
  lateObjections: [],
  approvedBlocked: [],
  dropProposals: [],
  ideas: [],
  answered: [],
  mergeQueue: [],
  archived: [],
  usage: [],
  limits: { maxGroups: null, leaseSlots: {}, autoAdvance: false, autoAcceptTiers: [] },
  lastSeq: 0,
};

/** Fresh panel state for behavior tests and isolated consumers. */
export const emptyState = (): State => structuredClone(EMPTY);

/** GET that surfaces its own failure. Used for the on-demand panels (evidence, logs). */
export async function readApi<S extends z.ZodType>(request: Promise<Response>, schema: S): Promise<z.output<S> | null> {
  const r = await request;
  const result = await readJson(r, schema);
  if (!result.ok) {
    toast.error(result.text, { duration: 8000 });
    return null;
  }
  return result.data;
}

export type ApiResult<T> = { ok: true; data: T; text: string } | { ok: false; data: null; text: string };

export async function readJson<S extends z.ZodType>(r: Response, schema: S): Promise<ApiResult<z.output<S>>> {
  const body = await readJsonResponse(r);
  if (!body.ok) return { ok: false, data: null, text: "Server returned a non-JSON response" };
  if (!r.ok) return { ok: false, data: null, text: displayJson(body.data) };
  const parsed = schema.safeParse(body.data);
  if (!parsed.success) {
    return { ok: false, data: null, text: `Server returned invalid JSON: ${z.prettifyError(parsed.error)}` };
  }
  return { ok: true, data: parsed.data, text: displayJson(body.data) };
}

const JsonBody = z.record(z.string(), z.json());

export const GateLogResponseSchema: z.ZodType<
  InferResponseType<(typeof api.slices)[":id"]["gate"][":name"]["$get"], 200>
> = TextResponseSchema;
export const AnswerDraftSchema: z.ZodType<InferResponseType<(typeof api.escalations)[":id"]["draft"]["$get"], 200>> =
  TextResponseSchema;

/**
 * Validators reply with the reason, so the reason is what gets shown.
 *
 * `quiet` is for the callers that put the reason on the field it belongs to —
 * the settings rows do, and a toast on top of an already-marked row is the same
 * refusal said twice, in the corner, where it outlives the fix.
 */
export async function mutate(request: Promise<Response>, quiet?: boolean): Promise<ApiResult<Json>>;
export async function mutate<S extends z.ZodType>(
  request: Promise<Response>,
  quiet: boolean,
  schema: S,
): Promise<ApiResult<z.output<S>>>;
export async function mutate(request: Promise<Response>, quiet = false, schema: z.ZodType = JsonBody) {
  const r = await request;
  const result = await readJson(r, schema);
  if (!result.ok && !quiet) toast.error(result.text, { duration: 12_000 });
  return result;
}

export type GroupActionRequest = NonNullable<Parameters<(typeof api.groups)[":id"][":action"]["$post"]>[0]>;
export const groupAction = (
  id: number,
  action: GroupActionRequest["param"]["action"],
  json: GroupActionRequest["json"] = {},
) => mutate(api.groups[":id"][":action"].$post({ param: { id: String(id), action }, json }));

export type SliceDecisionRequest = NonNullable<Parameters<(typeof api.slices)[":id"][":decision"]["$post"]>[0]>;
export const sliceDecision = (
  id: number,
  decision: SliceDecisionRequest["param"]["decision"],
  json: SliceDecisionRequest["json"] = {},
) => mutate(api.slices[":id"][":decision"].$post({ param: { id: String(id), decision }, json }));

/**
 * One SSE payload, as the server sends it.
 *
 * The server's own union, not a hand-written copy and not `any` — which is what
 * this was, on the one function that turns the wire into everything the timeline
 * renders. `stream.ts` adds `projectId` to every frame on the way out, including
 * the stored ones whose own type has no such field, so that is the one thing
 * stated here rather than imported.
 *
 * `import type` is erased at build time; no server code reaches the browser
 * bundle. Same rule as `State` above.
 */
const WireSchema = FrameSchema.and(z.object({ projectId: z.number().nullable().optional() }));
const NotificationMetaSchema = z.object({ url: z.string().optional(), title: z.string().optional() });
export type Wire = z.infer<typeof WireSchema>;

/** One SSE payload, or null for anything this panel cannot use — a half-written
 *  line from a restarting server included. A stream that says something we do
 *  not understand is not a reason to tear down the timeline. */
export function readWire(data: unknown): Wire | null {
  try {
    const parsed = WireSchema.safeParse(JSON.parse(String(data)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface PanelFrame {
  /** Stable across renders and SSE reconnects, so the timeline can key on it
   *  instead of array position. Persisted events use their bus seq (`e<seq>`);
   *  live-only frames use a client-side counter (`l<n>`) — separate domains so
   *  a replayed seq can never collide with a live frame minted before it. A
   *  reconnect replay that produces the same id is deduped by appendFrame, so
   *  this id is also unique within the frame array at any given time. */
  id: string;
  cls: "say" | "ask" | "state" | "tool" | "partial";
  grpId: number | null;
  projectId: number | null;
  at: number;
  author: string;
  target?: string | null;
  intent?: string | null;
  text: string;
  agentId?: number | null;
}

const KIND: Record<string, PanelFrame["cls"]> = {
  say: "say",
  boss_say: "say",
  note: "say",
  escalation: "ask",
  state_change: "state",
  gate_result: "state",
  commit: "state",
  tool_summary: "tool",
  digest: "tool",
};

type LiveWire = Extract<Wire, { type: "live" }>;
type EventWire = Extract<Wire, { type: "event" }>;

function appendLive(next: PanelFrame[], f: LiveWire, liveSeq: { current: number }, at: number): PanelFrame[] {
  const cls = f.kind === "text" || f.kind === "thinking" ? "partial" : "tool";
  const last = next[next.length - 1];
  if (cls === "partial" && last?.cls === "partial" && last.agentId === f.agentId) {
    next[next.length - 1] = { ...last, text: (last.text + f.body).slice(-300) };
    return next;
  }
  return [
    ...next,
    {
      id: `l${++liveSeq.current}`,
      cls,
      grpId: f.grpId,
      projectId: f.projectId ?? null,
      at,
      author: f.role ?? "agent",
      text: f.body,
      agentId: f.agentId,
    },
  ];
}

function appendEvent(next: PanelFrame[], f: EventWire, at: number): PanelFrame[] {
  // A reconnect can overlap a frame already delivered live. The persisted seq
  // is stable, so the overlap is dropped instead of duplicating a React key.
  const id = `e${f.seq}`;
  if (next.some((x) => x.id === id)) return next;
  return [
    ...next,
    {
      id,
      cls: KIND[f.kind] ?? "say",
      grpId: f.grpId ?? null,
      projectId: f.projectId ?? null,
      at,
      author: f.author,
      ...(f.target !== undefined ? { target: f.target } : {}),
      ...(f.intent !== undefined ? { intent: f.intent } : {}),
      // Stored event bodies are optional; timeline text is not. Keep a broken
      // producer visible as a blank row instead of weakening PanelFrame's type.
      text: f.body ?? "",
    },
  ];
}

/** Appends one raw SSE payload to the frame buffer, assigning it a stable id.
 *  A partial frame that continues the last live entry (same agent, still
 *  streaming) reuses that entry's id and mutates it in place — otherwise the
 *  row being streamed into would remount on every token. `liveSeq` is an
 *  external counter so it survives across calls without living in React state. */
export function appendFrame(prev: PanelFrame[], f: Wire, liveSeq: { current: number }): PanelFrame[] {
  const at = f.at ?? Date.now();
  const next = prev.slice(-600);
  return f.type === "live" ? appendLive(next, f, liveSeq, at) : appendEvent(next, f, at);
}

/** Derives each row's render props from a newest-first frame list. Pulled out
 *  as a pure function so the stability that lets a memoized row component
 *  bail out — unrelated rows keep the same `f` reference and the same
 *  booleans across a re-render — is checkable without mounting React.
 *  `showDivider` deliberately ignores position (no "am I first" check): a
 *  positional check would make the old top row's props change every time a
 *  new frame arrives, even when its own grouping never changed. The row that
 *  ends up first in the DOM has its divider suppressed by CSS instead. */
export function groupedRows(shown: PanelFrame[]): { f: PanelFrame; showHeader: boolean; showDivider: boolean }[] {
  return shown.map((f, i) => {
    const prev = shown[i - 1];
    const same = Boolean(prev) && prev!.author === f.author && prev!.at - f.at < 60_000;
    return { f, showHeader: !same, showDivider: !same };
  });
}

/**
 * A `notify` frame, as a real system notification.
 *
 * The server decides *what* is worth interrupting for — rules, tiers, dedupe and
 * a backoff, all in `notify.ts` — and this is only the last step. Which is why
 * it raises nothing on any other frame: "everything the boss might want to know"
 * is how a notification becomes noise, and the rules upstream exist precisely to
 * avoid that.
 *
 * Replayed frames are skipped by age. The stream replays from a cursor so a
 * reconnecting page can rebuild its timeline, and without this every reconnect
 * would re-announce the last day of alerts.
 */
export interface Notice {
  body: string;
  at?: number | undefined;
  meta?: z.infer<typeof NotificationMetaSchema> | undefined;
}

/** The notification a frame asks for, or null when it asks for none. */
export function notifyFrom(f: Wire): Notice | null {
  if (f.kind !== "notify") return null;
  const meta = NotificationMetaSchema.safeParse(f.meta);
  return { body: f.body ?? "", at: f.at, ...(meta.success ? { meta: meta.data } : {}) };
}

export type NotifyPlan =
  | { show: "none" }
  | { show: "toast"; body: string }
  | { show: "notify"; title: string; body: string; tag: string; hash: string | null };

/** Whether this one is worth interrupting for, and in which of the two ways. */
export function notifyPlan(f: Notice, granted: boolean): NotifyPlan {
  if (f.at && Date.now() - f.at >= 60_000) return { show: "none" };
  // No permission is not an error: the tab title still carries the count, and
  // a toast says it while the page is being looked at.
  if (!granted) return { show: "toast", body: f.body };
  // The deep link is a hash on this same page, so assigning it navigates
  // without a reload — the panel the boss is being called back to is already
  // running, with its stream open.
  const url = f.meta?.url;
  return {
    show: "notify",
    title: f.meta?.title || "orchestrator",
    body: f.body,
    tag: f.body.slice(0, 40),
    hash: url ? url.slice(url.indexOf("#") + 1) : null,
  };
}

function raise(f: Notice) {
  const plan = notifyPlan(f, typeof Notification !== "undefined" && Notification.permission === "granted");
  if (plan.show === "none") return;
  if (plan.show === "toast") {
    toast(plan.body);
    return;
  }
  const n = new Notification(plan.title, { body: plan.body, tag: plan.tag });
  n.onclick = () => {
    window.focus();
    if (plan.hash) location.hash = plan.hash;
    n.close();
  };
}

const get = async <S extends z.ZodType>(request: Promise<Response>, schema: S): Promise<z.output<S>> => {
  const result = await readJson(await request, schema);
  if (!result.ok) throw new Error(result.text);
  return result.data;
};

/**
 * The prefix the stream is allowed to invalidate.
 *
 * A bare `invalidateQueries()` reaches every query in the page, and the settings
 * dialog's `preflight` is one of them — that read shells out to check the host.
 * Ten `state_change` frames with the dialog open would run the host checks ten
 * times to answer a question nothing asked. The stream knows about these two.
 */
const ORCH = ["orch"];

/**
 * The two reads the whole panel is built on, plus the stream that invalidates them.
 *
 * The project scope used to be a ref. Every SSE event called `refresh()` with no
 * argument, which swapped 成本 from this project to every project the moment
 * anything happened — while the page still said 这个项目累计 — so a `lastProject`
 * ref was added to remember it. It is a query key now: the scope is *in* the
 * identity of the cached answer, so there is no version of this where a reply
 * for one project can land under another's heading.
 *
 * The heartbeat and the `visibilitychange` listener are gone the same way.
 * `refetchInterval` already pauses when the tab is hidden and `refetchOnWindowFocus`
 * re-reads on the way back — which is exactly what the hand-written pair did, and
 * was the reason it existed: subscription usage moves on the watchdog's clock and
 * writes no bus frame, so on a quiet system the header showed a reading from
 * however long ago the last unrelated event happened to be.
 */
export function useOrch() {
  const queries = useQueryClient();
  const [project, setProject] = useState<number | null>(null);
  const [frames, setFrames] = useState<PanelFrame[]>([]);
  const [live, setLive] = useState<"connecting" | "live" | "retry">("connecting");
  const started = useRef(false);
  const liveSeq = useRef(0);

  const state = useQuery({
    queryKey: ORCH.concat("state"),
    queryFn: () => get(api.state.$get(), SnapshotSchema),
    initialData: EMPTY,
    refetchInterval: 60_000,
  });
  const cost = useQuery({
    // The nav says 成本 is this project's, so ask for this project's.
    queryKey: ORCH.concat("cost", String(project)),
    queryFn: () => get(api.cost.$get({ query: project ? { project: String(project) } : {} }), CostReportSchema),
    refetchInterval: 60_000,
  });

  /**
   * Re-read state and cost, at most once every 250ms.
   *
   * The debounce stays even with a cache in front: TanStack collapses two
   * *in-flight* requests for one key, and this is the other case — ten groups
   * moving at once is ten `state_change` frames inside a second, each one
   * arriving after the last request already came back. Trailing rather than
   * leading: the last frame of a burst is the one whose state we want to show.
   */
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nudge = useCallback(() => {
    if (pending.current) return;
    pending.current = setTimeout(() => {
      pending.current = null;
      void queries.invalidateQueries({ queryKey: ORCH });
    }, 250);
  }, [queries]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // Replay a short tail so the timeline has content on load: exactly lastSeq
    // would be correct and useless, sitting empty until something moved.
    const es = new EventSource("/api/v1/stream?since=0");
    es.onopen = () => setLive("live");
    es.onerror = () => setLive("retry");
    es.onmessage = (m) => {
      const f = readWire(m.data);
      if (!f) return;
      const notice = notifyFrom(f);
      if (notice) return raise(notice);
      setFrames((prev) => appendFrame(prev, f, liveSeq));
      if (["state_change", "escalation", "note"].includes(f.kind)) nudge();
    };
  }, [nudge]);

  const refresh = useCallback(
    (projectId?: number | null) => {
      if (projectId !== undefined) setProject(projectId);
      void queries.invalidateQueries({ queryKey: ORCH });
    },
    [queries],
  );
  return { state: state.data, cost: cost.data ?? null, frames, live, refresh };
}
