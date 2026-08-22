import { ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { Button, LinkButton } from "../../ui/button";
import { Menu, MenuItem } from "../../ui/menu";
import { Tab, TabList, TabPanel, Tabs } from "../../ui/tabs";
import { Clamp, H2, Meta, Textarea, Typing, Working, Pane } from "../../ui/bits";
import { Badge } from "../../ui/badge";
import { Card, CardBody, CardTitle } from "../../ui/card";
import { Bar } from "../../ui/table";
import { Tip } from "../../ui/tooltip";
import { ask, type AskSpec } from "../../ui/confirm";
import { Composer, ComposerDialog, type Draft } from "../composer/view";
import { Telemetry } from "../telemetry/view";
import {
  AnswerDraftSchema,
  api,
  groupAction,
  mutate,
  readApi,
  sliceDecision,
  type Escalation,
  type Group,
  type Slice,
  type State,
} from "../../shared/api";
import type { PanelFrame } from "../../shared/stream";
import { asksOf, gates, labelOf, mineOf, prUrl, statusLabel, WHERE_LABEL } from "../../shared/select";
import { K, waited } from "../../shared/format";
import { nl } from "../../shared/prose";
import { cn } from "../../ui/cn";
import { WithAttachments } from "../../ui/attachments";
import { useEffect, useRef, useState } from "react";
import { Accordion, AccordionBody, AccordionItem, AccordionTrigger } from "../../ui/accordion";
import { Segment, Segments } from "../../ui/segment";
import { Workspace } from "../workspace/view";
import { EvidencePanel } from "../evidence/view";
import { Notes } from "../notes/view";
import { bootstrapOf } from "./bootstrap";
import { saidText } from "../../shared/said";
import {
  activeTab,
  answeredFor,
  approveBody,
  askLanes,
  askTabLabel,
  countProps,
  blockedReason,
  bootClock,
  bootCmd,
  bootSecs,
  bossFirst,
  canNewPr,
  canPark,
  canResume,
  cardRows,
  cloneStep,
  draftView,
  firstLine,
  groupSlices,
  groupTone,
  heldAsks,
  inMergeQueue,
  installStep,
  isDraft,
  isRunning,
  noQuestions,
  openAskValue,
  openSliceValue,
  overBudget,
  pickedSlice,
  prLabel,
  runningAgents,
  showDock,
  showQueued,
  showTasks,
  sliceLine,
  sliceRowClass,
  tabProps,
  askLane,
  shownSlice,
  tickDotClass,
  tickState,
  tickStops,
  tickTextClass,
  type StepState,
} from "./model";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";

/**
 * Confirm, then act, then refresh — the shape every consequential control here
 * has, in one place, because the early return is the part that gets forgotten.
 */
const confirmThen = (spec: AskSpec, run: () => Promise<unknown>, refresh?: () => void) => async () => {
  if (!(await ask(spec))) return;
  await run();
  refresh?.();
};

/**
 * One requirement, arranged so exactly one thing is the target of action.
 *
 * The boss's job here is one of three things — approve the plan, accept a slice,
 * answer a question — so: a header that states what this is and hides the rare
 * controls in a menu; the slices as a compact ordered list with the row that
 * needs you selected; that one slice's detail underneath it, with its actions;
 * everything else behind tabs. Read top to bottom it says what happened, what
 * needs you, and what to type — in that order.
 */
export function Requirement({
  st,
  g,
  frames,
  refresh,
  open,
  tab,
  onTab,
}: {
  st: State;
  g: Group;
  frames: PanelFrame[];
  refresh: () => void;
  open: boolean;
  /** From the hash: leaving the drill-in and coming back kept unmounting this. */
  tab?: string | null;
  onTab?: (t: string) => void;
}) {
  const { t } = useLingui();
  const slices = groupSlices(st, g.id);
  const asks = bossFirst(asksOf(st, g.id));
  const mine = mineOf(asks);
  const others = heldAsks(asks, mine);
  const answered = answeredFor(st, g.id);
  const draft = isDraft(g);
  // `null` = untouched, open the first one waiting on the boss. Radix reports
  // `""` when the open one is shut, which is the state the default would
  // otherwise fall straight back to.
  const [openAsk, setOpenAsk] = useState<string | null>(null);
  const [subPick, setSubPick] = useState<string | null>(null);
  const [picked, setPicked] = useState<number | "none" | null>(null);
  // The record is fetched by the panel that shows it, so the tab has to be told.
  const [notes, setNotes] = useState<number | null>(null);
  const shown = shownSlice(slices, picked);
  const active = activeTab(tab, mine.length);
  const sub = askLane(subPick, mine.length, others.length);

  return (
    // Tabs put one of the four things this page holds in front of the boss at a
    // time, each scrolling inside itself, with the header and the box you type
    // into pinned. Every column is min-w-0: a long shell command inside an
    // escalation otherwise pushes the whole page into a horizontal scroll.
    <section className="flex min-h-0 flex-1 flex-col">
      <Header st={st} g={g} refresh={refresh} />
      <Bootstrap frames={frames} grpId={g.id} />
      {overBudget(g) && <BudgetWall g={g} refresh={refresh} />}

      {draft ? (
        <Pane className="mt-4">
          <Draft st={st} g={g} refresh={refresh} />
        </Pane>
      ) : (
        <Tabs value={active} {...tabProps(onTab)} className="mt-3 flex min-h-0 flex-1 flex-col">
          <TabList>
            <Tab value="slice" count={slices.length}>
              <Trans>Slice</Trans>
            </Tab>
            {/* Only the ones on the boss are `Awaiting your decision`. The rest are open questions
                the chain is still holding, and counting them under that heading
                made the badge lie about how much of this was a decision. */}
            <Tab value="ask" count={asks.length} mine={mine.length > 0}>
              {askTabLabel(mine.length)}
            </Tab>
            <Tab value="notes" {...countProps(notes)}>
              <Trans>Notes</Trans>
            </Tab>
            {/* No count: a container is one or none, and a badge reading 1 next
                to `Workspace` says nothing the tab does not already. */}
            <Tab value="work">
              <Trans>Workspace</Trans>
            </Tab>
            {/* No count either, and for a stronger reason than `Workspace`'s: the number
                of spans a requirement has produced is not a quantity anybody is
                waiting on, and a badge reading 1,482 beside `Time` would be the
                loudest number on the tab strip while meaning the least. */}
            <Tab value="time">
              <Trans>Time</Trans>
            </Tab>
          </TabList>

          <TabPanel value="slice" className="flex min-h-0 flex-1 flex-col">
            <SliceList st={st} g={g} slices={slices} shown={shown} onPick={setPicked} refresh={refresh} />
          </TabPanel>

          <TabPanel value="ask" className="flex min-h-0 flex-1 flex-col gap-2">
            <AskLanes
              sub={sub}
              onSub={setSubPick}
              mine={mine}
              others={others}
              answered={answered}
              openAsk={openAsk}
              onOpenAsk={setOpenAsk}
              refresh={refresh}
            />
          </TabPanel>

          <TabPanel value="notes" className="flex min-h-0 flex-1 flex-col">
            <Pane>
              <Notes grpId={g.id} compact onCount={setNotes} />
            </Pane>
          </TabPanel>

          {/* Not in a `Pane`: the log scrolls inside itself and stays pinned to
              the newest line, and a scroller wrapping a scroller gives two bars
              and neither of them pinned. */}
          <TabPanel value="work" className="flex min-h-0 flex-1 flex-col">
            <Workspace frames={frames} grpId={g.id} />
          </TabPanel>

          {/* No trend for one requirement: a handful of turns is too few points
              for a shape, and two points drawn as a line invite a reading of a
              trajectory that is not in the data. The stage list and the
              waterfall are what answer "where did the wall clock go". */}
          <TabPanel value="time" className="flex min-h-0 flex-1 flex-col">
            <Pane>
              <Telemetry scope={{ kind: "group", id: g.id }} empty={t`This requirement hasn't run any activity yet.`} />
            </Pane>
          </TabPanel>
        </Tabs>
      )}

      {/* Pinned and one line tall until it is wanted. A composer that is always
          open costs four rows of the slice list to sit there empty, and this page
          is read far more often than it is typed into — but it has to stay
          reachable without scrolling, because it is how the boss answers what
          they just read. */}
      {showDock(open, draft, active, mine.length) && <SayDock g={g} refresh={refresh} />}
    </section>
  );
}

/**
 * The slices, and the evidence for the one that is open.
 *
 * One accordion, so the evidence opens under the row it belongs to rather than
 * in a pane below the whole list, with its header pinned inside so the verdict
 * buttons stay reachable while you read the diff.
 *
 * The box hugs its rows and is capped at what is left of the screen — not
 * `flex-1`, which draws an empty frame under three closed rows.
 */
function SliceList({
  st,
  g,
  slices,
  shown,
  onPick,
  refresh,
}: {
  st: State;
  g: Group;
  slices: Slice[];
  shown: Slice | undefined;
  onPick: (v: number | "none") => void;
  refresh: () => void;
}) {
  if (!slices.length) {
    return (
      <Pane>
        <Working>
          <Trans>Decomposing</Trans>
        </Working>
      </Pane>
    );
  }
  return (
    <div className="min-h-0 max-h-full overflow-y-auto overflow-x-hidden rounded-lg border border-rule">
      <Accordion value={openSliceValue(shown)} onValueChange={(v) => onPick(pickedSlice(v))}>
        {slices.map((s) => (
          <AccordionItem key={s.id} value={String(s.id)}>
            <SliceRow st={st} g={g} s={s} selected={s.id === shown?.id} />
            <AccordionBody>
              <SliceDetail st={st} s={s} refresh={refresh} />
            </AccordionBody>
          </AccordionItem>
        ))}
      </Accordion>
    </div>
  );
}

/**
 * Three kinds of thing, one at a time, with their counts on the switch — which
 * says who is holding what without the reader scrolling to find out.
 *
 * Not a second tab strip (this page already has one): the same quiet ToggleGroup
 * the evidence panel uses, for the same reason.
 */
function AskLanes({
  sub,
  onSub,
  mine,
  others,
  answered,
  openAsk,
  onOpenAsk,
  refresh,
}: {
  sub: string;
  onSub: (v: string) => void;
  mine: Escalation[];
  others: Escalation[];
  answered: State["answered"];
  openAsk: string | null;
  onOpenAsk: (v: string) => void;
  refresh: () => void;
}) {
  const value = openAskValue(openAsk, mine);
  return (
    <>
      <Segments value={sub} onValueChange={(v) => v && onSub(v)} className="-ml-2 shrink-0">
        {askLanes(mine.length, others.length, answered.length).map(([lane, label]) => (
          <Segment key={lane} value={lane}>
            {label}
          </Segment>
        ))}
      </Segments>

      {/* One scroll for the pane, not a capped box per section: a long question
          used to push its own answer box below the box's bottom edge, so the boss
          saw a question cut mid-sentence and no way to reply to it. */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-2 pr-1">
        {noQuestions(mine.length + others.length, answered.length) && (
          <div className="text-body text-ink-3">
            <Trans>No open questions. This group is not waiting on you right now.</Trans>
          </div>
        )}
        {sub === "mine" && mine.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-accent">
            <Accordion value={value} onValueChange={onOpenAsk}>
              {mine.map((e) => (
                <AccordionItem key={e.id} value={String(e.id)}>
                  <Ask e={e} refresh={refresh} open={String(e.id) === value} />
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        )}
        {sub === "held" && <Held rows={others} />}
        {/* An answer a stand-in gave for the boss belongs with the questions,
            which is where someone goes looking for it. It used to sit in a
            roster tab listed role, activity, turns and tokens for
            every agent in the group — the desk wall in miniature, one column
            narrower, on a page about a requirement rather than about people.
            The tab is gone; this was the only part of it doing work. */}
        {sub === "done" && <Delegated rows={answered} refresh={refresh} />}
      </div>
    </>
  );
}

/**
 * The sandbox being built back up, while it happens.
 *
 * A container is replaceable — the TTL reaps an idle one, a credential change
 * kills it — and the clone and install that follow can run for minutes, which
 * without this pane is indistinguishable from stuck.
 *
 * Live frames only, so it is gone on reload and the outcome line in the record
 * is what remains. Nothing here is stored twice.
 */
function Bootstrap({ frames, grpId }: { frames: PanelFrame[]; grpId: number }) {
  const { t } = useLingui();
  const box = useRef<HTMLDivElement>(null);
  /** Stay pinned to the newest line only while the reader is already there. */
  const pinned = useRef(true);
  const [shut, setShut] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const { running, failed, cmd, lines, since, until } = bootstrapOf(frames, grpId);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  useEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lines.length, shut]);

  // A failure stays on the page. It is the one outcome the boss might act on,
  // and it used to be the one that made the pane disappear.
  if (!running && !failed) return null;

  return (
    <div className="mt-3 border-t border-rule pt-2.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {/* The same marks the gate tracks use. Progress on this page is which
            step passed, never a bar that fills. */}
        <Step label={t`Clone`} state={cloneStep(cmd, failed)} />
        <Step label={t`Install dependencies`} state={installStep(cmd, failed, until)} />
        <Meta className="min-w-0 flex-1 truncate">{bootCmd(cmd)}</Meta>
        <Meta className={cn(failed && "text-bad")}>{bootClock(failed, bootSecs(since, until, now))}</Meta>
        <Button variant="quiet" size="sm" aria-expanded={!shut} onClick={() => setShut((v) => !v)}>
          {shut ? t`View log` : t`Collapse`}
        </Button>
      </div>
      {!shut && lines.length > 0 && (
        <div
          ref={box}
          role="log"
          aria-label={t`Environment setup output`}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
          className={cn(
            "mt-2 max-h-40 overflow-y-auto rounded-md bg-sunk px-2.5 py-2 font-mono text-meta",
            "leading-relaxed text-ink-2",
          )}
        >
          {lines.slice(-300).map((f) => (
            <div key={f.id} className="break-all whitespace-pre-wrap">
              {f.text}
            </div>
          ))}
        </div>
      )}
      {failed && (
        <Meta className="mt-1.5 block">
          <Trans>Let bootstrap retry; it will review the repository with the error above in context</Trans>
        </Meta>
      )}
    </div>
  );
}

/** One step of a rebuild, in the gate track's own marks. */
function Step({ label, state }: { label: string; state: StepState }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <i
        className={cn(
          "tick",
          state === "ok" && "bg-ok",
          state === "bad" && "bg-bad",
          state === "run" && "breathe bg-ink-3",
        )}
      />
      <span className={cn("text-secondary", state === "wait" ? "text-ink-3" : "text-ink-2")}>{label}</span>
    </span>
  );
}

