import { useEffect, useRef, useState } from "react";
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

/** Validators reply with the reason, so the reason is what gets shown. */
export async function post(path: string, body?: unknown) {
  const r = await fetch(path, {
    method: "POST",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) toast.error(text, { duration: 12_000 });
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

export function useOrch() {
  const [state, setState] = useState<State>(EMPTY);
  const [cost, setCost] = useState<Cost | null>(null);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [live, setLive] = useState<"connecting" | "live" | "retry">("connecting");
  const started = useRef(false);
  const liveSeq = useRef(0);
  // The last project asked for, so a refresh that does not name one does not
  // silently widen the scope. Every SSE event called refresh() with no argument,
  // which swapped 成本 from this project to every project the moment anything
  // happened — and the page still said 这个项目累计.
  const lastProject = useRef<number | null>(null);

  const refresh = async (projectId?: number | null) => {
    if (projectId !== undefined) lastProject.current = projectId;
    const p = projectId ?? lastProject.current;
    const [s, c] = await Promise.all([
      fetch("/api/state"),
      // The nav says 成本 is this project's, so ask for this project's.
      fetch(p ? `/api/cost?project=${p}` : "/api/cost"),
    ]);
    setState((await s.json()) as State);
    setCost((await c.json()) as Cost);
  };

  /**
   * Re-read state and cost, at most once every 250ms.
   *
   * Ten groups moving at once is ten `state_change` frames inside a second, and
   * every one of them used to call `refresh()` — twenty requests to answer a
   * question that has one answer. Trailing rather than leading: the last frame
   * of a burst is the one whose state we want to end up showing.
   */
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nudge = () => {
    if (pending.current) return;
    pending.current = setTimeout(() => {
      pending.current = null;
      void refresh();
    }, 250);
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void refresh().then(() => {
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
    });
  }, []);

  // A slow heartbeat, because some of the state has no event behind it.
  // Subscription usage is refreshed on the watchdog's clock and writes no bus
  // frame, so on a quiet system the header kept showing a reading — or a failure —
  // from however long ago the last unrelated event happened to be. Only while the
  // tab is visible: a backgrounded panel refreshing all night is traffic nobody
  // asked for, and it is re-fetched on the way back anyway.
  useEffect(() => {
    const tick = () => document.visibilityState === "visible" && void refresh();
    const id = setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  return { state, cost, frames, live, refresh };
}
