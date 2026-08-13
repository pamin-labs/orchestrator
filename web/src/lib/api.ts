import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

export interface Project { id: number; name: string; repo_path: string; remote: string | null }
export interface Group {
  id: number; project_id: number; name: string; branch: string | null; worktree: string | null;
  status: string; owns_json: string; budget_tokens: number; spent_tokens: number; spent_usd: number;
  pr_number: number | null;
  /** The boss approved, but a boundary is holding it. Cleared when it starts. */
  approved_at: number | null;
}
export interface Slice {
  id: number; grp_id: number; seq: number; title: string; accept_spec: string; difficulty: string;
  status: string; gates_json: string; spent_tokens: number; spent_usd: number;
  /** When it started waiting on the boss. The clock on 白干的单位. */
  awaiting_at: number | null;
}
export interface Task { id: number; grp_id: number; slice_id: number | null; title: string; status: string }
export interface Agent {
  id: number; grp_id: number | null; role: string; model: string; clearance: string; state: string;
  activity: string | null; session_tokens: number; total_tokens: number; total_usd: number;
  turns: number; slice_id: number | null;
}
export interface Archived {
  id: number; project_id: number; name: string; branch: string | null; pr_number: number | null;
  spent_usd: number; slices: number; at: number | null;
}
/** What was actually built, for the one decision that cannot be taken back. */
export interface Evidence {
  seq: number; title: string; accept_spec: string; retries: number;
  stat: string; diff: string; truncated: boolean;
  verdicts: { author: string; body: string; at: number }[];
  gates: { name: string; path: string; size: number }[];
}
export interface Escalation {
  id: number; grp_id: number | null; severity: string; question: string; chain_state: string;
  answered_by: string | null; answer: string | null; created_at: number; asker: string | null;
  /** Which project the asker belongs to. A standing agent has no group, so this is
      the only thing that tells one project's question from another's. */
  asker_project: number | null;
}
export interface State {
  projects: Project[]; groups: Group[]; slices: Slice[]; tasks: Task[]; agents: Agent[];
  escalations: Escalation[];
  /** unknownPaths: paths the card names that are not in the repo — new files, or a plan written from memory. */
  draftCards: { grpId: number; body: string; at: number; unknownPaths?: string | null }[];
  lateObjections: { grpId: number; author: string; body: string }[];
  approvedBlocked: { grpId: number; reason: string }[];
  /** A planner's checked claim that this requirement is already covered. */
  dropProposals: { grpId: number; body: string }[];
  ideas: { grpId: number; body: string }[];
  answered: { id: number; grp_id: number; question: string; answer: string; answered_by: string; ref_note_id: number | null }[];
  mergeQueue: { projectId: number; grpId: number; name: string; branch: string | null; seq: number }[];
  archived: Archived[];
  limits: { maxGroups: number | null; leaseSlots: number | null; autoAdvance: boolean; autoAcceptTiers: string[] };
  lastSeq: number;
}
export interface CostRow { label: string; tokens: number; usd: number }
export interface Cost {
  total: CostRow;
  byGroup: (CostRow & { grpId: number })[];
  /** Per role, with the requirement it was hired into. null = standing. */
  roles: (CostRow & { grpId: number | null })[];
  byRole: CostRow[];
  byDifficulty: CostRow[];
  cacheRatio: number | null;
  delivered: { count: number; usd: number };
}

const EMPTY: State = {
  projects: [], groups: [], slices: [], tasks: [], agents: [], escalations: [],
  draftCards: [], lateObjections: [], approvedBlocked: [], dropProposals: [],
  ideas: [], answered: [], mergeQueue: [], archived: [],
  limits: { maxGroups: null, leaseSlots: null, autoAdvance: false, autoAcceptTiers: [] }, lastSeq: 0,
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

export function useOrch() {
  const [state, setState] = useState<State>(EMPTY);
  const [cost, setCost] = useState<Cost | null>(null);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [live, setLive] = useState<"connecting" | "live" | "retry">("connecting");
  const started = useRef(false);
  const liveSeq = useRef(0);

  const refresh = async (projectId?: number | null) => {
    const [s, c] = await Promise.all([
      fetch("/api/state"),
      // The nav says 成本 is this project's, so ask for this project's.
      fetch(projectId ? `/api/cost?project=${projectId}` : "/api/cost"),
    ]);
    setState((await s.json()) as State);
    setCost((await c.json()) as Cost);
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
        setFrames((prev) => appendFrame(prev, f, liveSeq));
        if (["state_change", "escalation", "note"].includes(f.kind)) void refresh();
      };
    });
  }, []);

  return { state, cost, frames, live, refresh };
}
