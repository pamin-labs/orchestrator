import * as Collapsible from "@radix-ui/react-collapsible";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { Empty, Meta, Pane } from "../../ui/bits";
import { Button } from "../../ui/button";
import { Badge } from "../../ui/badge";
import { Bar } from "../../ui/table";
import { Tab, TabList, TabPanel, Tabs } from "../../ui/tabs";
import { Tip } from "../../ui/tooltip";
import { BurnChart, SplitDonut } from "./chart";
import type { Agent, AgentCost, Cost, Slice, State } from "../../shared/api";
import type { PanelFrame } from "../../shared/stream";
import { owns } from "../../shared/select";
import { K } from "../../shared/format";
import { cn } from "../../ui/cn";
import { activityOf } from "../../shared/activity";
import { Trans, useLingui } from "@lingui/react/macro";
import { ph, t } from "@lingui/core/macro";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { labelOf } from "../../shared/select";

/**
 * Per docs/project/plan.md §8: current slice, turn count, the live last line, model, spend.
 *
 * The turn count and the last line are what separate a working agent from a stuck
 * one — "in_progress" looks identical either way, and turn 19 on one slice is the
 * shape of a loop. Both come free: the count is a query, the line is the SSE
 * stream the page is already holding, so nothing here costs an agent a token.
 */
export function Desk({ st, frames, projectId }: { st: State; frames: PanelFrame[]; projectId: number }) {
  const { t } = useLingui();
  const ids = new Set(st.groups.filter((g) => g.project_id === projectId).map((g) => g.id));
  const rows = st.agents.filter((a) => !a.grp_id || ids.has(a.grp_id));
  const [idle, setIdle] = useState(false);
  if (!rows.length) {
    return (
      <Empty>
        <Trans>No one working yet. Approve a plan card and each agent's current task appears here.</Trans>
      </Empty>
    );
  }
  // Newest live frame per agent: the tail of what it is printing right now.
  const last = new Map<number, string>();
  for (const f of frames) {
    if (f.agentId != null && (f.cls === "partial" || f.cls === "tool")) last.set(f.agentId, f.text);
  }
  const running = rows.filter((a) => a.state === "running");
  const shown = idle ? rows : running.length ? running : rows;

  // Grouped by requirement, like everything else: nine columns across every agent
  // in the project was one table asking to be read four ways at once. A
  // requirement with someone running opens by itself, because "who is working" is
  // still the question this view answers first.
  const groups = [...new Set(shown.map((a) => a.grp_id))]
    .map((id) => ({
      id,
      name: id == null ? t`Standing post` : (st.groups.find((g) => g.id === id)?.name ?? `#${id}`),
      agents: shown.filter((a) => a.grp_id === id),
    }))
    .sort((a, b) => {
      const run = (x: typeof a) => x.agents.filter((y) => y.state === "running").length;
      return run(b) - run(a) || (a.id ?? 1e9) - (b.id ?? 1e9);
    });

  // Named locals, because a placeholder is named after the expression that fills
  // it: `running.length` reaches a translator as `{0}`, which is a translator
  // guessing.
  const runningCount = running.length;
  const total = rows.length;
  const idleCount = rows.length - running.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
        <h2 className="text-secondary font-semibold tracking-[0.02em] text-ink-2">
          <Trans>Desk</Trans>
        </h2>
        <Meta>
          <Trans>
            {runningCount} running · {total} total
          </Trans>
        </Meta>
        <span className="grow" />
        {running.length > 0 && rows.length > running.length && (
          <Button variant="quiet" size="sm" onClick={() => setIdle((v) => !v)}>
            {idle ? t`Only running` : t`Show the idle ones too (${idleCount})`}
          </Button>
        )}
      </div>
      <Pane>
        {/* Two of the four columns were bare numbers. `5` and `8.3M` in a row with
            no heading are a quiz: the tooltip explaining them is on a different
            element, and nobody hovers a number they cannot read. The header is
            sticky because the pane scrolls and a heading that scrolls away stops
            being a heading. */}
        <div className={cn(DESK_ROW, "sticky top-0 z-10 border-b border-rule bg-paper pb-1.5 text-meta text-ink-3")}>
          <span>
            <Trans>Who · Model</Trans>
          </span>
          <span>
            <Trans>What</Trans>
          </span>
          <span className="text-right">turn</span>
          <span className="text-right max-[52rem]:hidden">tokens</span>
        </div>
        {groups.map((g) => (
          <Desks key={String(g.id)} name={g.name} agents={g.agents} slices={st.slices} tail={last} />
        ))}
        {!idle && running.length > 0 && rows.length > running.length && (
          <div className="mt-3 text-secondary text-ink-3">
            <Trans>{idleCount} more are idle and costing nothing.</Trans>
          </div>
        )}
      </Pane>
    </div>
  );
}

