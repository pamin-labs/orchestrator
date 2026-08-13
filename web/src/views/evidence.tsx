import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { Meta } from "../ui/bits";
import { Card, CardHeader } from "../ui/card";
import { DiffView } from "../ui/diff";
import { pull, type Evidence } from "../lib/api";
import { cn } from "../lib/utils";

/**
 * The evidence behind one slice, in the order a reviewer reads it.
 *
 * Accepting is one of the boss's three approval points and it was being asked for
 * on a title and an acceptance line — the same two lines already approved on the
 * DRAFT card. QA's verdict comes first because it is the one judgement in the
 * pipeline that is not deterministic, so it is the one worth disagreeing with; the
 * diff is underneath it because "is this what I asked for" is answered by reading
 * the change, not by trusting the summary of it.
 */
export function EvidencePanel({ sliceId }: { sliceId: number }) {
  const [ev, setEv] = useState<Evidence | null>(null);

  useEffect(() => {
    setEv(null);
    void pull<Evidence>(`/api/slices/${sliceId}/evidence`).then(setEv);
  }, [sliceId]);

  if (!ev) return <div className="py-2 text-[0.75rem] text-ink-3">读改动…</div>;

  const summary = ev.stat.split("\n").filter(Boolean).at(-1)?.trim() ?? "";

  return (
    <Card tone="sunk" className="mt-1.5">
      <CardHeader>
        <b className="text-[0.75rem] font-semibold">验收依据</b>
        <Meta>{summary || "无改动记录"}</Meta>
        {ev.retries > 0 && <Meta className="text-warn">被打回过 {ev.retries} 次</Meta>}
        <span className="grow" />
        <Meta>{ev.accept_spec}</Meta>
      </CardHeader>

      {ev.verdicts.length > 0 && (
        <div className="border-b border-rule-soft px-3.5 py-2">
          {ev.verdicts.map((v, i) => {
            const bad = /\bfail\b/i.test(v.body);
            return (
              <div key={i} className="flex gap-2.5 py-px text-[0.75rem]">
                {/* Wide enough for "orchestrator": at w-16 it ran into the verdict. */}
                <span className="w-24 shrink-0 truncate font-mono text-[0.6875rem] text-ink-3">{v.author}</span>
                <span className={cn("min-w-0 break-words", bad ? "text-bad" : "text-ink-2")}>{v.body}</span>
              </div>
            );
          })}
        </div>
      )}

      {ev.gates.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-rule-soft px-3.5 py-2">
          <Meta>闸门日志</Meta>
          {ev.gates.map((g) => (
            <GateLog key={g.name} sliceId={sliceId} name={g.name} size={g.size} />
          ))}
        </div>
      )}

      {!ev.diff ? (
        <div className="px-3.5 py-2 text-[0.75rem] text-ink-3">
          没有 diff 可读。这一片没有记下基线 commit，或者 worktree 已经清掉了。
        </div>
      ) : (
        <div className="h-[34rem]">
          <DiffView diff={ev.diff} truncated={ev.truncated} />
        </div>
      )}
    </Card>
  );
}

/** The gate already wrote its log to disk; this is the only thing that ever read it. */
function GateLog({ sliceId, name, size }: { sliceId: number; name: string; size: number }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <>
      <Button
        variant="quiet"
        size="sm"
        onClick={async () => {
          if (text !== null) return setText(null);
          const r = await fetch(`/api/slices/${sliceId}/gate/${name}`);
          setText(r.ok ? await r.text() : "读不到日志");
        }}
      >
        {name} <span className="font-mono text-[0.625rem] text-ink-3">{Math.round(size / 1024)}k</span>
      </Button>
      {text !== null && (
        <pre className="mt-1 max-h-64 w-full overflow-auto rounded-md bg-sunk p-2 font-mono text-[0.6875rem] leading-[1.5] text-ink-2">
          {text}
        </pre>
      )}
    </>
  );
}
