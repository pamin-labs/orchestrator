import { useEffect, useState } from "react";
import { Meta } from "../ui/bits";
import { Segment, Segments } from "../ui/segment";
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
export function EvidencePanel({ sliceId, actions }: { sliceId: number; actions?: React.ReactNode }) {
  const [ev, setEv] = useState<Evidence | null>(null);
  const [view, setView] = useState("diff");

  useEffect(() => {
    setEv(null);
    setView("diff");
    void pull<Evidence>(`/api/slices/${sliceId}/evidence`).then(setEv);
  }, [sliceId]);

  if (!ev) return <div className="py-2 text-[0.75rem] text-ink-3">读改动…</div>;

  const summary = ev.stat.split("\n").filter(Boolean).at(-1)?.trim() ?? "";

  return (
    <Card tone="sunk" className="mt-1.5">
      {/* What you are being asked to agree to, then the measurements of it, then
          the button. The acceptance line used to be last on a header that opened
          with the panel's own name and a diffstat. */}
      <CardHeader className="gap-y-1.5">
        <span className="min-w-0">
          <span className="block text-[0.8125rem] text-ink">{ev.accept_spec}</span>
          <span className="flex flex-wrap items-baseline gap-x-3">
            <Meta>{summary || "无改动记录"}</Meta>
            {ev.retries > 0 && <Meta className="text-warn">被打回过 {ev.retries} 次</Meta>}
          </span>
        </span>
        <span className="grow" />
        {actions}
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

      {/* The diff and the gate logs are the same kind of thing — the machine's
          record of what happened — and they were stacked, so reading a log meant
          scrolling past a 3000-line diff to reach it and scrolling back. One
          switch, one pane. Not a tab strip: this page already has one, and a
          second under it stops reading as navigation. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-rule-soft px-3.5 py-2">
        <Segments value={view} onValueChange={setView}>
          <Segment value="diff">改动</Segment>
          {ev.gates.map((g) => (
            <Segment key={g.name} value={g.name} count={`${Math.round(g.size / 1024)}k`}>
              {g.name}
            </Segment>
          ))}
        </Segments>
      </div>

      {view === "diff" ? (
        !ev.diff ? (
          <div className="px-3.5 py-2 text-[0.75rem] text-ink-3">
            没有 diff 可读。这一片没有记下基线 commit，或者 worktree 已经清掉了。
          </div>
        ) : (
          <div className="h-[34rem]">
            <DiffView diff={ev.diff} truncated={ev.truncated} />
          </div>
        )
      ) : (
        <div className="px-3.5 pb-3 pt-1">
          <GateLog key={view} sliceId={sliceId} name={view} />
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
  // Nobody opens a gate log to read the passes, so they are not in the default
  // view — but a search is someone looking for a specific line, and refusing to
  // look in 373 of them because they passed is the filter deciding what the
  // question was. Typing searches everything; empty shows what broke.
  const body = q
    ? lines.filter((l) => l.toLowerCase().includes(q.toLowerCase()))
    : [...fails, ...rest];

  if (text === null) return <div className="mt-2 text-[0.75rem] text-ink-3">读日志…</div>;

  return (
    <div className="overflow-hidden rounded-md border border-rule-soft bg-sunk">
      {/* One verdict and one field. A 没过/全部 segment sat here for a version: on a
          passing gate it read 没过 0 / 全部 373, which is two buttons offering to
          filter for nothing and to show you 373 lines of the word "pass". */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-rule-soft px-2 py-1.5">
        {fails.length > 0 ? (
          <span className="text-[0.6875rem] font-semibold text-bad">{fails.length} 条没过</span>
        ) : (
          <span className="text-[0.6875rem] font-semibold text-ok">全过</span>
        )}
        <span className="text-[0.6875rem] text-ink-3">{passes.length} 条通过没列出来，搜索会翻到</span>
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