/** Identity and state on the left, the one useful control on the right, the rest in a menu. */
function Header({ st, g, refresh }: { st: State; g: Group; refresh: () => void }) {
  const inQueue = inMergeQueue(st, g.id);
  const url = prUrl(st, g);
  const act = (a: "pause" | "resume" | "wake") => actThen(g, a, refresh);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-rule pb-3">
      <span className="font-display text-title font-semibold">{g.name}</span>
      <Badge tone={groupTone(g)}>{statusLabel(g)}</Badge>
      <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {g.branch && <Meta>{g.branch}</Meta>}
        <Meta>{K(g.spent_tokens)} tokens</Meta>
        <Budget g={g} refresh={refresh} />
      </span>

      <span className="ml-auto flex flex-wrap items-center gap-1.5">
        {/* Merging is the one step that stays the boss's hand, on GitHub. Nothing
            here confirms it: `pollPrs` asks GitHub every tick and winds the group
            up by itself. */}
        {url && <LinkButton href={url}>{prLabel(inQueue)}</LinkButton>}
        {canNewPr(g) && <NewPr grpId={g.id} refresh={refresh} />}
        {showQueued(inQueue, g) && (
          <Badge>
            <Trans>Queued</Trans>
          </Badge>
        )}
        {g.status === "RUNNING" && (
          <Button onClick={() => act("pause")}>
            <Trans>Pause</Trans>
          </Button>
        )}
        {canResume(g, overBudget(g)) && (
          <Button onClick={() => act("resume")}>
            <Trans>Resume</Trans>
          </Button>
        )}
        {g.status === "PARKED" && (
          <Button variant="go" onClick={() => act("wake")}>
            <Trans>Wake</Trans>
          </Button>
        )}
        <HeaderMenu g={g} refresh={refresh} />
      </span>
    </div>
  );
}

