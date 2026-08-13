import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

export interface Project { id: number; name: string; repo_path: string; remote: string | null }
export interface Group {
  id: number; project_id: number; name: string; branch: string | null; worktree: string | null;
  status: string; owns_json: string; budget_tokens: number; spent_tokens: number; spent_usd: number;
  pr_number: number | null;
}
export interface Slice {
  id: number; grp_id: number; seq: number; title: string; accept_spec: string; difficulty: string;
  status: string; gates_json: string; spent_tokens: number; spent_usd: number;
}
export interface Task { id: number; grp_id: number; slice_id: number | null; title: string; status: string }
export interface Agent {
  id: number; grp_id: number | null; role: string; model: string; clearance: string; state: string;
  activity: string | null; session_tokens: number; total_tokens: number; total_usd: number;
}
export interface Escalation {
  id: number; grp_id: number | null; severity: string; question: string; chain_state: string;
  answered_by: string | null; answer: string | null; created_at: number; asker: string | null;
}
export interface State {
  projects: Project[]; groups: Group[]; slices: Slice[]; tasks: Task[]; agents: Agent[];
  escalations: Escalation[]; draftCards: { grpId: number; body: string }[];
  lateObjections: { grpId: number; author: string; body: string }[];
  ideas: { grpId: number; body: string }[];
  answered: { id: number; grp_id: number; question: string; answer: string; answered_by: string; ref_note_id: number | null }[];
  mergeQueue: { projectId: number; grpId: number; name: string; branch: string | null; seq: number }[];
  lastSeq: number;
}
export interface CostRow { label: string; tokens: number; usd: number }
export interface Cost {
  total: CostRow; byGroup: CostRow[]; byRole: CostRow[]; byDifficulty: CostRow[]; cacheRatio: number | null;
}

const EMPTY: State = {
  projects: [], groups: [], slices: [], tasks: [], agents: [], escalations: [],
  draftCards: [], lateObjections: [], ideas: [], answered: [], mergeQueue: [], lastSeq: 0,
};

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
  cls: "say" | "ask" | "state" | "tool" | "partial";
  grpId: number | null;
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

export function useOrch() {
  const [state, setState] = useState<State>(EMPTY);
  const [cost, setCost] = useState<Cost | null>(null);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [live, setLive] = useState<"connecting" | "live" | "retry">("connecting");
  const started = useRef(false);

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
        const at = f.at ?? Date.now();
        setFrames((prev) => {
          const next = prev.slice(-600);
          if (f.type === "live") {
            const cls = f.kind === "text" || f.kind === "thinking" ? "partial" : "tool";
            const last = next[next.length - 1];
            if (cls === "partial" && last?.cls === "partial" && last.agentId === f.agentId) {
              next[next.length - 1] = { ...last, text: (last.text + f.body).slice(-300) };
              return next;
            }
            return [...next, { cls, grpId: f.grpId ?? null, at, author: f.role ?? "agent", text: f.body, agentId: f.agentId }];
          }
          return [...next, {
            cls: KIND[f.kind] ?? "say", grpId: f.grpId ?? null, at, author: f.author,
            target: f.target, intent: f.intent, text: f.body,
          }];
        });
        if (["state_change", "escalation", "note"].includes(f.kind)) void refresh();
      };
    });
  }, []);

  return { state, cost, frames, live, refresh };
}
