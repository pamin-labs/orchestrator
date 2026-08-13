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
  const [openGate, setOpenGate] = useState<string | null>(null);

  useEffect(() => {
    setEv(null);
    void pull<Evidence>(`/api/slices/${sliceId}/evidence`).then(setEv);
  }, [sliceId]);

  if (!ev) return <div className="py-2 text-[0.75rem] text-ink-3">读改动…</div>;

  const summary = ev.stat.split("\n").filter(Boolean).at(-1)?.trim() ?? "";

  return (
    <Card tone="sunk" className="mt-1.5">
      {/* Two lines, because these are two different kinds of fact and they were
          competing on one. What you are being asked to agree to — the acceptance
          line — is the sentence; how big the change is and how many times it came
          back are the measurements. Ordered that way, at those weights. */}
      <CardHeader className="flex-col items-start gap-0.5">
        <span className="text-[0.8125rem] text-ink">{ev.accept_spec}</span>
        <span className="flex flex-wrap items-baseline gap-x-3">
          <Meta>{summary || "无改动记录"}</Meta>
          {ev.retries > 0 && <Meta className="text-warn">被打回过 {ev.retries} 次</Meta>}
        </span>
      </CardHeader>

      {ev.verdicts.length > 0 && (
        <div className="border-b border-rule-soft px-3.5 py-2">
          {ev.verdicts.map((v, i) => {
            const bad = /\bfail\b/i.test(v.body);
            return (
              <div key={i} className="grid grid-cols-[1.5rem_6rem_minmax(0,1fr)] gap-x-2 py-0.5 text-[0.75rem]">
                {/* The verdict, as a mark. It was carried by the colour of the
                    sentence alone, which is the one cue a reader skimming for a
                    fail does not get until they have read the sentence. */}
                <span className={cn("font-mono text-[0.6875rem]", bad ? "text-bad" : "text-ok")}>
                  {bad ? "没过" : "过"}
                </span>
                {/* Wide enough for "orchestrator": at w-16 it ran into the verdict. */}
                <span className="truncate font-mono text-[0.6875rem] text-ink-3">{v.author}</span>
                <span className={cn("min-w-0 break-words", bad ? "text-bad" : "text-ink-2")}>{v.body}</span>
              </div>
            );
          })}
        </div>
      )}

      {ev.gates.length > 0 && (
        <div className="border-b border-rule-soft px-3.5 py-2">
          {/* One log open at a time, and it opens under the whole row rather than
              inside it. The buttons and the panel used to share one flex-wrap
              container, so opening a log rewrapped the buttons around it. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <Meta className="mr-1">闸门日志</Meta>
            {ev.gates.map((g) => (
              <Button
                key={g.name}
                size="sm"
                variant={openGate === g.name ? "go" : "default"}
                onClick={() => setOpenGate(openGate === g.name ? null : g.name)}
              >
                {g.name}
                <span className={cn("font-mono text-[0.625rem]", openGate === g.name ? "opacity-70" : "text-ink-3")}>
                  {Math.round(g.size / 1024)}k
                </span>
              </Button>
            ))}
          </div>
          {openGate && <GateLog key={openGate} sliceId={sliceId} name={openGate} />}
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
function GateLog({ sliceId, name }: { sliceId: number; name: string }) {
  const [text, setText] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [only, setOnly] = useState<"bad" | "all">("bad");

  useEffect(() => {
    setText(null);
    void fetch(`/api/slices/${sliceId}/gate/${name}`).then(async (r) =>
      setText(r.ok ? await r.text() : "读不到日志"),
    );
  }, [sliceId, name]);

  const lines = (text ?? "").split("\n");
  const passes = lines.filter((l) => /^\s*\(pass\)/.test(l));
  const fails = lines.filter((l) => /^\s*\(fail\)/.test(l));
  // Everything that is neither: error bodies, stack lines, tsc diagnostics, the
  // runner's own summary. This is the half that says why.
  const rest = lines.filter((l) => l.trim() && !/^\s*\((pass|fail)\)/.test(l));
  const hit = (l: string) => !q || l.toLowerCase().includes(q.toLowerCase());
  const body = [...fails, ...rest, ...(only === "all" ? passes : [])].filter(hit);

  if (text === null) return <div className="mt-2 text-[0.75rem] text-ink-3">读日志…</div>;

  return (
    <div className="mt-2 overflow-hidden rounded-md border border-rule-soft bg-sunk">
      {/* A filter bar, not three unrelated controls. It was a coloured word, a
          text link that toggled the passes, and a 7rem input pushed to the far
          right — three shapes for one job, and the only one that looked clickable
          was the one that was not. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-rule-soft px-2 py-1.5">
        <div className="flex overflow-hidden rounded-md border border-rule">
          {([["bad", `没过 ${fails.length}`], ["all", `全部 ${lines.filter((l) => l.trim()).length}`]] as const).map(
            ([k, label]) => (
              <button
                key={k}
                onClick={() => setOnly(k)}
                className={cn(
                  "cursor-pointer px-2 py-0.5 text-[0.6875rem] transition-colors",
                  only === k ? "bg-ink text-paper" : "text-ink-3 hover:bg-paper hover:text-ink",
                )}
              >
                {label}
              </button>
            ),
          )}
        </div>
        {fails.length === 0 && <span className="text-[0.6875rem] font-semibold text-ok">全过</span>}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="过滤这份日志…"
          className="ml-auto w-44 rounded-md border border-rule bg-paper px-2 py-0.5 text-[0.6875rem] outline-none focus-visible:border-accent"
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
  );
}