/**
 * Interrupt and park are rare and consequential. Sitting in the header at the
 * same weight as `Pause` they read as ordinary, and one of them discards a turn's
 * work.
 */
/**
 * Said twice on each of the two screens that can send a requirement back — the
 * tip and the confirm it opens — and the only difference between the screens is
 * whether code exists yet.
 */
/**
 * It was four messages, two of them the same clause with the verb flipped:
 * `difflib` over all 1,100 msgids put that pair at 0.92, the highest
 * non-placeholder score in the catalogue. Four sentences translated nine times
 * is 36 translations of what is really two.
 */
const respecBody = (started: boolean): MessageDescriptor =>
  started
    ? msg`The entire requirement returns to Dispatcher for a deeper dive; this comment is the highest-priority fact, and code already written stays on the branch.`
    : msg`The entire requirement returns to Dispatcher for a deeper dive; this comment is the highest-priority fact.`;

/** Said twice, from the two places a requirement can be dropped. */
const dropBody = (name: string): MessageDescriptor =>
  msg`${{ name }} leaves the board and every queued turn is cancelled. The code and the record are both kept.`;

function HeaderMenu({ g, refresh }: { g: Group; refresh: () => void }) {
  const { t } = useLingui();
  // `g.name` reaches a translator as `{0}`; a named local reaches it as `{name}`.
  const name = g.name;
  const running = isRunning(g);
  return (
    <Menu label={t`More`}>
      {running && (
        <MenuItem
          hint={t`Stop the current turn; keep changes. The next turn will be informed.`}
          onSelect={async () => {
            await groupAction(g.id, "interrupt", { mode: "keep" });
            refresh();
          }}
        >
          <Trans>Interrupt, keep changes</Trans>
        </MenuItem>
      )}
      {running && (
        <MenuItem
          danger
          hint={t`Return to the checkpoint before this round started; all changes in this turn are discarded.`}
          onSelect={confirmThen(
            {
              title: t`Interrupt and rollback`,
              body: t`Discard all changes in the current turn and return to the start of this round.`,
              yes: t`Interrupt and rollback`,
              danger: true,
            },
            () => groupAction(g.id, "interrupt", { mode: "rollback" }),
            refresh,
          )}
        >
          <Trans>Interrupt and rollback</Trans>
        </MenuItem>
      )}
      {canPark(g) && (
        <MenuItem
          hint={t`Release the concurrency slot; code and checkpoint in the sandbox stay in place.`}
          onSelect={() => actThen(g, "park", refresh)}
        >
          <Trans>Archive</Trans>
        </MenuItem>
      )}
      <MenuItem
        hint={t`Use when the container is stuck, missing dependencies, or credentials changed. The next turn will re-clone and reinstall; the branch in the host repo stays.`}
        onSelect={confirmThen(
          {
            title: t`Restart container`,
            body: t`${name}'s container is discarded and the next turn rebuilds it: re-clone the branch, reinstall dependencies. Uncommitted changes are lost.`,
            yes: t`Restart`,
          },
          () => groupAction(g.id, "rebuild"),
          refresh,
        )}
      >
        <Trans>Restart container</Trans>
      </MenuItem>
      {/* `Return for re-decomposition` sends it back to the Dispatcher, which writes another card for
          work nobody wants. A requirement that turned out to be a duplicate, or
          that someone already fixed, needs to leave the board instead. */}
      <MenuItem
        danger
        hint={t`Cancel all queued turns; return the occupied slot to another group. Code, branch, and records are kept.`}
        onSelect={confirmThen(
          {
            title: t`Don't proceed`,
            body: t`${name} leaves the board and every queued turn is cancelled. The code and the record are kept; the group is never started again.`,
            yes: t`Don't proceed`,
            danger: true,
          },
          () => groupAction(g.id, "drop"),
          refresh,
        )}
      >
        <Trans>Don't proceed</Trans>
      </MenuItem>
    </Menu>
  );
}

