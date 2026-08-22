import { toast } from "sonner";
import { notifyWanted } from "./desktop-notify";
import { sayIn, type Said } from "../../../src/contracts/said.ts";
import { saidText } from "./said";
import { z } from "zod";
import { FrameSchema } from "../../../src/contracts/events.ts";

/**
 * The SSE stream, reduced into what the timeline draws.
 *
 * Split out of `api.ts`, which is about HTTP: this is a wire format, a reducer
 * over it, and the browser notification it can raise — none of which is a
 * request. `api.ts` went from 592 lines to 394 by moving it, and the two halves
 * share nothing but `zod`.
 */

/**
 * One SSE payload, as the server sends it.
 *
 * The server's own union, not a hand-written copy and not `any` — which is what
 * this was, on the one function that turns the wire into everything the timeline
 * renders. `stream.ts` adds `projectId` to every frame on the way out, including
 * stored ones whose own type has no such field, so that is the one thing stated
 * here rather than imported.
 */
const WireSchema = FrameSchema.and(z.object({ projectId: z.number().nullable().optional() }));
const NotificationMetaSchema = z.object({ url: z.string().optional(), title: z.string().optional() });
export type Wire = z.infer<typeof WireSchema>;

/**
 * Whether a desktop notification may be raised at all.
 *
 * Two facts, and both have to hold. The browser answers the first and a page
 * cannot argue with it; only the boss answers the second, and until that switch
 * existed the answer was stuck at yes — a granted permission had no way back
 * except the browser's own site settings.
 */
const desktopAllowed = (): boolean =>
  typeof Notification !== "undefined" && Notification.permission === "granted" && notifyWanted() === "on";

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
  /**
   * The stored body, or raw sandbox output — **not** display text.
   *
   * It is named `body` and not `text` because it was `text` and three panes read
   * it as if it were what to draw. Two of them stopped being right the moment
   * the descriptor started travelling beside it, and the compiler is what found
   * them. `frameText` is the one way to a string a person reads.
   */
  body: string;
  /**
   * The sentence the server named, unrendered.
   *
   * Rendered here at ingest once, which froze every timeline row in whichever
   * language was live when its SSE frame arrived — the frames are appended to
   * `useState` and never rebuilt, so switching language left the whole timeline
   * behind. Same defect as a refusal kept on a field, on the surface with the
   * most rows.
   */
  said?: Said;
  agentId?: number | null;
  /** `meta.step`: which step of which process this row is, when it is one of
   *  those. A pane that draws a process reads this instead of matching the
   *  body, which is rendered in whichever language its reader chose. */
  step?: string;
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

/** Untrusted JSON out of `event.meta_json`, so it is parsed rather than cast. */
const StepSchema = z.object({ step: z.string().optional() });

type LiveWire = Extract<Wire, { type: "live" }>;
type EventWire = Extract<Wire, { type: "event" }>;

function appendLive(next: PanelFrame[], f: LiveWire, liveSeq: { current: number }, at: number): PanelFrame[] {
  const cls = f.kind === "text" || f.kind === "thinking" ? "partial" : "tool";
  const last = next[next.length - 1];
  if (cls === "partial" && last?.cls === "partial" && last.agentId === f.agentId) {
    next[next.length - 1] = { ...last, body: (last.body + f.body).slice(-300) };
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
      body: f.body,
      agentId: f.agentId,
    },
  ];
}

function appendEvent(next: PanelFrame[], f: EventWire, at: number): PanelFrame[] {
  // A reconnect can overlap a frame already delivered live. The persisted seq
  // is stable, so the overlap is dropped instead of duplicating a React key.
  const id = `e${f.seq}`;
  if (next.some((x) => x.id === id)) return next;
  const step = StepSchema.safeParse(f.meta).data?.step;
  const sentence = sayIn(f.meta);
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
      // The descriptor travels beside it and the row renders it, so the timeline
      // follows the locale menu rather than the moment the frame arrived.
      body: f.body ?? "",
      ...(sentence ? { said: sentence } : {}),
      ...(step ? { step } : {}),
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
 * The server decides *what* is worth interrupting for — rules, tiers, dedupe and a
 * backoff, all in `notify.ts` — and this is only the last step. Which is why it
 * raises nothing on any other frame: "everything the boss might want to know" is how
 * a notification becomes noise, and the rules upstream exist to avoid that.
 */
/**
 * Replayed frames are skipped by age. The stream replays from a cursor so a
 * reconnecting page can rebuild its timeline, and without this every reconnect would
 * re-announce the last day of alerts.
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

export function raise(f: Notice) {
  const plan = notifyPlan(f, desktopAllowed());
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

/**
 * What this row says, in the language being read now.
 *
 * The one way from a frame to a string a person sees. Rendering at ingest froze
 * every row in whichever catalogue was live when its SSE frame arrived, because
 * frames are appended to `useState` and never rebuilt.
 */
export const frameText = (f: PanelFrame): string => saidText(f.said, f.body);
