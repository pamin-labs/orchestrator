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

/**
 * The gate's log, read the way anyone actually reads one.
 *
 * It was a `<pre>` of 29k characters: four hundred `(pass) … [0.08ms]` lines with
 * the one failure somewhere inside. Nobody opens a gate log to read the passes —
 * they open it to find what broke, and scrolling for it is the whole cost.
 *
 * So: counts first, failures and their error lines shown, passes collapsed behind
 * their own number, and a filter for the case where the failure is not the point.
 * Same idea as the diff viewer next door — structure the thing instead of dumping
 * it, and put colour on the row rather than the text.
 */
function GateLog({ sliceId, name, size }: { sliceId: number; name: string; size: number }) {
  const [text, setText] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [showPass, setShowPass] = useState(false);

  const lines = (text ?? "").split("\n");
  const passes = lines.filter((l) => /^\s*\(pass\)/.test(l));
  const fails = lines.filter((l) => /^\s*\(fail\)/.test(l));
  // Everything that is neither: error bodies, stack lines, tsc diagnostics, the
  // runner's own summary. This is the half that says why.
  const rest = lines.filter((l) => l.trim() && !/^\s*\((pass|fail)\)/.test(l));
  const hit = (l: string) => !q || l.toLowerCase().includes(q.toLowerCase());
  const body = [...fails, ...rest, ...(showPass ? passes : [])].filter(hit);

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
        <div className="mt-1 w-full rounded-md bg-sunk">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-rule-soft px-2 py-1">
            {fails.length > 0 ? (
              <span className="text-[0.6875rem] font-semibold text-bad">{fails.length} 条没过</span>
            ) : (
              <span className="text-[0.6875rem] font-semibold text-ok">全过</span>
            )}
            {passes.length > 0 && (
              <button
                className="cursor-pointer text-[0.6875rem] text-ink-3 hover:text-accent"
                onClick={() => setShowPass(!showPass)}
              >
                {passes.length} 条通过 {showPass ? "收起" : "展开"}
              </button>
            )}
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="过滤"
              className="ml-auto w-28 rounded border border-rule bg-paper px-1.5 py-0.5 text-[0.6875rem] outline-none focus-visible:border-accent"
            />
          </div>
          <pre className="max-h-64 overflow-auto p-2 font-mono text-[0.6875rem] leading-[1.5] text-ink-2">
            {body.length === 0 ? "没有匹配的行" : body.map((l, i) => (
              <div key={i} className={cn(/^\s*\(fail\)/.test(l) && "bg-bad-soft", /error|Error/.test(l) && "text-bad")}>
                {l || " "}
              </div>
            ))}
          </pre>
        </div>
      )}
    </>
  );
}