/** Fire a group action and pull the snapshot it changed. */
const actThen = async (g: Group, a: Parameters<typeof groupAction>[1], refresh: () => void) => {
  await groupAction(g.id, a);
  refresh();
};

/** One line per slice: order, title, gates, and who is on it. */
function SliceRow({ st, g, s, selected }: { st: State; g: Group; s: Slice; selected: boolean }) {
  const waiting = s.status === "awaiting_boss";
  return (
    <AccordionTrigger
      className={cn(
        "grid grid-cols-[2rem_minmax(0,1fr)_auto_auto] items-center gap-x-3",
        "px-4 py-2 transition-colors",
        "max-[52rem]:grid-cols-[2rem_minmax(0,1fr)_auto]",
        sliceRowClass(waiting, selected),
      )}
    >
      <span className="font-mono text-secondary text-ink-3">S{s.seq}</span>
      <span className="min-w-0">
        <span className="block truncate text-body">
          {s.title} <span className="font-mono text-pill text-ink-3">{s.difficulty}</span>
        </span>
        <span className="block truncate font-mono text-meta text-ink-3">{sliceLine(s, runningAgents(st, g.id))}</span>
      </span>
      <Ticks s={s} gs={gates(s)} />
      <ChevronRight
        size={13}
        strokeWidth={2}
        className="shrink-0 text-ink-3 transition-transform group-data-[state=open]:rotate-90 max-[52rem]:hidden"
      />
    </AccordionTrigger>
  );
}

/** Which gates passed. A discrete mark, never a fill: a gate is a fact, a percentage is a guess. */
function Ticks({ s, gs }: { s: Slice; gs: Record<string, string> }) {
  return (
    <span className="flex items-center gap-1.5">
      {tickStops(s.status === "awaiting_boss").map(([k, label]) => {
        const v = tickState(s, k, gs);
        return (
          <span key={k} className={cn("flex items-center gap-1 text-meta", tickTextClass(v))}>
            <span className={cn("size-2 rounded-full border", tickDotClass(v, s.status === k))} />
            <b className="whitespace-nowrap font-medium max-[64rem]:hidden">{label}</b>
          </span>
        );
      })}
    </span>
  );
}

/** The selected slice, in full: what it promised, what it did, and the two buttons. */
function SliceDetail({ st, s, refresh }: { st: State; s: Slice; refresh: () => void }) {
  const tasks = st.tasks.filter((t) => t.slice_id === s.id);
  // No header: the lane row above and the evidence panel below already carry the
  // slice number, the title and the acceptance line. The buttons moved next to
  // the evidence they are a verdict on.
  const act =
    s.status !== "awaiting_boss" ? null : (
      <span className="flex shrink-0 gap-1.5">
        <Button
          variant="go"
          onClick={async () => {
            await sliceDecision(s.id, "accept");
            refresh();
          }}
        >
          <Trans>Accept</Trans>
        </Button>
        <RejectSlice sliceId={s.id} refresh={refresh} />
      </span>
    );

  if (s.status === "pending") {
    return (
      <div className="border-t border-rule-soft py-2 pl-14 pr-3 text-secondary text-ink-3">
        <Trans>Not started yet; waiting for prior slices to be accepted.</Trans>
      </div>
    );
  }
  return (
    <div className="border-t border-rule-soft">
      {showTasks(tasks, s) && (
        <ul className="list-none border-b border-rule-soft py-1.5 pl-14 pr-3">
          {tasks.map((t) => (
            <li key={t.id} className="flex gap-2 py-px text-secondary">
              <span className={cn("font-mono", t.status === "done" ? "text-ok" : "text-ink-3")}>
                {t.status === "done" ? "✓" : "○"}
              </span>
              <span className={t.status === "done" ? "text-ink-3" : "text-ink-2"}>{t.title}</span>
            </li>
          ))}
        </ul>
      )}
      <EvidencePanel sliceId={s.id} actions={act} />
    </div>
  );
}

/**
 * A second PR for a branch whose first one was closed.
 *
 * Reopening on GitHub is the ordinary path and needs nothing here — the poller
 * sees it and puts the group back in the queue. This is for when reopening is not
 * possible: GitHub refuses it once the branch has been force-pushed or deleted,
 * and the group would otherwise sit forever holding a pr_number that openPr reads
 * as "already done".
 */
function NewPr({ grpId, refresh }: { grpId: number; refresh: () => void }) {
  const { t } = useLingui();
  return (
    <Button
      variant="go"
      onClick={confirmThen(
        {
          title: t`Open a new PR`,
          body: t`Use this only if you can't reopen an old PR on GitHub. Use when the branch has been force-pushed or deleted: it will re-open using the current branch and rejoin the merge queue.`,
          yes: t`Open new PR`,
        },
        async () => {
          const r = await groupAction(grpId, "newpr");
          if (!r.ok) await ask({ title: t`Failed to open`, body: r.text, yes: t`Got it` });
        },
        refresh,
      )}
    >
      <Trans>Open new PR</Trans>
    </Button>
  );
}

/**
 * Sending a slice back. The words are the whole payload — they become a
 * blackboard fact the PM plans the correction from — so this is the same
 * composer as everywhere else, screenshot included.
 */
