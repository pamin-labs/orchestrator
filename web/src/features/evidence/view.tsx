import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useClamped } from "../../ui/clamped";
import { api, type Evidence, EvidenceSchema, GateLogResponseSchema, readApi } from "../../shared/api";
import { nl } from "../../shared/prose";
import { cn } from "../../ui/cn";
import { Meta } from "../../ui/bits";
import { Button } from "../../ui/button";
import { DiffView } from "../diff/view";
import { Segment, Segments } from "../../ui/segment";
import { Tip } from "../../ui/tooltip";
import { VirtualList } from "../../ui/virtual-list";
import { Trans, useLingui } from "@lingui/react/macro";
import { t } from "@lingui/core/macro";

const PAD = "px-4";
const failed = (verdict: { body: string }) => /\bfail\b/i.test(verdict.body);
const defaultView = (evidence?: Evidence | null) => (evidence?.verdicts.some(failed) ? "verdicts" : "diff");

/**
 * One slice's evidence, identified by the slice it belongs to.
 *
 * This was `useState` filled from a bare `.then()` in an effect — no ignore flag,
 * no `AbortController` — so clicking one slice then a faster one left the first
 * read in flight, and it wrote its `accept_spec`, its diff and its verdicts into
 * the panel already showing the second. The slice id is part of the query key now,
 * which is the whole fix: a reply is filed under the slice that asked for it.
 */
/**
 * The key is deliberately not under the `["orch"]` prefix the stream invalidates.
 * Evidence is read when a slice is opened, exactly as before; putting it in that
 * prefix would re-read a diff on every `state_change` frame in the system.
 */
export function EvidencePanel({ sliceId, actions }: { sliceId: number; actions?: React.ReactNode }) {
  const { data: evidence } = useQuery({
    queryKey: ["evidence", sliceId],
    queryFn: () => readApi(api.slices[":id"].evidence.$get({ param: { id: String(sliceId) } }), EvidenceSchema),
  });
  if (!evidence)
    return (
      <Message>
        <Trans>Loading changes…</Trans>
      </Message>
    );
  // Keyed by the slice: which tab opens is decided from that slice's verdicts,
  // so a different slice starts from its own default rather than inheriting the
  // tab the reader happened to leave the last one on.
  return <EvidenceViews key={sliceId} evidence={evidence} sliceId={sliceId} actions={actions} />;
}

function EvidenceViews({
  evidence,
  sliceId,
  actions,
}: {
  evidence: Evidence;
  sliceId: number;
  actions?: React.ReactNode;
}) {
  const [view, setView] = useState(() => defaultView(evidence));
  return <EvidenceContent evidence={evidence} view={view} setView={setView} sliceId={sliceId} actions={actions} />;
}

const Message = ({ children }: { children: React.ReactNode }) => (
  <div className={cn(PAD, "py-2 text-secondary text-ink-3")}>{children}</div>
);
const hasEvidence = (evidence: Evidence) => Boolean(evidence.diff || evidence.verdicts.length || evidence.gates.length);

function statSummary(stat: string): string {
  return (
    stat
      .split("\n")
      .findLast((line) => line.length > 0)
      ?.trim() ?? ""
  );
}

const statCount = (summary: string, pattern: RegExp) => Number(summary.match(pattern)?.[1] ?? 0);

function EvidenceContent({
  evidence,
  view,
  setView,
  sliceId,
  actions,
}: {
  evidence: Evidence;
  view: string;
  setView: (view: string) => void;
  sliceId: number;
  actions?: React.ReactNode;
}) {
  if (!actions && !hasEvidence(evidence))
    return (
      <Message>
        <Trans>This slice hasn't produced changes yet and has no verdict.</Trans>
      </Message>
    );
  const summary = statSummary(evidence.stat);
  const stats = {
    files: statCount(summary, /(\d+) files? changed/),
    plus: statCount(summary, /(\d+) insertion/),
    minus: statCount(summary, /(\d+) deletion/),
  };
  return (
    <div>
      <EvidenceHeader evidence={evidence} stats={stats} view={view} setView={setView} actions={actions} />
      <EvidenceBody evidence={evidence} view={view} sliceId={sliceId} />
    </div>
  );
}

