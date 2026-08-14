import { useEffect, useState } from "react";
import { Meta } from "../ui/bits";
import { Segment, Segments } from "../ui/segment";
import { Tip } from "../ui/tooltip";
import { DiffView } from "../ui/diff";
import { pull, type Evidence } from "../lib/api";
import { cn, nl } from "../lib/utils";

/**
 * One gutter, both sides, the same as the row above. It was `pl-14 pr-3` for a
 * version — indented to the slice title on the left, hard against the edge on the
 * right — and an asymmetric gutter reads as a mistake even when the reason for it
 * is real. What ties the body to its row is the row's own tint, not an indent.
 */
const PAD = "px-4";

/** QA and the gates write their verdict as prose; `fail` in it is the machine part. */
const failed = (v: { body: string }) => /\bfail\b/i.test(v.body);

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
    void pull<Evidence>(`/api/slices/${sliceId}/evidence`).then((r) => {
      setEv(r);
      // A failed judgement is the reason to look; everything else, the change is.
      setView(r?.verdicts.some(failed) ? "verdicts" : "diff");
    });
  }, [sliceId]);

  if (!ev) return <div className={cn(PAD, "py-2 text-[0.75rem] text-ink-3")}>读改动…</div>;

  const summary = ev.stat.split("\n").filter(Boolean).at(-1)?.trim() ?? "";
  // `5 files changed, 94 insertions(+), 2 deletions(-)` split in two: the file
  // count stays on the pinned line, the line counts go on the switch below it as
  // `+94 −2`. Printing the whole stat in both places is the same three numbers
  // twice, 200px apart.
  const bad = ev.verdicts.some(failed);
  const files = summary.split(",")[0]?.trim() ?? "";
  const plus = Number(summary.match(/(\d+) insertion/)?.[1] ?? 0);
  const minus = Number(summary.match(/(\d+) deletion/)?.[1] ?? 0);

  // Nothing has been recorded against this slice yet, so the card is an
  // acceptance line the lane row above already shows, a diffstat that says 无改动
  // 记录, a one-segment switch, and a paragraph explaining there is no diff. Four
  // ways of saying "not started".
  if (!actions && !ev.diff && !ev.verdicts.length && !ev.gates.length) {
    return <div className={cn(PAD, "py-2 text-[0.75rem] text-ink-3")}>这一片还没跑出改动，也还没有判词。</div>;
  }

  return (
    // Flat, and full width. This opens inside a slice row inside a bordered list,
    // so a rounded panel here was the third box drawn around the same content —
    // DESIGN.md: hairlines and spacing instead of card borders, cards never
    // nested. Rules and the three surfaces carry the structure instead.
    <div>
      {/* What you are being asked to agree to, then the measurements of it, then
          the button. The acceptance line used to be last on a header that opened
          with the panel's own name and a diffstat.

          Pinned for the same reason the lanes above it are: the two buttons are
          the verdict on everything below them, and scrolling down to read the QA
          line and the diff scrolled the buttons — and the acceptance line they
          answer — off the top. */}
      <div className={cn(PAD, "sticky top-0 z-10 border-b border-rule bg-rail py-2.5")}>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
          <span className="min-w-0 text-[0.8125rem] text-ink">{ev.accept_spec}</span>
          {/* The size of the delivery, on the line that says what was delivered.
              It used to hang off the end of the pane switch, where it read as a
              label for `typecheck` and disappeared when you opened a log — but it
              is a fact about the slice, not about which pane is open. */}
          <Meta className="shrink-0">
            {files || "无改动"}
            {ev.diff && ` · +${plus} −${minus}`}
          </Meta>
          {ev.retries > 0 && <Meta className="shrink-0 text-warn">被打回过 {ev.retries} 次</Meta>}
          <span className="grow" />
          {actions}
        </div>

        {/* Just the switch. It was a bordered strip with a byte count on every
            segment, under a header that printed the diffstat a second time — the
            loudest thing in the panel was the pane selector.

            One language across the row: it read 改动 build test typecheck, the
            first in Chinese and the rest in whatever the gates are called in
            config. Gate names come out of config and cannot move, so the others
            joined them rather than three of them getting invented names. */}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          <Segments value={view} onValueChange={setView} className="-ml-2">
            <Segment value="diff">diff</Segment>
            {/* The judgements are a pane, not a block above the panes. Stacked,
                three of them pushed the change they are about off the screen and
                a passing one said nothing the gate ticks on the row had not
                already said — while a failing one is the whole reason to look. */}
            {ev.verdicts.length > 0 && (
              <Segment value="verdicts">
                {/* English, like everything else on this row. 判词 next to build
                    test typecheck was the mixed row again — and the gate names
                    come out of config, so they are the half that cannot move. */}
                <span className={bad ? "text-bad" : undefined}>verdicts {ev.verdicts.length}</span>
              </Segment>
            )}
            {ev.gates.map((g) => (
              <Segment key={g.name} value={g.name}>
                {g.name}
              </Segment>
            ))}
          </Segments>
          {/* Which claim the diff is making. Per-slice while the branch is intact,
              whole-branch after a rebase rewrites it — the boss is accepting one
              of those two things and they are not the same thing. */}
          {ev.scope === "branch" && (
            <Tip label="切片基线被 rebase 冲掉了，这里是整条分支相对 origin/main 的改动">
              <Meta className="cursor-help underline decoration-dotted">整条分支</Meta>
            </Tip>
          )}
        </div>
      </div>

      {view === "verdicts" ? (
        <div className={cn(PAD, "py-1")}>
          {ev.verdicts.map((v, i) => (
            <VerdictRow key={i} author={v.author} body={v.body} />
          ))}
        </div>
      ) : view === "diff" ? (
        !ev.diff ? (
          <div className={cn(PAD, "py-2 text-[0.75rem] text-ink-3")}>
            没有 diff 可读。这一片没有记下基线 commit，或者 worktree 已经清掉了。
          </div>
        ) : (
          // Machine surface: a transcript is a different substance from the
          // sentences above it, and depth says so without another border.
          <div className="h-[34rem] bg-sunk">
            <DiffView diff={ev.diff} truncated={ev.truncated} />
          </div>
        )
      ) : (
        <GateLog key={view} sliceId={sliceId} name={view} />
      )}
    </div>
  );
}