function RejectSlice({ sliceId, refresh }: { sliceId: number; refresh: () => void }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Trans>Not satisfied</Trans>
      </Button>
      <ComposerDialog
        open={open}
        onOpenChange={setOpen}
        title={t`Reject this slice`}
        hint={t`Comments are recorded in the notes; the PM will schedule corrections accordingly. Paste screenshots directly.`}
        placeholder={t`What's not satisfactory. Cmd+Enter to reject`}
        submit={t`Rejected`}
        rows={4}
        onSubmit={async ({ text, attachments }) => {
          const r = await sliceDecision(sliceId, "reject", { feedback: text, attachments });
          refresh();
          return r.ok;
        }}
      />
    </>
  );
}

const setBudget = async (g: Group, tokens: number | null, refresh: () => void) => {
  await groupAction(g.id, "budget", { tokens });
  refresh();
};

/** Spend against its cap, and the cap itself, editable. Nothing sets one otherwise. */
function Budget({ g, refresh }: { g: Group; refresh: () => void }) {
  const { t } = useLingui();
  if (g.budget_tokens == null) {
    return (
      <button
        type="button"
        className="cursor-pointer font-mono text-meta text-ink-3 underline decoration-dotted hover:text-ink"
        onClick={async () => {
          const v = await ask({
            title: t`Set a token limit for this requirement`,
            body: t`When the limit is reached, the group pauses until you decide whether to increase it.`,
            yes: t`Set`,
            field: t`e.g. 2000000`,
          });
          const n = Number(String(v ?? "").replace(/[^\d]/g, ""));
          if (n > 0) await setBudget(g, n, refresh);
        }}
      >
        <Trans>No budget limit</Trans>
      </button>
    );
  }
  const frac = g.spent_tokens / g.budget_tokens;
  const spent = g.spent_tokens;
  const cap = g.budget_tokens;
  return (
    <Tip label={t`${spent} / ${cap} tokens. Spending it all suspends the whole group.`}>
      <span className="flex w-20 items-center gap-1.5">
        <Bar frac={frac} tone={frac >= 1 ? "bad" : frac >= 0.8 ? "warn" : "ink"} />
        <Meta>
          {K(g.spent_tokens)}/{K(g.budget_tokens)}
        </Meta>
      </span>
    </Tip>
  );
}

/**
 * The way out of budget exhaustion.
 *
 * The watchdog suspends the group and the scheduler then refuses to admit it, so
 * `Resume` changes nothing — the next tick suspends it again. Raising the cap is the
 * only thing that moves it.
 */