const DESK_ROW =
  "grid grid-cols-[11rem_minmax(0,1fr)_2.5rem_4rem] items-baseline gap-x-4 px-3 max-[52rem]:grid-cols-[9rem_minmax(0,1fr)_2.5rem]";

function agentRowModel(agent: Agent, slices: Slice[], tail: Map<number, string>) {
  const slice = slices.find((candidate) => candidate.id === agent.slice_id);
  const [verb, detail] = activityOf(agent);
  const latest = tail.get(agent.id);
  return {
    slice,
    verb,
    detail,
    stream: latest && !detail.includes(latest.slice(-40)) ? latest : null,
    rowClass: agent.state === "running" ? "text-ink" : "text-ink-3 opacity-70",
    model: agent.model.replace(/^claude-|-\d{8}$/g, ""),
    activity: agent.activity ?? agent.state,
    turns: agent.turns || "",
    tokens: agent.total_tokens ? K(agent.total_tokens) : "",
    warn: agent.turns >= 15,
  };
}

function Desks({
  name,
  agents,
  slices,
  tail,
}: {
  name: string;
  agents: Agent[];
  slices: Slice[];
  tail: Map<number, string>;
}) {
  const { t } = useLingui();
  const runners = agents.filter((a) => a.state === "running").length;
  const [open, setOpen] = useState(runners > 0);
  const list = [...agents].sort((a, b) => Number(b.state === "running") - Number(a.state === "running"));

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger
        className={cn(
          "flex w-full cursor-pointer items-baseline gap-2.5 border-b border-rule-soft px-3 py-2",
          "text-left transition-colors hover:bg-sunk",
        )}
      >
        <ChevronRight
          size={12}
          strokeWidth={2}
          className={cn("shrink-0 self-center text-ink-3 transition-transform duration-150", open && "rotate-90")}
        />
        {runners > 0 && <i className="breathe size-1.5 shrink-0 self-center rounded-full bg-ok" />}
        {/* The requirement is the thing being scanned for, so it gets the weight —
            it was the same size and colour as the shell command beside it. */}
        <Tip label={name}>
          <span className={cn("truncate font-display text-name font-semibold", runners === 0 && "text-ink-3")}>
            {name}
          </span>
        </Tip>
        {/* Who is running, by role. A bare "2 running" makes you open the row to learn the
            one thing you opened it for. */}
        <Meta className="truncate">
          {runners > 0
            ? agents
                .filter((a) => a.state === "running")
                .map((a) => a.role)
                .join(" · ")
            : t`Idle`}
        </Meta>
        <span className="grow" />
        {(() => {
          const sum = agents.reduce((n, a) => n + a.total_tokens, 0);
          return sum ? <Meta>{K(sum)}</Meta> : null;
        })()}
      </Collapsible.Trigger>
      <Collapsible.Content className="fade-in">
        <div className="mb-1 rounded-md bg-sunk/40 py-2">
          {list.map((a) => {
            const row = agentRowModel(a, slices, tail);
            return (
              <div key={a.id} className={cn(DESK_ROW, "py-1.5", row.rowClass)}>
                {/* The session count moved into this label: it does not answer
                    "who is working on what", and a column for it is part of what
                    made this table nine wide. */}
                <Tip label={sessionTip(a)}>
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className="shrink-0 truncate text-body font-medium">{a.role}</span>
                    {/* A chip, because which model an agent is on is the second
                        thing looked for here and it was grey text in a grey row. */}
                    <span className="truncate rounded-sm bg-sunk px-1 font-mono text-pill text-ink-2">{row.model}</span>
                  </span>
                </Tip>
                <span className="min-w-0">
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    {row.slice && (
                      <Tip label={row.slice.accept_spec}>
                        <span className="shrink-0 font-mono text-meta text-ink-3">S{row.slice.seq}</span>
                      </Tip>
                    )}
                    {row.verb && <span className="shrink-0 text-secondary font-medium text-ink">{row.verb}</span>}
                    <Tip label={row.activity}>
                      <span className="truncate font-mono text-meta text-ink-3">{row.detail}</span>
                    </Tip>
                  </span>
                  {row.stream && (
                    <span className="mt-0.5 block truncate font-mono text-meta text-ink-3">
                      {row.stream.slice(-120)}
                    </span>
                  )}
                </span>
                {/* A high count on one slice is the visible shape of circling, and
                    the watchdog's own threshold is 5 turns on one file. Blank at
                    zero: a column of em-dashes is a column of nothing. */}
                <Meta className={cn("text-right", row.warn && "text-warn")}>{row.turns}</Meta>
                <Meta className="text-right max-[52rem]:hidden">{row.tokens}</Meta>
              </div>
            );
          })}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

type Group = State["groups"][number];
type Bumps = Map<number, Map<string, string[]>>;

const covers = (a: string, b: string) =>
  a === b || a.startsWith(b.replace(/\*+$/, "")) || b.startsWith(a.replace(/\*+$/, ""));

const bump = (into: Map<string, string[]>, path: string, name: string) =>
  into.set(path, [...(into.get(path) ?? []), name]);

function compareOwnership(bumps: Bumps, left: Group, right: Group): void {
  const leftBumps = bumps.get(left.id);
  const rightBumps = bumps.get(right.id);
  if (!leftBumps || !rightBumps) return;
  for (const a of owns(left)) {
    for (const b of owns(right)) {
      if (!covers(a, b)) continue;
      bump(leftBumps, a, right.name);
      bump(rightBumps, b, left.name);
    }
  }
}

function ownershipModel(all: Group[]) {
  const groups = all.filter((group) => owns(group).length);
  const bare = all.filter((group) => !owns(group).length);
  const bumps: Bumps = new Map(groups.map((group) => [group.id, new Map()]));
  for (const [index, group] of groups.entries()) {
    for (const other of groups.slice(index + 1)) compareOwnership(bumps, group, other);
  }
  const hit = groups.filter((group) => (bumps.get(group.id)?.size ?? 0) > 0);
  return {
    groups,
    bare,
    bumps,
    hit,
    rows: [...hit, ...groups.filter((group) => (bumps.get(group.id)?.size ?? 0) === 0), ...bare],
  };
}

/** One agent's cost so far, said in the tooltip rather than in a column: the
 *  table was nine wide and this is the question people hover for. */
/** Which other requirements claim this path. `、` is the separator a Chinese
 *  reader expects and a comma is not, so it is a message of its own.
 *  i18n-exempt: the separator is the subject. */
const sameGround = (names: string[]): string => {
  const others = names.join(t`, `);
  return t`the same ground as ${others}`;
};

const sessionTip = (a: State["agents"][number]): string => {
  const sessionTokens = K(a.session_tokens);
  return t`${sessionTokens} tokens this session · ${ph({ model: a.model })}`;
};

export function Owns({ st, projectId }: { st: State; projectId: number }) {
  const { t } = useLingui();
  const all = st.groups.filter((g) => g.project_id === projectId);
  const { groups: gs, bare, bumps, hit, rows } = ownershipModel(all);
  // Named, for the same reason as the desk header above.
  const bareNames = bare.map((g) => g.name).join(t`, `);
  const count = bare.length;
  const hitCount = hit.length;
  const groupCount = gs.length;
  if (!gs.length) {
    return (
      <Empty>
        <Trans>
          No boundaries drawn yet. The Architect decides which paths each group may write before work starts; groups
          without one run into the same files.
        </Trans>{" "}
        {count > 0 && t`${count} requirements have no boundary right now: ${bareNames}.`}
      </Empty>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Said the way the boss would say it. "the boundaries overlap", "running them
          in parallel touches the same files", "the Architect has to re-cut it" are
          three pieces of our vocabulary for one fact
          they act on: two requirements want the same files, so they cannot run at
          once. */}
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {hit.length ? (
          <b className="text-body font-semibold text-bad">
            <Trans>{hitCount} requirements want the same files and cannot run together</Trans>
          </b>
        ) : (
          <b className="text-body font-semibold">
            {/* Two whole sentences: a parenthetical extracted on its own has
                nothing to attach it to. */}
            {bare.length ? (
              <Trans>
                {groupCount} requirements touch different files and can run together ({{ more: bare.length }} more not
                yet assigned)
              </Trans>
            ) : (
              <Trans>{groupCount} requirements touch different files and can run together</Trans>
            )}
          </b>
        )}
      </div>

      {/* A column of paths under no heading is a column of paths. */}
      <div
        className="grid grid-cols-[13rem_minmax(0,1fr)] gap-x-5 border-b border-rule pb-1.5 text-meta
                      text-ink-3 max-[52rem]:grid-cols-1"
      >
        <span>
          <Trans>Requirement</Trans>
        </span>
        <span>
          <Trans>Can modify which files</Trans>
        </span>
      </div>

      <Pane>
        {rows.map((g) => {
          const mine = bumps.get(g.id) ?? new Map<string, string[]>();
          const others = [...new Set([...mine.values()].flat())];
          const overlapping = others.join(t`, `);
          return (
            <div
              key={g.id}
              className="grid grid-cols-[13rem_minmax(0,1fr)] items-baseline gap-x-5 border-t border-rule-soft
                         py-2.5 first:border-t-0 max-[52rem]:grid-cols-1 max-[52rem]:gap-y-1"
            >
              <div className="min-w-0">
                <Tip label={g.name}>
                  <div className="truncate font-display text-base font-semibold">{g.name}</div>
                </Tip>
                {others.length > 0 && (
                  <Tip label={others.join(t`, `)}>
                    <Meta className="truncate text-bad">
                      <Trans>overlaps {overlapping}</Trans>
                    </Meta>
                  </Tip>
                )}
              </div>
              {/* Chips that wrap, not a stack: eight owned paths were eight rows of
                  height for one requirement, and the page is a comparison. */}
              <span className="flex min-w-0 flex-wrap gap-x-1.5 gap-y-1">
                {owns(g).length ? (
                  owns(g).map((o) =>
                    mine.has(o) ? (
                      <Tip key={o} label={sameGround(mine.get(o)!)}>
                        <span className="rounded-sm bg-bad-soft px-1.5 py-0.5 font-mono text-meta text-bad">{o}</span>
                      </Tip>
                    ) : (
                      <span key={o} className="rounded-sm bg-sunk px-1.5 py-0.5 font-mono text-meta text-ink-2">
                        {o}
                      </span>
                    ),
                  )
                ) : (
                  <Badge tone="warn">
                    <Trans>Undefined</Trans>
                  </Badge>
                )}
              </span>
            </div>
          );
        })}
      </Pane>
    </div>
  );
}

const ROTATION_REASON: Record<string, MessageDescriptor> = {
  hash: msg`prefix changed`,
  budget: msg`context full`,
  explicit: msg`sent back`,
  new: msg`newly hired`,
};

function rotationModel(cost: Cost) {
  const entries = Object.entries(cost.rotations.byReason).sort((left, right) => right[1] - left[1]);
  const cold = entries.reduce((total, [, count]) => total + count, 0);
  return {
    turns: cost.rotations.turns,
    cold,
    why: entries.map(([reason, count]) => `${labelOf(ROTATION_REASON[reason], reason)} ${count}`).join(" · "),
    className: cold * 2 > cost.rotations.turns ? "text-warn" : "text-ink",
  };
}

function attributionModel(cost: Cost) {
  const standing = cost.agents.filter((agent) => agent.grpId == null && agent.tokens);
  const standingTotal = standing.reduce((total, agent) => total + agent.tokens, 0);
  const groups = cost.byGroup.filter((group) => group.tokens).sort((left, right) => right.tokens - left.tokens);
  const sum = groups.reduce((total, group) => total + group.tokens, 0) + standingTotal;
  return {
    standing,
    standingTotal,
    groups,
    sum,
    top: Math.max(1e-9, ...groups.map((group) => group.tokens), standingTotal),
  };
}

function costSummary(cost: Cost) {
  const per = cost.delivered.count ? cost.delivered.tokens / cost.delivered.count : null;
  const deliveredCount = cost.delivered.count;
  return {
    per: per == null ? "—" : K(per),
    perNote: per == null ? t`(need one merge first)` : t`(${deliveredCount})`,
    cache: cost.cacheRatio == null ? t`No data yet` : `${Math.round(cost.cacheRatio * 100)}%`,
    cacheClass: cost.cacheRatio == null ? "text-ink-3" : cost.cacheRatio < 0.5 ? "text-warn" : "text-ink",
  };
}

export function CostView({ cost }: { cost: Cost | null }) {
  const { t } = useLingui();
  if (!cost?.total?.tokens) {
    return (
      <Empty>
        <Trans>
          No tokens spent yet. After approving plan cards, costs break down by requirement per agent. Tier tag
          determines which model.
        </Trans>
      </Empty>
    );
  }
  const { turns, cold, why, className: rotationClass } = rotationModel(cost);
  const { standing, standingTotal, groups, sum, top } = attributionModel(cost);
  const summary = costSummary(cost);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* `min-h-0` on the grid is not enough: grid rows default to `auto`, so the
          row grows to its tallest child and the whole page overflows no matter what
          the container was told. Pinning the row to `minmax(0,1fr)` is what lets
          each column's own pane take the scrolling — the table and the charts
          scroll independently, which is the point of putting them side by side. */}
      <div
        className={cn(
          "grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_17rem] grid-rows-[minmax(0,1fr)] gap-x-8",
          "max-[64rem]:grid-cols-1 max-[64rem]:grid-rows-[minmax(0,1fr)_auto] max-[64rem]:gap-y-6",
        )}
      >
        {/* One axis at a time, chosen here. Three stacked sections meant the two
            short ones — three difficulties, two accounts — pushed the list that
            grows off the bottom, and you scrolled past a hundred requirements to
            reach five rows. */}
        <Tabs defaultValue="grp" className="flex min-h-0 min-w-0 flex-col">
          <TabList>
            <Tab value="grp">
              <Trans>By requirement</Trans>
            </Tab>
            <Tab value="tier">
              <Trans>By tier</Trans>
            </Tab>
            <Tab value="acct">
              <Trans>By account</Trans>
            </Tab>
            <span className="grow" />
            <Meta className="self-center pb-1.5 max-[52rem]:hidden">
              <Trans>tokens · share</Trans>
            </Meta>
          </TabList>
          <TabPanel value="grp" className="flex min-h-0 flex-1 flex-col">
            <Pane className="[&>*:first-child_button]:border-t-0">
              {groups.map((g) => (
                <Node
                  key={g.grpId}
                  label={g.label}
                  tokens={g.tokens}
                  top={top}
                  share={g.tokens / sum}
                  rows={cost.agents.filter((a) => a.grpId === g.grpId && a.tokens)}
                />
              ))}
              {standing.length > 0 && (
                <Node
                  label={t`Standing post`}
                  note={t`Shared across requirements`}
                  tokens={standingTotal}
                  top={top}
                  share={standingTotal / sum}
                  rows={standing}
                />
              )}
            </Pane>
          </TabPanel>
          <TabPanel value="tier" className="flex min-h-0 flex-1 flex-col">
            <Pane>
              <Flat rows={cost.byDifficulty} />
            </Pane>
          </TabPanel>
          <TabPanel value="acct" className="flex min-h-0 flex-1 flex-col">
            <Pane>
              <Flat rows={cost.byRuntime} />
            </Pane>
          </TabPanel>
        </Tabs>

        <aside className="flex min-h-0 min-w-0 flex-col overflow-y-auto pr-1">
          {/* The totals ride the rail, above the charts they are the sum of.
            They had a band of their own with a rule under it, and the tab strip
            below had another — two horizontal lines a centimetre apart, dividing
            a page into three when it has two parts. "Dashboards of big numbers"
            is an anti-reference in PRODUCT.md, so this stays one line of text
            with one number set in display size, not a row of stat cards. */}
          <div className="mb-5">
            <div className="flex items-baseline gap-1.5">
              <b className="font-mono text-figure font-semibold leading-none">{K(cost.total.tokens)}</b>
              <span className="text-secondary text-ink-3">
                <Trans>tokens · project total</Trans>
              </span>
            </div>
            <div className="mt-1.5 text-secondary text-ink-2">
              <Trans>Per delivered requirement</Trans> <b className="font-mono font-semibold text-ink">{summary.per}</b>
              <span className="text-ink-3">{summary.perNote}</span>
            </div>
            <Tip label={t`Drop below 50% = prompt assembly broken, 3-5× more expensive per turn`}>
              <div className="mt-0.5 w-fit text-secondary text-ink-2 underline decoration-dotted">
                <Trans>Cache hit rate</Trans>{" "}
                <b className={cn("font-mono font-semibold", summary.cacheClass)}>{summary.cache}</b>
              </div>
            </Tip>
            {/* The second half of the same question, over the same sample as the
              line above it. A low hit rate can mean the prompt assembly broke or
              it can mean nobody is resuming anything, and only this line
              separates them. One line of text, no card: it is a footnote to the
              number above it, not a metric of its own.
              The breakdown by reason is in the tip rather than on the line,
              because those counts sum to the count already printed — the same
              number said twice, once as a total and once as its parts. */}
            {cold > 0 && (
              <Tip
                label={t`Restarted ${cold} times across ${turns} turns: ${why}. Each restart rebuilds the cache prefix from scratch`}
              >
                <div className="mt-0.5 w-fit text-secondary text-ink-2 underline decoration-dotted">
                  <Trans>Session restarts</Trans>{" "}
                  <b className={cn("font-mono font-semibold", rotationClass)}>
                    {cold}/{turns}
                  </b>
                </div>
              </Tip>
            )}
          </div>
          <Rail title={t`Burn rate`} note={t`Last 24 hours, per hour`}>
            <BurnChart data={cost.byHour} />
          </Rail>
          <Rail title={t`By account`} note="">
            <SplitDonut rows={cost.byRuntime} />
          </Rail>
          <Rail title={t`By tier`} note="">
            <SplitDonut rows={cost.byDifficulty} />
          </Rail>
        </aside>
      </div>
    </div>
  );
}