function EvidenceHeader({
  evidence,
  stats,
  view,
  setView,
  actions,
}: {
  evidence: Evidence;
  stats: { files: number; plus: number; minus: number };
  view: string;
  setView: (view: string) => void;
  actions?: React.ReactNode;
}) {
  const { t } = useLingui();
  // Destructured so the macro names the placeholder off the binding: `${files}`
  // extracts as `{files}`, where `${stats.files}` would be `{0}`.
  const { files } = stats;
  return (
    <div className={cn(PAD, "sticky top-0 z-10 border-b border-rule bg-rail py-2.5")}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
        <span className="min-w-0 text-body text-ink">{evidence.accept_spec}</span>
        <Meta className="shrink-0">
          {files ? t`${files} files` : t`No changes`}
          {evidence.diff && ` · +${stats.plus} −${stats.minus}`}
        </Meta>
        {evidence.retries > 0 && (
          <Meta className="shrink-0 text-warn">
            <Trans>sent back {{ times: evidence.retries }} times</Trans>
          </Meta>
        )}
        <span className="grow" />
        {actions}
      </div>
      <EvidenceTabs evidence={evidence} view={view} setView={setView} />
    </div>
  );
}

function EvidenceTabs({
  evidence,
  view,
  setView,
}: {
  evidence: Evidence;
  view: string;
  setView: (view: string) => void;
}) {
  const { t } = useLingui();
  const bad = evidence.verdicts.some(failed);
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
      <Segments value={view} onValueChange={setView} className="-ml-2">
        {evidence.verdicts.length > 0 && (
          <Segment value="verdicts">
            <span className={bad ? "text-bad" : undefined}>verdicts {evidence.verdicts.length}</span>
          </Segment>
        )}
        <Segment value="diff">diff</Segment>
        {evidence.gates.map((gate) => (
          <Segment key={gate.name} value={gate.name}>
            {gate.name}
          </Segment>
        ))}
      </Segments>
      {evidence.scope === "branch" && (
        <Tip label={t`Slice baseline was lost in rebase; showing the entire branch relative to origin/main`}>
          <Meta className="cursor-help underline decoration-dotted">
            <Trans>Entire branch</Trans>
          </Meta>
        </Tip>
      )}
    </div>
  );
}

function EvidenceBody({ evidence, view, sliceId }: { evidence: Evidence; view: string; sliceId: number }) {
  if (view === "verdicts") return <Verdicts rows={evidence.verdicts} />;
  if (view !== "diff") return <GateLog key={view} sliceId={sliceId} name={view} />;
  if (!evidence.diff)
    return (
      <Message>
        <Trans>No diff available. The slice didn't record a baseline commit, or the sandbox has been reclaimed.</Trans>
      </Message>
    );
  return (
    <div className="h-[34rem] bg-sunk">
      <DiffView diff={evidence.diff} truncated={evidence.truncated} />
    </div>
  );
}

function Verdicts({ rows }: { rows: Evidence["verdicts"] }) {
  return (
    <div className={cn(PAD, "py-1")}>
      {rows.map((row) => (
        <VerdictRow key={`${row.author}:${row.body}`} author={row.author} body={row.body} />
      ))}
    </div>
  );
}

const verdictTone = (no: boolean) => (no ? "text-bad" : "text-ok");
const verdictLabel = (no: boolean) => (no ? t`Fail` : t`Pass`);
const toggleLabel = (open: boolean) => (open ? t`Collapse` : t`Expand`);

function VerdictRow({ author, body }: { author: string; body: string }) {
  const [open, setOpen] = useState(false);
  const [ref, clamped] = useClamped<HTMLDivElement>(`${body}:${open}`);
  const no = failed({ body });
  return (
    <div className="border-t border-rule-soft py-2.5 first:border-t-0">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-meta text-ink-3">{author}</span>
        <span className={cn("text-meta font-semibold", verdictTone(no))}>{verdictLabel(no)}</span>
        <span className="grow" />
        {(clamped || open) && (
          <Button variant="quiet" size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>
            {toggleLabel(open)}
          </Button>
        )}
      </div>
      <div
        ref={ref}
        className={cn(
          "mt-1 max-w-[72ch] whitespace-pre-wrap break-words text-body",
          no ? "text-bad" : "text-ink-2",
          !open && "line-clamp-3",
        )}
      >
        {nl(body)}
      </div>
    </div>
  );
}

