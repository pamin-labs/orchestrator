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
  type PanelFrame,
  type Group,
  type Slice,
  type State,
} from "../../shared/api";
import { asksOf, gates, mineOf, prUrl, statusLabel, WHERE_ZH } from "../../shared/select";
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

/**
 * Confirm, then act, then refresh — the shape every consequential control here has.
 *
 * Each of them spelled it out: a `const go`, an early return, the call, the
 * refresh. Four lines of ceremony per button, and the early return is the one
 * that gets forgotten.
 */
const confirmThen = (spec: AskSpec, run: () => Promise<unknown>, refresh?: () => void) => async () => {
  if (!(await ask(spec))) return;
  await run();
  refresh?.();
};

/**
 * One requirement, arranged so exactly one thing is the target of action.
 *
 * The first version stacked everything at full weight: identity, five controls, three
 * slices each with its own gate row, an evidence panel that pushed the last slice off
 * the fold, then delegated answers, then records, then the roster, then a composer.
 * Nine blocks of equal loudness, and the boss's job on this page is one of three
 * things — approve the plan, accept a slice, answer a question.
 *
 * So: a header that states what this is and hides the rare controls in a menu; the
 * slices as a compact ordered list where the row that needs you is selected; the
 * detail of that one slice underneath it, with its actions; everything else (records,
 * stand-in answers, roster) behind tabs. Read top to bottom it says what happened,
 * what needs you, and what to type — in that order.
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
    // Four things this page holds, and they were stacked in two columns down one
    // scroll: questions, slices, the record, the roster — plus a composer that
    // ended up below however many slices there were. Tabs put one at a time in
    // front of the boss, each scrolling inside itself, with the header and the
    // box you type into pinned. Long shell commands inside an escalation used to
    // push the whole page into a horizontal scroll; every column is min-w-0 and
    // the text breaks now.
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
              切片
            </Tab>
            {/* Only the ones on the boss are 待你决策. The rest are open questions
                the chain is still holding, and counting them under that heading
                made the badge lie about how much of this was a decision. */}
            <Tab value="ask" count={asks.length} mine={mine.length > 0}>
              {askTabLabel(mine.length)}
            </Tab>
            <Tab value="notes" {...countProps(notes)}>
              记录
            </Tab>
            {/* No count: a container is one or none, and a badge reading 1 next
                to 工作区 says nothing the tab does not already. */}
            <Tab value="work">工作区</Tab>
            {/* No count either, and for a stronger reason than 工作区's: the number
                of spans a requirement has produced is not a quantity anybody is
                waiting on, and a badge reading 1,482 beside 耗时 would be the
                loudest number on the tab strip while meaning the least. */}
            <Tab value="time">耗时</Tab>
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
              <Telemetry scope={{ kind: "group", id: g.id }} empty="这个需求还没跑过任何活。" />
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
 * The evidence opens under the row it belongs to. It used to sit in a second
 * pane below the whole list, so the diff for S2 was drawn under S3 and the row
 * it answers was two rows away from the two buttons that answer it. One
 * accordion: rows and the one open body in the same scroll, the evidence header
 * pinned inside it so the verdict buttons stay reachable while you read the diff.
 *
 * The box hugs its rows and is capped at what is left of the screen — not
 * `flex-1`, which drew an 800px empty frame under three closed rows. The scroll
 * still lives here once the open slice outgrows the pane.
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
        <Working>正在拆解</Working>
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
 * Three kinds of thing, one at a time, with their counts on the switch.
 *
 * Stacked down one scroll they were invisible: at the top of the page nothing
 * said a question was being held by the Architect or that a stand-in had
 * answered two of them — you found out by scrolling past the box you came to
 * type in. A switch says it in three words without moving anything.
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
          <div className="text-[0.8125rem] text-ink-3">没有开着的问题。这一组的人现在不等你。</div>
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
            roster tab: 这个组的人 listed role, activity, turns and tokens for
            every agent in the group — the 工位墙 in miniature, one column
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
 * A group's container is replaceable — the TTL reaps an idle one, a credential
 * change kills it — and what follows a rebuild is a clone and an install that
 * can run for minutes. Until this pane existed the page said nothing for all of
 * it: the requirement simply sat there, which is indistinguishable from stuck.
 *
 * Live frames only, so it is gone on reload and the outcome line in the record
 * is what remains. Nothing here is stored twice.
 */