/**
 * One numeric grid for the whole page.
 *
 * Same reason the slice lanes fix their columns: a number whose left edge moves
 * with the label above it cannot be compared with that one, and comparing them is
 * the entire view.
 */
const ROW = cn(
  "grid grid-cols-[minmax(0,1fr)_5rem_2.75rem_4.5rem] items-center gap-x-4 px-3",
  "max-[52rem]:grid-cols-[minmax(0,1fr)_5rem_2.75rem]",
);

/** A flat attribution: no children to open, same ruler, share against the tab. */
function Flat({ rows }: { rows: { label: string; tokens: number }[] }) {
  const list = rows.filter((r) => r.tokens).sort((a, b) => b.tokens - a.tokens);
  if (!list.length) return null;
  const top = Math.max(...list.map((r) => r.tokens));
  const sum = list.reduce((n, r) => n + r.tokens, 0);
  return (
    <>
      {list.map((r) => (
        <div key={r.label} className={cn(ROW, "border-t border-rule-soft py-2.5 first:border-t-0")}>
          <Tip label={r.label}>
            <span className="truncate pl-[1.125rem] text-body">{r.label}</span>
          </Tip>
          <span className="text-right font-mono text-body">{K(r.tokens)}</span>
          <Meta className="text-right">{list.length > 1 ? `${Math.round((r.tokens / sum) * 100)}%` : ""}</Meta>
          <Bar frac={r.tokens / top} className="max-[52rem]:hidden" />
        </div>
      ))}
    </>
  );
}