const logLines = (text: string) => text.replace(/\s+$/, "").split("\n");

function filterLines(lines: string[], query: string): string[] {
  if (!query) return lines;
  const needle = query.toLowerCase();
  return lines.filter((line) => line.toLowerCase().includes(needle));
}

/** The same race one level down: two gate tabs in a row, answered out of order. */
function GateLog({ sliceId, name }: { sliceId: number; name: string }) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const { data: text } = useQuery({
    queryKey: ["gate", sliceId, name],
    queryFn: async () =>
      (
        await readApi(
          api.slices[":id"].gate[":name"].$get({ param: { id: String(sliceId), name }, query: {} }),
          GateLogResponseSchema,
        )
      )?.text ?? t`Can't read log`,
  });
  if (text === undefined)
    return (
      <Message>
        <Trans>Loading log…</Trans>
      </Message>
    );
  const lines = logLines(text);
  if (!lines.some((line) => line.trim())) return <Message>{t`${name} produced no output.`}</Message>;
  const fails = lines.filter((line) => /^\s*\(fail\)/.test(line));
  return (
    <div>
      <GateToolbar fails={fails.length} lines={lines.length} query={query} setQuery={setQuery} />
      <GateTranscript lines={filterLines(lines, query)} query={query} />
    </div>
  );
}

function GateToolbar({
  fails,
  lines,
  query,
  setQuery,
}: {
  fails: number;
  lines: number;
  query: string;
  setQuery: (query: string) => void;
}) {
  const { t } = useLingui();
  return (
    <div className={cn(PAD, "flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-rule py-1.5")}>
      <span className={cn("text-secondary font-semibold", fails ? "text-bad" : "text-ok")}>
        {fails ? t`${fails} failed` : t`All pass`}
      </span>
      <Meta>{t`${lines} lines`}</Meta>
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        aria-label={t`Filter this log`}
        placeholder={t`Filter this log…`}
        className="ml-auto w-44 rounded-md border border-rule bg-paper px-2 py-0.5 text-meta outline-none focus-visible:border-accent"
      />
    </div>
  );
}

function keyed(values: string[]): Array<{ key: string; value: string }> {
  const seen = new Map<string, number>();
  return values.map((value) => {
    const occurrence = seen.get(value) ?? 0;
    seen.set(value, occurrence + 1);
    return { key: `${value}:${occurrence}`, value };
  });
}

/**
 * The longest list in the panel, and the one that pays for windowing.
 *
 * `src/api/orch/review.ts` caps a gate log at 4000 lines and a `bun test` run
 * reaches it, so this drew four thousand nodes — and `filterLines` runs on every
 * keystroke of the box above, which redrew all of them per character.
 */
/**
 * The rows do not wrap (`whitespace-pre`, as the `<pre>` gave them), so
 * `leading-[1.5]` over `--text-meta: 0.6875rem` is the row height rather than an
 * estimate to be corrected.
 */
function GateTranscript({ lines, query }: { lines: string[]; query: string }) {
  const { t } = useLingui();
  if (!lines.length) return <LogPane>{query ? t`No matching lines` : t`This log is empty`}</LogPane>;
  return (
    <VirtualList items={keyed(lines)} estimate={LOG_LINE_PX} keyOf={(line) => line.key} className={cn(PAD, LOG_CLASS)}>
      {({ value }) => <LogLine value={value} />}
    </VirtualList>
  );
}

const LOG_LINE_PX = 17;
const LOG_CLASS = "max-h-[34rem] bg-sunk py-2 font-mono text-meta leading-[1.5] text-ink-2";
const LogPane = ({ children }: { children: React.ReactNode }) => (
  <pre className={cn(PAD, LOG_CLASS, "overflow-auto")}>{children}</pre>
);

function LogLine({ value }: { value: string }) {
  return (
    <div
      className={cn(
        "whitespace-pre",
        /^\s*\(fail\)/.test(value) && "bg-bad-soft",
        /error|Error/.test(value) && "text-bad",
      )}
    >
      {value || " "}
    </div>
  );
}