function Bootstrap({ frames, grpId }: { frames: PanelFrame[]; grpId: number }) {
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
        <Step label="克隆" state={cloneStep(cmd, failed)} />
        <Step label="装依赖" state={installStep(cmd, failed, until)} />
        <Meta className="min-w-0 flex-1 truncate">{bootCmd(cmd)}</Meta>
        <Meta className={cn(failed && "text-bad")}>{bootClock(failed, bootSecs(since, until, now))}</Meta>
        <Button variant="quiet" size="sm" aria-expanded={!shut} onClick={() => setShut((v) => !v)}>
          {shut ? "看日志" : "收起"}
        </Button>
      </div>
      {!shut && lines.length > 0 && (
        <div
          ref={box}
          role="log"
          aria-label="装环境的输出"
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
          className={cn(
            "mt-2 max-h-40 overflow-y-auto rounded-md bg-sunk px-2.5 py-2 font-mono text-[0.6875rem]",
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
      {failed && <Meta className="mt-1.5 block">交给 bootstrap 重试，它会带着上面的报错读一遍仓库</Meta>}
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
      <span className={cn("text-[0.75rem]", state === "wait" ? "text-ink-3" : "text-ink-2")}>{label}</span>
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
      <span className="font-display text-[1.25rem] font-semibold">{g.name}</span>
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
        {showQueued(inQueue, g) && <Badge>排队中</Badge>}
        {g.status === "RUNNING" && <Button onClick={() => act("pause")}>暂停</Button>}
        {canResume(g, overBudget(g)) && <Button onClick={() => act("resume")}>继续</Button>}
        {g.status === "PARKED" && (
          <Button variant="go" onClick={() => act("wake")}>
            唤醒
          </Button>
        )}
        <HeaderMenu g={g} refresh={refresh} />
      </span>
    </div>
  );
}

/**
 * Interrupt and park are rare and consequential. Sitting in the header at the
 * same weight as 暂停 they read as ordinary, and one of them discards a turn's
 * work.
 */
function HeaderMenu({ g, refresh }: { g: Group; refresh: () => void }) {
  const running = isRunning(g);
  return (
    <Menu label="更多">
      {running && (
        <MenuItem
          hint="停止当前 turn，改动留着，下一个 turn 会被告知"
          onSelect={async () => {
            await groupAction(g.id, "interrupt", { mode: "keep" });
            refresh();
          }}
        >
          打断，保留改动
        </MenuItem>
      )}
      {running && (
        <MenuItem
          danger
          hint="回到这一轮开始前的 checkpoint，这个 turn 的改动全丢"
          onSelect={confirmThen(
            {
              title: "打断并回滚",
              body: "丢弃当前 turn 的全部改动，退回到这一轮开始前。",
              yes: "打断并回滚",
              danger: true,
            },
            () => groupAction(g.id, "interrupt", { mode: "rollback" }),
            refresh,
          )}
        >
          打断并回滚
        </MenuItem>
      )}
      {canPark(g) && (
        <MenuItem hint="释放并发槽，沙盒里的代码和 checkpoint 原地不动" onSelect={() => actThen(g, "park", refresh)}>
          封存
        </MenuItem>
      )}
      <MenuItem
        hint="容器卡住、少挂了东西、或换过凭据时用。下一个 turn 重新 clone + 装依赖，分支在宿主仓库里不会丢"
        onSelect={confirmThen(
          {
            title: "重开容器",
            body: `${g.name} 的容器会被扔掉，下一个 turn 重建：重新 clone 分支、重装依赖。没提交的改动会丢。`,
            yes: "重开",
          },
          () => groupAction(g.id, "rebuild"),
          refresh,
        )}
      >
        重开容器
      </MenuItem>
      {/* 退回重拆 sends it back to the Dispatcher, which writes another card for
          work nobody wants. A requirement that turned out to be a duplicate, or
          that someone already fixed, needs to leave the board instead. */}
      <MenuItem
        danger
        hint="排队的 turn 全取消，占的路径交还给别的组。代码、分支和记录都留着"
        onSelect={confirmThen(
          {
            title: "不做了",
            body: `${g.name} 会从看板上消失，排队的 turn 全部取消。代码和记录留着，组不会再被拉起。`,
            yes: "不做了",
            danger: true,
          },
          () => groupAction(g.id, "drop"),
          refresh,
        )}
      >
        不做了
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
      <span className="font-mono text-[0.75rem] text-ink-3">S{s.seq}</span>
      <span className="min-w-0">
        <span className="block truncate text-[0.8125rem]">
          {s.title} <span className="font-mono text-[0.625rem] text-ink-3">{s.difficulty}</span>
        </span>
        <span className="block truncate font-mono text-[0.6875rem] text-ink-3">
          {sliceLine(s, runningAgents(st, g.id))}
        </span>
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
      {tickStops(s.status === "awaiting_boss").map(([k, zh]) => {
        const v = tickState(s, k, gs);
        return (
          <span key={k} className={cn("flex items-center gap-1 text-[0.6875rem]", tickTextClass(v))}>
            <span className={cn("size-2 rounded-full border", tickDotClass(v, s.status === k))} />
            <b className="whitespace-nowrap font-medium max-[64rem]:hidden">{zh}</b>
          </span>
        );
      })}
    </span>
  );
}

/** The selected slice, in full: what it promised, what it did, and the two buttons. */
function SliceDetail({ st, s, refresh }: { st: State; s: Slice; refresh: () => void }) {
  const tasks = st.tasks.filter((t) => t.slice_id === s.id);
  // A header saying `S2 <title> 验收：<spec>` sat here, directly under the lane row
  // that says S2 and the title, directly above the evidence panel that leads with
  // the acceptance line. Three copies of two facts, stacked. The buttons were the
  // only thing here that was not a repeat, so they moved next to the evidence they
  // are a verdict on.
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
          查收
        </Button>
        <RejectSlice sliceId={s.id} refresh={refresh} />
      </span>
    );

  if (s.status === "pending") {
    return (
      <div className="border-t border-rule-soft py-2 pl-14 pr-3 text-[0.75rem] text-ink-3">
        还没开工，等前面的切片查收。
      </div>
    );
  }
  return (
    <div className="border-t border-rule-soft">
      {showTasks(tasks, s) && (
        <ul className="list-none border-b border-rule-soft py-1.5 pl-14 pr-3">
          {tasks.map((t) => (
            <li key={t.id} className="flex gap-2 py-px text-[0.75rem]">
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
  return (
    <Button
      variant="go"
      onClick={confirmThen(
        {
          title: "开一个新 PR",
          body: "能在 GitHub 上重开旧 PR 就不用这个。分支被强推或删过才用：会用当前分支重提一个，回到合入队列。",
          yes: "开新 PR",
        },
        async () => {
          const r = await groupAction(grpId, "newpr");
          if (!r.ok) await ask({ title: "开不出来", body: r.text, yes: "知道了" });
        },
        refresh,
      )}
    >
      开新 PR
    </Button>
  );
}

/**
 * Sending a slice back.
 *
 * The words are the whole payload: they become a blackboard fact and the PM plans
 * the correction from them, so this is the same composer as everywhere else and
 * takes a screenshot of what is wrong.
 */
function RejectSlice({ sliceId, refresh }: { sliceId: number; refresh: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>不满意</Button>
      <ComposerDialog
        open={open}
        onOpenChange={setOpen}
        title="退回这一片"
        hint="原话记进黑板，PM 据此安排修正。截图直接粘。"
        placeholder="哪里不满意。⌘Enter 退回"
        submit="退回"
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
  if (g.budget_tokens == null) {
    return (
      <button
        type="button"
        className="cursor-pointer font-mono text-[0.6875rem] text-ink-3 underline decoration-dotted hover:text-ink"
        onClick={async () => {
          const v = await ask({
            title: "给这个需求设 token 上限",
            body: "用满就挂起，等你决定加不加。",
            yes: "设定",
            field: "例如 2000000",
          });
          const n = Number(String(v ?? "").replace(/[^\d]/g, ""));
          if (n > 0) await setBudget(g, n, refresh);
        }}
      >
        无预算上限
      </button>
    );
  }
  const frac = g.spent_tokens / g.budget_tokens;
  return (
    <Tip label={`${g.spent_tokens} / ${g.budget_tokens} tokens。用满即挂起全组。`}>
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
 * 继续 was a button that looked like it worked and changed nothing — the next tick
 * suspended it again. Raising the cap is the only thing that moves it.
 */
function BudgetWall({ g, refresh }: { g: Group; refresh: () => void }) {
  // `budget_tokens` is nullable in the column and the browser used to declare it
  // a `number` — so "no cap set" arrived as null and this computed NaN, which is
  // what the raise-the-budget field would have been pre-filled with.
  const doubled = Math.max((g.budget_tokens ?? 0) * 2, g.spent_tokens + 100_000);
  return (
    <Card tone="mine" className="mt-2.5">
      <CardBody>
        <CardTitle className="text-[0.9375rem] text-accent">预算用尽，全组挂起</CardTitle>
        <div className="mt-0.5 text-[0.75rem] text-ink-2">
          已花 {K(g.spent_tokens)} tokens，上限 {K(g.budget_tokens)}。 加上限才动得了，「继续」不生效。
        </div>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <Button variant="go" onClick={() => setBudget(g, doubled, refresh)}>
            翻倍到 {K(doubled)}
          </Button>
          <Button onClick={() => setBudget(g, null, refresh)}>取消上限</Button>
          <Button variant="quiet" onClick={() => actThen(g, "park", refresh)}>
            就停在这里（封存）
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
  // an empty block would have contained is the page reporting an absence, which
  // is what PRODUCT.md says an empty state must not do — and this one sat under
  // the question the boss was there to answer.
  if (!rows.length) return null;
  return (
    <div className="overflow-hidden rounded-lg border border-rule-soft">
      {rows.map((a) => (
        // Question, then answer, in the order they happened, at a measure that
        // can be read. Both used to run the full width of the page, the question
        // in body text and the answer in a grey slab under it — two paragraphs
        // of somebody else's words at the weight of live work.
        <div key={a.id} className="border-t border-rule-soft px-4 py-2.5 first:border-t-0">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[0.6875rem] text-ink-3">{a.answered_by} 代答</span>
            <span className="grow" />
            <Button
              variant="quiet"
              size="sm"
              onClick={confirmThen(
                {
                  title: "撤销并接管",
                  body: "回滚到提问时的 checkpoint，之后的改动作废，由你重新回答。",
                  yes: "撤销并接管",
                  danger: true,
                },
                () => mutate(api.escalations[":id"].revoke.$post({ param: { id: String(a.id) } })),
                refresh,
              )}
            >
              撤销并接管
            </Button>
          </div>
          {/* An exchange, laid out as one: what was asked on the left, what was
                said back on the right. Labelled rows in a gutter (`问` / `答`) read
                as a form, and a paragraph over a grey slab read as two unrelated
                blocks — this is a conversation the boss was not in, and the shape
                everyone already knows for that is two sides. */}
          <div className="mt-1.5 space-y-1.5">
            <div className="max-w-[46rem] rounded-2xl rounded-tl-sm bg-rail px-3.5 py-2 text-[0.75rem] text-ink-3">
              <Clamp lines={3}>{nl(a.question)}</Clamp>
            </div>
            <div className="flex justify-end">
              <div className="max-w-[46rem] rounded-2xl rounded-tr-sm border border-rule bg-paper px-3.5 py-2 text-[0.8125rem] text-ink-2">
                <Clamp lines={3}>{nl(a.answer)}</Clamp>
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
                   bg-paper px-3 py-2 text-left text-[0.8125rem] text-ink-3 transition-colors hover:border-ink-3"
      >
        跟这个组说话…
        <span className="grow" />
        <Meta>⌘Enter 发给 PM</Meta>
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
 * 方向错了, 不做了 and 退回重拆 are the same control three times: a tip saying who
 * receives the sentence, a confirm carrying the weight, and a send that clears
 * the box only if it went. Each one had written that out.
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
  const send = async (d: Draft, as?: "patch" | "respec" | "reject") => {
    const r = await mutate(
      api.say.$post({
        json: { group_id: g.id, body: d.text, attachments: d.attachments, ...(as ? { as } : {}) },
      }),
    );
    refresh();
    return r.ok;
  };

  // Before approval the exits live next to the approve button, where the decision
  // is. A second composer down here asked the boss to type into whichever one they
  // found first, and neither said where the words would go.
  if (isDraft(g)) return null;

  return (
    <>
      <H2 className="mt-6">跟这个组说话</H2>
      <Composer
        rows={2}
        projectId={projectId}
        placeholder="下一个 turn 开头就会读到。截图直接粘，/ 插技能路径。⌘Enter 发给 PM"
        submit="发给 PM"
        onSubmit={(d) => send(d)}
        actions={({ text, attachments, busy, clear }) => (
          <>
            <span className="mr-1 text-[0.75rem] text-ink-3 max-[40rem]:hidden">分量：</span>
            <Tip label="原话记进黑板，PM 安排一条修正 task，组继续跑">
              <Button
                size="sm"
                disabled={busy || !text}
                onClick={async () => (await send({ text, attachments }, "patch")) && clear()}
              >
                要改一处
              </Button>
            </Tip>
            <SendAs
              label="方向错了"
              tip="整个需求退回 Dispatcher 重新深挖，已写的代码留在分支上"
              spec={{
                title: "退回重新拆解",
                body: "这句话作为最高优先级 fact，整个需求退回 Dispatcher 重新深挖。已写的代码留在分支上。",
                yes: "退回重拆",
              }}
              disabled={busy || !text}
              run={async () => (await send({ text, attachments }, "respec")) && clear()}
            />
            <SendAs
              label="不做了"
              tip="停止派发，分支保留不合入，仍然要写 retro"
              spec={{
                title: "作废这个需求",
                body: "停止派发，分支保留不合入。仍然要求写 retro。",
                yes: "作废",
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
  const { filed, idea, late, proposal, unknown } = draftView(st, g.id);
  const [card, setCard] = useState(filed);

  return (
    <>
      {idea && <div className="my-2 border-l border-rule pl-2.5 text-[0.8125rem] text-ink-2">{idea}</div>}
      {/* An objection that arrived after the card was filed. Without this the card
          reads 反对 : 无 and the boss approves a plan somebody already argued with. */}
      {late.map((o) => (
        <div
          key={`${o.author}:${o.body}`}
          className="my-2 break-words whitespace-pre-wrap rounded-md bg-sunk px-2.5 py-2 text-[0.75rem]"
        >
          <b className="font-semibold text-warn">{o.author} 后补反对</b> {o.body}
        </div>
      ))}
      {/* A plan that creates a file names it, so this is not an error — but a plan
          written from memory of the codebase instead of from reading it also names
          files that were never there, and that is the cheapest visible symptom of a
          decomposition pointed the wrong way. Reviewing the card is where that gets
          caught. */}
      {unknown.length > 0 && (
        <div className="my-2 rounded-md bg-sunk px-2.5 py-2 text-[0.75rem]">
          <b className="font-semibold text-warn">卡里这些路径仓库里没有</b>{" "}
          <span className="font-mono">{unknown.join("、")}</span>
          <div className="mt-1 text-ink-3">新建的文件正常；如果它以为这些已经存在，这张卡是照着想象写的。</div>
        </div>
      )}
      {/* A planner found this is already covered, and the server checked the
          evidence before this row could exist. Offering it beside the card is the
          point: without it the boss reads a full plan for work nobody needs. */}
      {proposal && <DropProposal g={g} body={proposal.body} refresh={refresh} />}
      {!filed ? (
        // Nothing to approve yet. An empty textarea and an approve button asks the
        // boss to sign off on nothing, which is why this screen read as "我该干嘛".
        <Working>Dispatcher 正在写计划卡，写完出现在这里</Working>
      ) : g.approved_at ? (
        // Already decided. Showing 批准开工 again asks for a click that changes
        // nothing and reads as "the last one was ignored" — which is what it was.
        // 退回重拆 below is still the way out: it withdraws the approval.
        <>
          <div className="my-2 rounded-md bg-sunk px-2.5 py-2 text-[0.8125rem]">
            <b className="font-semibold text-warn">已批准，边界挡着</b> {blockedReason(st, g.id)}
          </div>
          <Working>让开之后自动开工，不用再点一次</Working>
        </>
      ) : (
        <>
          <Textarea rows={cardRows(filed)} value={card} onChange={(e) => setCard(e.target.value)} aria-label="计划卡" />
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
              批准开工
            </Button>
            <span className="text-[0.75rem] text-ink-3">卡可以直接改再批</span>
          </div>
        </>
      )}
      <Exits g={g} refresh={refresh} projectId={g.project_id} />
    </>
  );
}

/** A planner's case that this requirement is already covered, and the two answers to it. */
function DropProposal({ g, body, refresh }: { g: Group; body: string; refresh: () => void }) {
  return (
    <div className="my-3 rounded-md border border-warn/40 bg-sunk px-3 py-2.5">
      <div className="text-[0.8125rem] font-semibold text-warn">规划岗建议作废</div>
      <div className="my-1 break-words whitespace-pre-wrap text-[0.8125rem]">{body}</div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          variant="go"
          size="sm"
          onClick={confirmThen(
            {
              title: "作废这条需求",
              body: `${g.name} 会从看板上消失，排队的 turn 全部取消。代码和记录都留着。`,
              yes: "作废",
              danger: true,
            },
            () => groupAction(g.id, "drop", { why: firstLine(body) }),
            refresh,
          )}
        >
          确认作废
        </Button>
        <Button
          size="sm"
          onClick={async () => {
            await mutate(
              api.say.$post({
                json: { group_id: g.id, body: "不是重复，也不算已经做完了 —— 接着拆。", as: "respec" },
              }),
            );
            refresh();
          }}
        >
          不，接着做
        </Button>
      </div>
    </div>
  );
}

/**
 * The other three things the boss can say here, with the box to say them in.
 *
 * There were two: 批准开工 and 退回重拴, and the box to type in was at the very
 * bottom of the page under everything else — so the words the boss added while
 * looking at the card went somewhere they could not see, and "要求修改" and
 * "不做了" did not exist at all. A duplicate requirement could not be turned away.
 *
 * Each button says who receives the sentence, because the same words mean three
 * different things depending on which one is pressed.
 */
function Exits({ g, refresh, projectId }: { g: Group; refresh: () => void; projectId: number }) {
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
        placeholder="补充要求，或者写退回理由。截图、设计稿直接粘，/ 插技能路径。⌘Enter 要求修改"
        submit="要求修改"
        onSubmit={(d) => send(d, "patch")}
        actions={({ text, attachments, busy, clear }) => (
          <>
            <SendAs
              label="退回重拆"
              tip="整条需求退回 Dispatcher 重新深挖，这句话作为最高优先级 fact"
              spec={{
                title: "退回重新拆解",
                body: "整个需求退回 Dispatcher 重新深挖，这句话作为最高优先级 fact。",
                yes: "退回重拆",
              }}
              disabled={busy || !text}
              run={async () => (await send({ text, attachments }, "respec")) && clear()}
            />
            {/* Not a red button. Two filled buttons on one row and the destructive
                one outweighs 批准开工, which is the answer this screen usually wants.
                The confirm carries the weight instead. */}
            <SendAs
              label="不做了"
              tip="排队的 turn 全取消，占的路径交还给别的组"
              spec={{
                title: "不做了",
                body: `${g.name} 会从看板上消失，排队的 turn 全部取消。代码和记录都留着。`,
                yes: "不做了",
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
      <div className="mt-1.5 text-[0.75rem] text-ink-3">两个都发给 Dispatcher，它改完卡再回来给你批。</div>
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
  // Seeding by remount: the composer owns its text once the boss starts typing,
  // and a controlled value here would fight them for it. Nothing is sent by the
  // draft — its button fills the box and the boss sends it.
  //
  // Keyed by a counter, not by the text. Keyed by the text, pressing 填进输入框 a
  // second time produced the same key, so the composer never remounted and the
  // button did nothing — which is exactly when you press it: after editing the
  // draft into something worse and wanting it back.
  const [seed, setSeed] = useState<{ n: number; text: string }>({ n: 0, text: "" });
  // Asked for, never automatic. Opening a question used to fire a model call —
  // one per open, on every question the boss so much as looked at — and most of
  // them are read and answered without wanting anybody's draft. The button is in
  // the composer's own row, where the other writing aids are.
  const [draft, setDraft] = useState<{ busy: boolean; text?: string }>({ busy: false });
  const askDraft = () => {
    if (draft.busy) return;
    setDraft({ busy: true });
    void readApi(api.escalations[":id"].draft.$get({ param: { id: String(e.id) } }), AnswerDraftSchema).then((r) =>
      setDraft({ busy: false, text: r?.text?.trim() || "没能拟出来，这条得你自己写。" }),
    );
  };
  return (
    <>
      {/* Who is waiting, how long, and what it costs — in that order, because the
          cost is what decides which of two questions to open first. It read
          `qa · 阻塞 · 待你决策 · 等待 3h` inside the tab called 待你决策: the tab
          already said the third and 等待 is what a duration means.

          Collapsed, the question gets two lines rather than one truncated one. A
          question cut mid-clause cannot be triaged, which is the only thing a
          closed row is for. */}
      <AccordionTrigger className="block px-4 py-2.5 transition-colors hover:bg-accent-soft">
        <div className="flex flex-wrap items-baseline gap-x-2 font-mono text-[0.6875rem]">
          <span className="text-ink-2">{e.asker ?? "系统"}</span>
          <span className="text-ink-3">{waited(e.created_at)}</span>
          {e.severity === "blocker" && <span className="font-semibold text-bad">全组停着</span>}
        </div>
        {!open && <div className="mt-1 line-clamp-2 max-w-[72ch] text-[0.8125rem] text-ink-2">{nl(e.question)}</div>}
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
        <Asked body={e.question} />
        {draft.busy && <Typing label="AI 在替你想" />}
        {draft.text && (
          // On your side of the exchange, because that is what it is: a reply
          // nobody has sent. Dashed, so it cannot be mistaken for one that went.
          <div className="my-2 ml-auto max-w-[46rem] rounded-2xl rounded-tr-sm border border-dashed border-rule bg-paper px-3.5 py-2">
            <div className="flex items-baseline gap-2">
              <Tip label="按这一组的黑板现算的，还没发给任何人。填进输入框后你可以改">
                <Meta className="cursor-help">AI 替你拟的答复</Meta>
              </Tip>
              <span className="grow" />
              <Button size="sm" onClick={() => setSeed((p) => ({ n: p.n + 1, text: draft.text! }))}>
                填进输入框
              </Button>
            </div>
            <div className="mt-1 whitespace-pre-wrap break-words text-[0.8125rem] text-ink-2">
              <Clamp lines={3}>{nl(draft.text)}</Clamp>
            </div>
          </div>
        )}
        <div className="ml-auto mt-2 max-w-[46rem]">
          <Composer
            key={seed.n}
            initial={seed.text}
            rows={2}
            placeholder="答复。发出去直接解开被阻塞的 agent。⌘Enter 发送"
            submit="回答"
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
                <Tip label="用这一组的黑板现算一份草稿，不会发出去">
                  <Button size="sm" variant="quiet" disabled={draft.busy} onClick={askDraft}>
                    {draft.text ? "再拟一份" : "让 AI 拟一份"}
                  </Button>
                </Tip>
                <Tip label="技术选型和架构边界归 Architect 判断，它答不了会自己回来">
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
                    转 Architect
                  </Button>
                </Tip>
                {/* The commonest blocker here is one no answer resolves — a config file
                  is wrong, a shared fixture is broken. Answering it means typing the
                  fix into a chat box for an agent that is not allowed to apply it, so
                  these sat in 待办 until the boss did the work by hand.

                  Not `go`: two filled violet buttons side by side is two primaries,
                  and answering is the primary here. */}
                <Tip label="开成一条需求去做，这一组等它落地后自动继续">
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
                    开成需求
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
        <WithAttachments body={body} className={cn("text-[0.8125rem]", tone)} />
      </Clamp>
    </div>
  );
}

/**
 * Questions somebody else in the chain is still holding.
 *
 * Nothing here is the boss's move — the PM or the Architect will answer it, or
 * abstain and pass it up, at which point it moves to the list above. They sat in
 * that list at the same weight, with the same tint and the same answer box, and
 * the commonest one is an Architect quoting the shell command a clearance rule
 * blocked: a paragraph of `git ls-tree -r main --name-only | grep -i markdown`
 * the boss can do nothing with.
 *
 * One line each: who is holding it, how long, and the first line of what was
 * asked. Reference, not work.
 */
function Held({ rows }: { rows: Escalation[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-rule-soft">
      {rows.map((e) => (
        // Open, always. Folding is for a list you choose from, and there is
        // nothing to choose here — no button, no box, nothing the boss does. The
        // question and the fact that somebody is writing back are the whole
        // content, so they are on the screen.
        <div key={e.id} className="border-t border-rule-soft px-4 py-2.5 first:border-t-0">
          <div className="flex flex-wrap items-baseline gap-x-2 font-mono text-[0.6875rem] text-ink-3">
            <span className="text-ink-2">{e.asker ?? "系统"}</span>
            <span>{waited(e.created_at)}</span>
          </div>
          <Asked body={e.question} className="mt-1.5" tone="text-ink-2" />
          <Typing label={WHERE_ZH[e.chain_state] ?? e.chain_state} />
        </div>
      ))}
    </div>
  );
}