function BudgetWall({ g, refresh }: { g: Group; refresh: () => void }) {
  // `budget_tokens` is nullable in the column and the browser used to declare it
  // a `number` — so "no cap set" arrived as null and this computed NaN, which is
  // what the raise-the-budget field would have been pre-filled with.
  const doubled = Math.max((g.budget_tokens ?? 0) * 2, g.spent_tokens + 100_000);
  // Named locals: a placeholder takes the name of the expression that fills it,
  // and `K(g.spent_tokens)` reaches a translator as `{0}`.
  const spent = K(g.spent_tokens);
  const cap = K(g.budget_tokens);
  const doubledLabel = K(doubled);
  return (
    <Card tone="mine" className="mt-2.5">
      <CardBody>
        <CardTitle className="text-name text-accent">
          <Trans>Budget exhausted; group paused</Trans>
        </CardTitle>
        <div className="mt-0.5 text-secondary text-ink-2">
          <Trans>
            Spent {spent} tokens against a {cap} limit. Only raising the limit moves it — "resume" does nothing.
          </Trans>
        </div>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <Button variant="go" onClick={() => setBudget(g, doubled, refresh)}>
            <Trans>Double to {doubledLabel}</Trans>
          </Button>
          <Button onClick={() => setBudget(g, null, refresh)}>
            <Trans>Remove limit</Trans>
          </Button>
          <Button variant="quiet" onClick={() => actThen(g, "park", refresh)}>
            <Trans>Stop here (archive)</Trans>
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

/**
 * Answers given on the boss's behalf, with the undo that makes delegation
 * acceptable at all: roll back to the checkpoint that escalation was raised at,
 * answer it yourself, and re-run from there.
 */
function Delegated({ rows, refresh }: { rows: State["answered"]; refresh: () => void }) {
  // Nothing at all when nobody has answered for you. A sentence explaining what
  // an empty block would have held is the page reporting an absence, which
  // PRODUCT.md says an empty state must not do.
  const { t } = useLingui();
  if (!rows.length) return null;
  return (
    <div className="overflow-hidden rounded-lg border border-rule-soft">
      {rows.map((a) => (
        // Question, then answer, in the order they happened, at a measure that
        // can be read and a weight below live work — these are somebody else's
        // words, not the boss's.
        <div key={a.id} className="border-t border-rule-soft px-4 py-2.5 first:border-t-0">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-meta text-ink-3">
              <Trans>answered on your behalf by {{ who: a.answered_by }}</Trans>
            </span>
            <span className="grow" />
            <Button
              variant="quiet"
              size="sm"
              onClick={confirmThen(
                {
                  title: t`Revoke and take over`,
                  body: t`Roll back to the checkpoint when the question was asked; all subsequent changes are discarded. You'll answer it again.`,
                  yes: t`Revoke and take over`,
                  danger: true,
                },
                () => mutate(api.escalations[":id"].revoke.$post({ param: { id: String(a.id) } })),
                refresh,
              )}
            >
              <Trans>Revoke and take over</Trans>
            </Button>
          </div>
          {/* An exchange, laid out as one: what was asked on the left, what was
                said back on the right. Labelled rows in a gutter (`Q` / `A`) read
                as a form, and a paragraph over a grey slab read as two unrelated
                blocks — this is a conversation the boss was not in, and the shape
                everyone already knows for that is two sides. */}
          <div className="mt-1.5 space-y-1.5">
            <div className="max-w-[46rem] rounded-2xl rounded-tl-sm bg-rail px-3.5 py-2 text-secondary text-ink-3">
              <Clamp lines={3}>{nl(saidText(a.said, a.question))}</Clamp>
            </div>
            <div className="flex justify-end">
              <div className="max-w-[46rem] rounded-2xl rounded-tr-sm border border-rule bg-paper px-3.5 py-2 text-body text-ink-2">
                {/* `answered` is also where a revoked question and one the chain
                    ran out on land, and neither wrote a reply. `nl(null)` threw. */}
                <Clamp lines={3}>{a.answer === null ? t`(no reply was left)` : nl(a.answer)}</Clamp>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** One line at rest, the full composer once clicked. */
function SayDock({ g, refresh }: { g: Group; refresh: () => void }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 flex w-full cursor-pointer items-center gap-2 rounded-md border border-rule
                   bg-paper px-3 py-2 text-left text-body text-ink-3 transition-colors hover:border-ink-3"
      >
        <Trans>Message this group…</Trans>
        <span className="grow" />
        <Meta>
          <Trans>Cmd+Enter to send to PM</Trans>
        </Meta>
      </button>
    );
  }
  return (
    <div className="mt-2 border-t border-rule pt-2">
      <Say g={g} refresh={refresh} projectId={g.project_id} />
    </div>
  );
}

/**
 * One button that confirms before it sends, in the row under the composer.
 *
 * `Wrong direction`, `Don't proceed` and `Return for re-decomposition` are the same control three times: a tip saying who
 * receives the sentence, a confirm carrying the weight, and a send that clears
 * the box only if it went.
 */
function SendAs({
  label,
  tip,
  spec,
  disabled,
  run,
}: {
  label: string;
  tip: string;
  spec: AskSpec;
  disabled: boolean;
  run: () => Promise<unknown>;
}) {
  return (
    <Tip label={tip}>
      <Button size="sm" disabled={disabled} onClick={confirmThen(spec, run)}>
        {label}
      </Button>
    </Tip>
  );
}

/**
 * The boss's own voice, and what it counts as.
 *
 * docs/project/plan.md §7 puts three readings on the same words: patch keeps going, respec
 * throws the decomposition out, reject drops the whole thing. Without respec here
 * every complaint is heard as "change one line", which is exactly how a wrong
 * decomposition survives to the end.
 */
function Say({ g, refresh, projectId }: { g: Group; refresh: () => void; projectId: number }) {
  const { t } = useLingui();
  const send = async (d: Draft, as?: "patch" | "respec" | "reject") => {
    const r = await mutate(
      api.say.$post({
        json: { group_id: g.id, body: d.text, attachments: d.attachments, ...(as ? { as } : {}) },
      }),
    );
    refresh();
    return r.ok;
  };

  // Before approval the exits live next to the approve button, where the
  // decision is. A second composer here would ask the boss to type into
  // whichever one they found first.
  if (isDraft(g)) return null;

  return (
    <>
      <H2 className="mt-6">
        <Trans>Message this group</Trans>
      </H2>
      <Composer
        rows={2}
        projectId={projectId}
        placeholder={t`Will be read at the start of the next turn. Paste screenshots directly; / to insert a skill. Cmd+Enter to send to PM`}
        submit={t`Send to PM`}
        onSubmit={(d) => send(d)}
        actions={({ text, attachments, busy, clear }) => (
          <>
            <span className="mr-1 text-secondary text-ink-3 max-[40rem]:hidden">
              <Trans>Weight:</Trans>
            </span>
            <Tip
              label={t`Comments are recorded in the notes; PM will schedule a correction task and the group continues.`}
            >
              <Button
                size="sm"
                disabled={busy || !text}
                onClick={async () => (await send({ text, attachments }, "patch")) && clear()}
              >
                <Trans>Fix this</Trans>
              </Button>
            </Tip>
            <SendAs
              label={t`Return for re-decomposition`}
              tip={t(respecBody(true))}
              spec={{
                title: t`Return for re-decomposition`,
                body: t(respecBody(true)),
                yes: t`Return for re-decomposition`,
              }}
              disabled={busy || !text}
              run={async () => (await send({ text, attachments }, "respec")) && clear()}
            />
            <SendAs
              label={t`Don't proceed`}
              tip={t`Stop dispatching; branch is kept but not merged. A retrospective is still required.`}
              spec={{
                title: t`Abandon this requirement`,
                body: t`Stop dispatching; branch is kept but not merged. A retrospective is still required.`,
                yes: t`Abandoned`,
                danger: true,
              }}
              disabled={busy || !text}
              run={async () => (await send({ text, attachments }, "reject")) && clear()}
            />
          </>
        )}
      />
    </>
  );
}

function Draft({ st, g, refresh }: { st: State; g: Group; refresh: () => void }) {
  const { t } = useLingui();
  const { filed, idea, late, proposal, unknown } = draftView(st, g.id);
  const [card, setCard] = useState(filed);

  return (
    <>
      {idea && <div className="my-2 border-l border-rule pl-2.5 text-body text-ink-2">{idea}</div>}
      {/* An objection that arrived after the card was filed. Without this the card
          reads `Objection: none` and the boss approves a plan somebody already argued with. */}
      {late.map((o) => (
        <div
          key={`${o.author}:${o.body}`}
          className="my-2 break-words whitespace-pre-wrap rounded-md bg-sunk px-2.5 py-2 text-secondary"
        >
          <b className="font-semibold text-warn">
            <Trans>{{ who: o.author }} objected after the fact</Trans>
          </b>{" "}
          {o.body}
        </div>
      ))}
      {/* A plan that creates a file names it, so this is not an error — but a plan
          written from memory of the codebase instead of from reading it also names
          files that were never there, and that is the cheapest visible symptom of a
          decomposition pointed the wrong way. Reviewing the card is where that gets
          caught. */}
      {unknown.length > 0 && (
        <div className="my-2 rounded-md bg-sunk px-2.5 py-2 text-secondary">
          <b className="font-semibold text-warn">
            <Trans>These paths from the card don't exist in the repo</Trans>
          </b>{" "}
          <span className="font-mono">{unknown.join(t`, `)}</span>
          <div className="mt-1 text-ink-3">
            <Trans>
              New files are expected; if it thinks these already exist, the card was written from speculation.
            </Trans>
          </div>
        </div>
      )}
      {/* A planner found this is already covered, and the server checked the
          evidence before this row could exist. Offering it beside the card is the
          point: without it the boss reads a full plan for work nobody needs. */}
      {proposal && <DropProposal g={g} body={proposal.body} refresh={refresh} />}
      {!filed ? (
        // Nothing to approve yet. An empty textarea and an approve button asks the
        // boss to sign off on nothing, which is why this screen read as "what am I meant to do".
        <Working>
          <Trans>Dispatcher is writing the plan card; it will appear here when done.</Trans>
        </Working>
      ) : g.approved_at ? (
        // Already decided. Showing `Approve and start` again asks for a click that changes
        // nothing and reads as "the last one was ignored" — which is what it was.
        // `Return for re-decomposition` below is still the way out: it withdraws the approval.
        <>
          <div className="my-2 rounded-md bg-sunk px-2.5 py-2 text-body">
            <b className="font-semibold text-warn">
              <Trans>Approved, blocked by boundaries</Trans>
            </b>{" "}
            {blockedReason(st, g.id)}
          </div>
          <Working>
            <Trans>Once boundaries are cleared, work starts automatically; no need to click again.</Trans>
          </Working>
        </>
      ) : (
        <>
          <Textarea
            rows={cardRows(filed)}
            value={card}
            onChange={(e) => setCard(e.target.value)}
            aria-label={t`Plan card`}
          />
          <div className="mt-3 flex items-baseline gap-3">
            <Button
              variant="go"
              onClick={async () => {
                await mutate(
                  api.draft[":id"][":decision"].$post({
                    param: { id: String(g.id), decision: "approve" },
                    json: approveBody(card, filed),
                  }),
                );
                refresh();
              }}
            >
              <Trans>Approve and start</Trans>
            </Button>
            <span className="text-secondary text-ink-3">
              <Trans>You can edit the card and re-approve.</Trans>
            </span>
          </div>
        </>
      )}
      <Exits g={g} refresh={refresh} projectId={g.project_id} />
    </>
  );
}

/** A planner's case that this requirement is already covered, and the two answers to it. */
function DropProposal({ g, body, refresh }: { g: Group; body: string; refresh: () => void }) {
  const { t } = useLingui();
  return (
    <div className="my-3 rounded-md border border-warn/40 bg-sunk px-3 py-2.5">
      <div className="text-body font-semibold text-warn">
        <Trans>Planner suggests abandoning</Trans>
      </div>
      <div className="my-1 break-words whitespace-pre-wrap text-body">{body}</div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          variant="go"
          size="sm"
          onClick={confirmThen(
            {
              title: t`Abandon this requirement`,
              body: t(dropBody(g.name)),
              yes: t`Abandoned`,
              danger: true,
            },
            () => groupAction(g.id, "drop", { why: firstLine(body) }),
            refresh,
          )}
        >
          <Trans>Confirm abandonment</Trans>
        </Button>
        <Button
          size="sm"
          onClick={async () => {
            await mutate(
              api.say.$post({
                json: {
                  group_id: g.id,
                  body: t`It's not a duplicate, and it's not done yet — keep decomposing.`,
                  as: "respec",
                },
              }),
            );
            refresh();
          }}
        >
          <Trans>No, keep going</Trans>
        </Button>
      </div>
    </div>
  );
}

/**
 * The other three things the boss can say here, with the box to say them in —
 * next to the card they are about, not at the bottom of the page.
 *
 * Each button says who receives the sentence, because the same words mean three
 * different things depending on which one is pressed.
 */
function Exits({ g, refresh, projectId }: { g: Group; refresh: () => void; projectId: number }) {
  const { t } = useLingui();
  const send = async (d: Draft, as: "patch" | "respec") => {
    const r = await mutate(api.say.$post({ json: { group_id: g.id, body: d.text, attachments: d.attachments, as } }));
    refresh();
    return r.ok;
  };
  return (
    <div className="mt-4 border-t border-rule-soft pt-3">
      <Composer
        rows={2}
        projectId={projectId}
        placeholder={t`Add requirements or explain why you're rejecting. Paste screenshots or designs; / to insert a skill. Cmd+Enter to request changes`}
        submit={t`Request changes`}
        onSubmit={(d) => send(d, "patch")}
        actions={({ text, attachments, busy, clear }) => (
          <>
            <SendAs
              label={t`Return for re-decomposition`}
              tip={t(respecBody(false))}
              spec={{
                title: t`Return for re-decomposition`,
                body: t(respecBody(false)),
                yes: t`Return for re-decomposition`,
              }}
              disabled={busy || !text}
              run={async () => (await send({ text, attachments }, "respec")) && clear()}
            />
            {/* Not a red button. Two filled buttons on one row and the destructive
                one outweighs `Approve and start`, which is the answer this screen usually wants.
                The confirm carries the weight instead. */}
            <SendAs
              label={t`Don't proceed`}
              tip={t`Cancel all queued turns; return the occupied slot to another group.`}
              spec={{
                title: t`Don't proceed`,
                body: t(dropBody(g.name)),
                yes: t`Don't proceed`,
                danger: true,
              }}
              disabled={busy}
              run={async () => {
                await groupAction(g.id, "drop", { why: text });
                refresh();
              }}
            />
          </>
        )}
      />
      <div className="mt-1.5 text-secondary text-ink-3">
        <Trans>Both go to Dispatcher; it will revise the card and bring it back for your approval.</Trans>
      </div>
    </div>
  );
}

/**
 * One open question.
 *
 * `break-words` is load-bearing: an escalation often quotes a shell line with no
 * spaces in it, which sets a minimum width on the row and pushed the entire page
 * into a horizontal scroll — the content was there, just off the left edge.
 */
function Ask({ e, refresh, open }: { e: Escalation; refresh: () => void; open: boolean }) {
  const { t } = useLingui();
  // Seeding by remount: the composer owns its text once the boss starts typing,
  // and a controlled value here would fight them for it. Nothing is sent by the
  // draft — its button fills the box and the boss sends it.
  //
  // Keyed by a counter, not by the text. Keyed by the text, pressing `Fill in` a
  // second time produced the same key, so the composer never remounted and the
  // button did nothing — which is exactly when you press it: after editing the
  // draft into something worse and wanting it back.
  const [seed, setSeed] = useState<{ n: number; text: string }>({ n: 0, text: "" });
  // Asked for, never automatic: on open this is a model call per question the
  // boss so much as looks at, and most are answered without wanting a draft. The
  // button is in the composer's own row, where the other writing aids are.
  const [draft, setDraft] = useState<{ busy: boolean; text?: string }>({ busy: false });
  const askDraft = () => {
    if (draft.busy) return;
    setDraft({ busy: true });
    void readApi(api.escalations[":id"].draft.$get({ param: { id: String(e.id) } }), AnswerDraftSchema).then((r) =>
      setDraft({
        busy: false,
        text: r?.text?.trim() || t`Could not generate a draft; you'll need to write this one yourself.`,
      }),
    );
  };
  return (
    <>
      {/* Who is waiting, how long, and what it costs — in that order, because the
          cost is what decides which of two questions to open first. It read
          `qa · blocked · awaiting your decision · waiting 3h` inside the tab of the same
          name: the tab already said the third, and "waiting" is what a duration means.

          Collapsed, the question gets two lines rather than one truncated one. A
          question cut mid-clause cannot be triaged, which is the only thing a
          closed row is for. */}
      <AccordionTrigger className="block px-4 py-2.5 transition-colors hover:bg-accent-soft">
        <div className="flex flex-wrap items-baseline gap-x-2 font-mono text-meta">
          <span className="text-ink-2">{e.asker ?? t`System`}</span>
          <span className="text-ink-3">{waited(e.created_at)}</span>
          {e.severity === "blocker" && (
            <span className="font-semibold text-bad">
              <Trans>Entire group is paused</Trans>
            </span>
          )}
        </div>
        {!open && (
          <div className="mt-1 line-clamp-2 max-w-[72ch] text-body text-ink-2">{nl(saidText(e.said, e.question))}</div>
        )}
      </AccordionTrigger>

      <AccordionBody className="bg-paper px-4 pb-3">
        {/* An exchange: what was asked on the left, what you say back on the
            right. The page already showed a stand-in's answers this way and this
            is the same thing one step earlier — a question, a proposed reply, and
            the box you actually send from. Read as a form (question, draft box,
            composer, three buttons) it was four blocks; read as two sides it is
            one conversation with a gap where your answer goes.

            Six lines, then a click. A watchdog escalation quotes three QA verdicts
            verbatim and runs to fifteen — the decision is usually made by line
            three, with the rest there to check the reasoning against. */}
        <Asked body={saidText(e.said, e.question)} />
        {draft.busy && <Typing label={t`AI is thinking on your behalf`} />}
        {draft.text && (
          // On your side of the exchange, because that is what it is: a reply
          // nobody has sent. Dashed, so it cannot be mistaken for one that went.
          <div className="my-2 ml-auto max-w-[46rem] rounded-2xl rounded-tr-sm border border-dashed border-rule bg-paper px-3.5 py-2">
            <div className="flex items-baseline gap-2">
              <Tip
                label={t`Generated from this group's notes; not yet sent to anyone. You can edit after filling it in.`}
              >
                <Meta className="cursor-help">
                  <Trans>AI-drafted response</Trans>
                </Meta>
              </Tip>
              <span className="grow" />
              <Button size="sm" onClick={() => setSeed((p) => ({ n: p.n + 1, text: draft.text! }))}>
                <Trans>Fill in</Trans>
              </Button>
            </div>
            <div className="mt-1 whitespace-pre-wrap break-words text-body text-ink-2">
              <Clamp lines={3}>{nl(draft.text)}</Clamp>
            </div>
          </div>
        )}
        <div className="ml-auto mt-2 max-w-[46rem]">
          <Composer
            key={seed.n}
            initial={seed.text}
            rows={2}
            placeholder={t`Reply. Sending this will unblock the waiting agent. Cmd+Enter to send`}
            submit={t`Reply`}
            onSubmit={async ({ text, attachments }) => {
              const r = await mutate(
                api.escalations[":id"].answer.$post({
                  param: { id: String(e.id) },
                  json: { answer: text, attachments },
                }),
              );
              refresh();
              return r.ok;
            }}
            actions={({ text, busy }) => (
              <>
                <Tip label={t`Generate a draft from this group's notes without sending it.`}>
                  <Button size="sm" variant="quiet" disabled={draft.busy} onClick={askDraft}>
                    {draft.text ? t`Generate another` : t`Let AI generate one`}
                  </Button>
                </Tip>
                <Tip
                  label={t`Architect decides on tech choices and architectural boundaries; if they can't answer, they'll come back.`}
                >
                  <Button
                    size="sm"
                    onClick={async () => {
                      await mutate(
                        api.escalations[":id"].delegate.$post({
                          param: { id: String(e.id) },
                          json: { to: "architect" },
                        }),
                      );
                      refresh();
                    }}
                  >
                    <Trans>Delegate to Architect</Trans>
                  </Button>
                </Tip>
                {/* The commonest blocker here is one no answer resolves — a config file
                  is wrong, a shared fixture is broken. Answering it means typing the
                  fix into a chat box for an agent that is not allowed to apply it, so
                  these sat in `To do` until the boss did the work by hand.

                  Not `go`: two filled violet buttons side by side is two primaries,
                  and answering is the primary here. */}
                <Tip
                  label={t`Convert to a requirement; this group will automatically continue after it's implemented.`}
                >
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={async () => {
                      const r = await mutate(
                        api.escalations[":id"].requirement.$post({
                          param: { id: String(e.id) },
                          json: { text },
                        }),
                      );
                      refresh();
                      if (r.ok) toast.success(r.text);
                    }}
                  >
                    <Trans>Create requirement</Trans>
                  </Button>
                </Tip>
              </>
            )}
          />
        </div>
      </AccordionBody>
    </>
  );
}

/** What was asked, on the asker's side of the exchange. */
function Asked({ body, className, tone }: { body: string; className?: string; tone?: string }) {
  return (
    <div className={cn("max-w-[46rem] rounded-2xl rounded-tl-sm bg-rail px-3.5 py-2", className)}>
      <Clamp lines={6}>
        <WithAttachments body={body} className={cn("text-body", tone)} />
      </Clamp>
    </div>
  );
}

/**
 * Questions somebody else in the chain is still holding.
 *
 * Nothing here is the boss's move — the PM or the Architect answers it, or
 * abstains and passes it up, at which point it moves to the list above. One line
 * each: who is holding it, how long, and the first line of what was asked.
 * Reference, not work.
 */
function Held({ rows }: { rows: Escalation[] }) {
  const { t } = useLingui();
  return (
    <div className="overflow-hidden rounded-lg border border-rule-soft">
      {rows.map((e) => (
        // Open, always. Folding is for a list you choose from, and there is
        // nothing to choose here — the question and the fact that somebody is
        // writing back are the whole content.
        <div key={e.id} className="border-t border-rule-soft px-4 py-2.5 first:border-t-0">
          <div className="flex flex-wrap items-baseline gap-x-2 font-mono text-meta text-ink-3">
            <span className="text-ink-2">{e.asker ?? t`System`}</span>
            <span>{waited(e.created_at)}</span>
          </div>
          <Asked body={e.question} className="mt-1.5" tone="text-ink-2" />
          <Typing label={labelOf(WHERE_LABEL[e.chain_state], e.chain_state)} />
        </div>
      ))}
    </div>
  );
}