/**
 * One judgement: who, whether it passed, and what they said about it.
 *
 * Three shapes were tried and each failed the same way. `过 | qa | 1800px of
 * prose` set the paragraph to four times a readable measure. Stacking author,
 * verdict and body left the toggle dangling on a line of its own under the text,
 * which reads as a fourth item rather than a control on the third. The toggle
 * belongs with the name, at the other end of the line it governs.
 */
function VerdictRow({ author, body }: { author: string; body: string }) {
  const [open, setOpen] = useState(false);
  const no = failed({ body });
  // Roughly four lines at this measure. Below that the toggle is a control that
  // does nothing visible, which is worse than no toggle.
  const long = body.length > 200;
  return (
    <div className="border-t border-rule-soft py-2.5 first:border-t-0">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[0.6875rem] text-ink-3">{author}</span>
        <span className={cn("text-[0.6875rem] font-semibold", no ? "text-bad" : "text-ok")}>
          {no ? "没过" : "过"}
        </span>
        <span className="grow" />
        {long && (
          <button
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="cursor-pointer font-mono text-[0.6875rem] text-ink-3 hover:text-accent"
          >
            {open ? "收起" : "展开"}
          </button>
        )}
      </div>
      <div
        className={cn(
          "mt-1 max-w-[72ch] whitespace-pre-wrap break-words text-[0.8125rem]",
          no ? "text-bad" : "text-ink-2",
          !open && "line-clamp-3",
        )}
      >
        {nl(body)}
      </div>
    </div>
  );
}

/**
 * The gate's log, whole, in a pane that scrolls.
 *
 * It used to hide the passing lines behind a count — "342 条通过没列出来，搜索会翻到"
 * — on the theory that nobody reads passes. But the pane scrolls locally now, so
 * hiding them buys nothing and costs the one thing a log is for: what ran, in the
 * order it ran. Cutting the log to show it in a box that could have shown the log
 * is the box deciding what the question was.
 *
 * What stays is the verdict up top and a filter, because "find the line that says
 * X" is a real move in a four-thousand-line log.
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

  // Trailing newline is one empty row on a pane whose whole job is to look like
  // the file it came from.
  const lines = (text ?? "").replace(/\s+$/, "").split("\n");
  const fails = lines.filter((l) => /^\s*\(fail\)/.test(l));
  const body = q ? lines.filter((l) => l.toLowerCase().includes(q.toLowerCase())) : lines;

  if (text === null) return <div className={cn(PAD, "py-2 text-[0.75rem] text-ink-3")}>读日志…</div>;
  // An empty log is a sentence, not a pane. The strip plus an empty transcript
  // surface drew three rules and a grey band around the word "nothing".
  if (!lines.some((l) => l.trim())) {
    return <div className={cn(PAD, "py-2 text-[0.75rem] text-ink-3")}>{name} 没有输出。</div>;
  }

  return (
    <div>
      <div className={cn(PAD, "flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-rule py-1.5")}>
        {fails.length > 0 ? (
          <span className="text-[0.75rem] font-semibold text-bad">{fails.length} 条没过</span>
        ) : (
          <span className="text-[0.75rem] font-semibold text-ok">全过</span>
        )}
        <Meta>{lines.length} 行</Meta>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="过滤这份日志…"
          className="ml-auto w-44 rounded-md border border-rule bg-paper px-2 py-0.5 text-[0.6875rem] outline-none focus-visible:border-accent"
        />
      </div>
      {/* Machine output, on the machine surface — same recessed pane as the diff,
          so the eye knows without reading that this half is a transcript and the
          half above it is a judgement.

          `max-h`, not `h`: a typecheck gate that printed one line was drawing a
          34rem field of empty grey under it. */}
      <pre className={cn(PAD, "max-h-[34rem] overflow-auto bg-sunk py-2 font-mono text-[0.6875rem] leading-[1.5] text-ink-2")}>
        {body.length === 0 ? (q ? "没有匹配的行" : "这份日志是空的") : body.map((l, i) => (
          <div key={i} className={cn(/^\s*\(fail\)/.test(l) && "bg-bad-soft", /error|Error/.test(l) && "text-bad")}>
            {l || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}
