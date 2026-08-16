import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

/**
 * The payload types, from the server that produces them.
 *
 * These were seventy-two lines of hand-written interfaces re-describing shapes
 * `snapshot()` and `costReport()` already declare — two copies of one truth,
 * neither checked against the other, and the browser's copy was the one that
 * would keep claiming a field was a `string` after a migration renamed the
 * column out from under it.
 *
 * `import type` is erased at build time, so nothing server-side reaches the
 * bundle: `test/smoke.test.ts` and the bundle's own contents are the check on
 * that. Hono's RPC (`hc<typeof app>`) is the fuller version of this idea and is
 * not used here on purpose — it needs handlers to be Hono-native and return
 * `c.json()`, and these return a bare `Response` so that every one of them can
 * be called from a test with four ordinary arguments and no server.
 */
import type { snapshot } from "../../../src/api/panel/snapshot.ts";
import type { CostReport, CostRow as ServerCostRow, AgentCost as ServerAgentCost } from "../../../src/mech/ops/cost.ts";
import type {
  Agent, Archived, Escalation, Group, Project, Slice, Task,
} from "../../../src/api/panel/shapes.ts";

export type { Agent, Archived, Escalation, Group, Project, Slice, Task };
export type State = ReturnType<typeof snapshot>;
export type Usage = State["usage"][number];
export type Cost = CostReport;
export type CostRow = ServerCostRow;
export type AgentCost = ServerAgentCost;

/** What was actually built, for the one decision that cannot be taken back. */
export interface Evidence {
  seq: number; title: string; accept_spec: string; retries: number;
  stat: string; diff: string; truncated: boolean;
  /** `slice` = since this slice started. `branch` = the whole branch against
      origin/main, which is what a rebase leaves recoverable. */
  scope: "slice" | "branch";
  verdicts: { author: string; body: string; at: number }[];
  gates: { name: string; path: string; size: number }[];
}

const EMPTY: State = {
  // Assume wired until told otherwise: a mark on the header before the first
  // poll lands would flash on every reload.
  ready: true,
  projects: [], groups: [], slices: [], tasks: [], agents: [], escalations: [], channels: [],
  draftCards: [], lateObjections: [], approvedBlocked: [], dropProposals: [],
  ideas: [], answered: [], mergeQueue: [], archived: [], usage: [],
  limits: { maxGroups: null, leaseSlots: {}, autoAdvance: false, autoAcceptTiers: [] }, lastSeq: 0,
};

/** GET that surfaces its own failure. Used for the on-demand panels (evidence, logs). */
export async function pull<T>(path: string): Promise<T | null> {
  const r = await fetch(path);
  if (!r.ok) {
    toast.error(await r.text(), { duration: 8000 });
    return null;
  }
  return (await r.json()) as T;
}

/**
 * Validators reply with the reason, so the reason is what gets shown.
 *
 * `quiet` is for the callers that put the reason on the field it belongs to —
 * the settings rows do, and a toast on top of an already-marked row is the same
 * refusal said twice, in the corner, where it outlives the fix.
 */
