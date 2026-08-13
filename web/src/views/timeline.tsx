import type { Frame, State } from "../lib/api";
import { cn, clock } from "../lib/utils";

/**
 * A timeline, not a log.
 *
 * What gets read here is who said what to whom; tool calls and state changes are
 * context around that, so agent-to-agent talk is the only kind with full ink.
 * Scope follows the selection: a requirement when one is open, else the project.
 * A feed that ignores where the boss is looking is a wall of unrelated lines.
 */
export function Timeline({
  st, frames, grpId, projectId,
}: {
  st: State; frames: Frame[]; grpId: number | null; projectId: number | null;
}) {
  let ids: Set<number> | null = null;
  let label = "全部";
  if (grpId) {
    ids = new Set([grpId]);
    label = st.groups.find((g) => g.id === grpId)?.name ?? "";
  } else if (projectId) {
    ids = new Set(st.groups.filter((g) => g.project_id === projectId).map((g) => g.id));
    label = st.projects.find((p) => p.id === projectId)?.name ?? "";
  }

  // Frames with no group are kept: usually a standing Architect or CoS answering,
  // which is exactly the exchange being looked for.
  const shown = frames.filter((f) => !ids || f.grpId == null || ids.has(f.grpId)).slice(-160).reverse();

  return (
    <div>
      <h2 className="mb-3 text-[0.625rem] font-semibold uppercase tracking-[0.13em] text-ink-3">
        事件流 · {label}
      </h2>
      {!shown.length && <div className="text-[0.75rem] text-ink-3">无事件</div>}
      <div className="max-h-[calc(100vh-11rem)] overflow-y-auto overscroll-contain">
        {shown.map((f, i) => {
          const prev = shown[i - 1];
          const same = prev && prev.author === f.author && prev.at - f.at < 60_000;
          return (
            <div
              key={`${f.at}-${i}`}
              className={cn(
                "fade-in grid grid-cols-[2.5rem_minmax(0,1fr)] gap-2 py-1 text-[0.75rem]",
                !same && i > 0 && "border-t border-rule-soft",
              )}
            >
              <span className="pt-px font-mono text-[0.625rem] text-ink-3">{same ? "" : clock(f.at)}</span>
              <div className="min-w-0">
                {!same && (
                  <>
                    <span className={cn("font-semibold", f.author === "boss" && "text-accent")}>{f.author}</span>
                    {f.target && <span className="text-ink-3"> → {f.target}</span>}
                    {f.intent && f.intent !== "inform" && (
                      <span className="ml-1 font-mono text-[0.5625rem] uppercase tracking-[0.06em] text-ink-3">
                        {f.intent}
                      </span>
                    )}{" "}
                  </>
                )}
                <span
                  className={cn(
                    "break-words",
                    f.cls === "say" && "text-ink",
                    f.cls === "state" && "text-ok",
                    f.cls === "ask" && "text-warn",
                    (f.cls === "tool" || f.cls === "partial") && "font-mono text-[0.6875rem] text-ink-3",
                  )}
                >
                  {f.text}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