/** A fixed-size block in the right rail. Never grows, so it never pushes the list. */
function Rail({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="mb-5 last:mb-0">
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2">
        <h3 className="text-body font-semibold">{title}</h3>
        {note && <Meta>{note}</Meta>}
      </div>
      {children}
    </section>
  );
}

/**
 * One requirement, opening onto the agents inside it.
 *
 * Radix rather than a hand-rolled toggle, and the same primitive the diff's file
 * tree uses: aria-expanded, the disclosure keyboard contract and the space/enter
 * handling come with it, and this page had none of the three.
 */
function Node({
  label,
  note,
  tokens,
  top,
  share,
  rows,
}: {
  label: string;
  note?: string;
  tokens: number;
  top: number;
  share: number;
  rows: AgentCost[];
}) {
  const [open, setOpen] = useState(false);
  const list = [...rows].sort((a, b) => b.tokens - a.tokens);
  const inner = Math.max(1e-9, ...list.map((r) => r.tokens));

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger
        disabled={!list.length}
        className={cn(
          ROW,
          "w-full border-t border-rule-soft py-2.5 text-left transition-colors",
          list.length && "cursor-pointer hover:bg-sunk",
        )}
      >
        <span className="flex min-w-0 items-baseline gap-1.5">
          <ChevronRight
            size={12}
            strokeWidth={2}
            className={cn(
              "shrink-0 transition-transform duration-150",
              open && "rotate-90",
              list.length ? "text-ink-3" : "invisible",
            )}
          />
          <Tip label={label}>
            <span className="truncate text-body">{label}</span>
          </Tip>
          {note && <Meta className="truncate max-[52rem]:hidden">{note}</Meta>}
        </span>
        <span className="text-right font-mono text-body">{K(tokens)}</span>
        <Meta className="text-right">{Math.round(share * 100)}%</Meta>
        <Bar frac={tokens / top} className="max-[52rem]:hidden" />
      </Collapsible.Trigger>
      <Collapsible.Content className="fade-in">
        <div className="mb-1 rounded-md bg-sunk/40 py-1.5">
          {list.map((a) => (
            <div key={a.id} className={cn(ROW, "py-1")}>
              {/* Role and model together: "the engineer took 4M" is half a fact
                  until you know which model it took them on. Indented past the
                  chevron so the nesting is the indent, not a rule down the side. */}
              <span className="flex min-w-0 items-baseline gap-1.5 pl-[1.125rem]">
                <span className="truncate font-mono text-secondary text-ink-2">{a.role}</span>
                <Meta className="truncate">{a.model}</Meta>
              </span>
              <span className="text-right font-mono text-secondary text-ink-2">{K(a.tokens)}</span>
              {/* Share of this requirement, not of the project: inside the open row
                  the question is which of these people spent it. */}
              <Meta className="text-right">{Math.round((a.tokens / tokens) * 100)}%</Meta>
              <Bar frac={a.tokens / inner} className="max-[52rem]:hidden" />
            </div>
          ))}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