export async function post(path: string, body?: unknown, quiet = false) {
  const r = await fetch(path, {
    method: "POST",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok && !quiet) toast.error(text, { duration: 12_000 });
  return { ok: r.ok, text };
}

/** The one destructive verb. Same error surfacing as `post`. */
export async function del(path: string) {
  const r = await fetch(path, { method: "DELETE" });
  const text = await r.text();
  if (!r.ok) toast.error(text, { duration: 12_000 });
  return { ok: r.ok, text };
}

export interface Frame {
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

const KIND: Record<string, Frame["cls"]> = {
  say: "say", boss_say: "say", note: "say", escalation: "ask", state_change: "state",
  gate_result: "state", commit: "state", tool_summary: "tool", digest: "tool",
};

/** Appends one raw SSE payload to the frame buffer, assigning it a stable id.
 *  A partial frame that continues the last live entry (same agent, still
 *  streaming) reuses that entry's id and mutates it in place — otherwise the
 *  row being streamed into would remount on every token. `liveSeq` is an
 *  external counter so it survives across calls without living in React state. */
export function appendFrame(prev: Frame[], f: any, liveSeq: { current: number }): Frame[] {
  const at = f.at ?? Date.now();
  const next = prev.slice(-600);
  if (f.type === "live") {
    const cls = f.kind === "text" || f.kind === "thinking" ? "partial" : "tool";
    const last = next[next.length - 1];
    if (cls === "partial" && last?.cls === "partial" && last.agentId === f.agentId) {
      next[next.length - 1] = { ...last, text: (last.text + f.body).slice(-300) };
      return next;
    }
    return [...next, {
      id: `l${++liveSeq.current}`,
      cls, grpId: f.grpId ?? null, projectId: f.projectId ?? null, at,
      author: f.role ?? "agent", text: f.body, agentId: f.agentId,
    }];
  }
  // /api/stream?since=0 never advances, so a native EventSource reconnect
  // replays the whole history through this same path — the id is stable but
  // the frame is not new. Appending it again would put two rows with the same
  // React key in the array, so a repeat is dropped instead.
  const id = `e${f.seq}`;
  if (next.some((x) => x.id === id)) return next;
  return [...next, {
    id,
    cls: KIND[f.kind] ?? "say", grpId: f.grpId ?? null, projectId: f.projectId ?? null, at,
    author: f.author, target: f.target, intent: f.intent, text: f.body,
  }];
}

/** Derives each row's render props from a newest-first frame list. Pulled out
 *  as a pure function so the stability that lets a memoized row component
 *  bail out — unrelated rows keep the same `f` reference and the same
 *  booleans across a re-render — is checkable without mounting React.
 *  `showDivider` deliberately ignores position (no "am I first" check): a
 *  positional check would make the old top row's props change every time a
 *  new frame arrives, even when its own grouping never changed. The row that
 *  ends up first in the DOM has its divider suppressed by CSS instead. */
export function groupedRows(shown: Frame[]): { f: Frame; showHeader: boolean; showDivider: boolean }[] {
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
function raise(f: { body: string; at?: number; meta?: { url?: string; title?: string } }) {
  const fresh = !f.at || Date.now() - f.at < 60_000;
  if (!fresh) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") {
    // No permission is not an error: the tab title still carries the count, and
    // a toast says it while the page is being looked at.
    toast(f.body);
    return;
  }
  const n = new Notification(f.meta?.title || "orchestrator", { body: f.body, tag: f.body.slice(0, 40) });
  n.onclick = () => {
    window.focus();
    // The deep link is a hash on this same page, so assigning it navigates
    // without a reload — the panel the boss is being called back to is already
    // running, with its stream open.
    const url = f.meta?.url;
    if (url) location.hash = url.slice(url.indexOf("#") + 1);
    n.close();
  };
}

const get = <T,>(path: string) => fetch(path).then((r) => r.json() as Promise<T>);

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
  const [frames, setFrames] = useState<Frame[]>([]);
  const [live, setLive] = useState<"connecting" | "live" | "retry">("connecting");
  const started = useRef(false);
  const liveSeq = useRef(0);

  const state = useQuery({
    queryKey: ORCH.concat("state"),
    queryFn: () => get<State>("/api/state"),
    initialData: EMPTY,
    refetchInterval: 60_000,
  });
  const cost = useQuery({
    // The nav says 成本 is this project's, so ask for this project's.
    queryKey: ORCH.concat("cost", String(project)),
    queryFn: () => get<Cost>(project ? `/api/cost?project=${project}` : "/api/cost"),
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
  const nudge = () => {
    if (pending.current) return;
    pending.current = setTimeout(() => {
      pending.current = null;
      void queries.invalidateQueries({ queryKey: ORCH });
    }, 250);
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // Replay a short tail so the timeline has content on load: exactly lastSeq
    // would be correct and useless, sitting empty until something moved.
    const es = new EventSource("/api/stream?since=0");
    es.onopen = () => setLive("live");
    es.onerror = () => setLive("retry");
    es.onmessage = (m) => {
      const f = JSON.parse(m.data);
      if (f.kind === "notify") return void raise(f);
      setFrames((prev) => appendFrame(prev, f, liveSeq));
      if (["state_change", "escalation", "note"].includes(f.kind)) nudge();
    };
  }, []);

  const refresh = (projectId?: number | null) => {
    if (projectId !== undefined) setProject(projectId);
    void queries.invalidateQueries({ queryKey: ORCH });
  };
  return { state: state.data, cost: cost.data ?? null, frames, live, refresh };
}
