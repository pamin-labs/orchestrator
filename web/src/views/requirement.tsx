import { ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { Button, LinkButton } from "../ui/button";
import { Menu, MenuItem } from "../ui/menu";
import { Tab, TabList, TabPanel, Tabs } from "../ui/tabs";
import { Clamp, H2, Meta, Textarea, Working, Pane } from "../ui/bits";
import { Badge } from "../ui/badge";
import { Card, CardBody, CardTitle } from "../ui/card";
import { Bar } from "../ui/table";
import { Tip } from "../ui/tooltip";
import { ask } from "../ui/confirm";
import { Composer, ComposerDialog } from "../ui/composer";
import { post, pull, type Escalation, type Group, type Slice, type State } from "../lib/api";
import { STOPS, WHERE_ZH, asksOf, gates, heldApproved, mineOf, prUrl, statusLabel } from "../lib/select";
import { cn, K, nl, waited } from "../lib/utils";
import { activityOf } from "../lib/activity";
import { WithAttachments } from "../ui/attachments";
import { useEffect, useState } from "react";
import { Accordion, AccordionBody, AccordionItem, AccordionTrigger } from "../ui/accordion";
import { EvidencePanel } from "./evidence";
import { Notes } from "./notes";

/** One requirement in full: slices, their tasks, who is on it, and what it asks. */
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
  st, g, refresh, open, tab, onTab,
}: {
  st: State; g: Group; refresh: () => void; open: boolean;
  /** From the hash: leaving the drill-in and coming back kept unmounting this. */
  tab?: string | null; onTab?: (t: string) => void;
}) {
  const slices = st.slices.filter((s) => s.grp_id === g.id);
  // The ones on the boss first: the rest are reference, and reading order should
  // not depend on which agent happened to ask first.
  const asks = asksOf(st, g.id).sort((a, b) => Number(b.chain_state === "boss") - Number(a.chain_state === "boss"));
  const mine = mineOf(asks);
  const broke = g.budget_tokens != null && g.spent_tokens >= g.budget_tokens;
  // `null` = untouched, open the first one waiting on the boss. Radix reports
  // `""` when the open one is shut, which is the state the default would
  // otherwise fall straight back to.
  const [openAsk, setOpenAsk] = useState<string | null>(null);

  // The LAST slice that has actually produced something — work moves down the
  // list, so the newest one carrying evidence is where it has got to. `running`
  // with no gate mark is a slice that has been handed out and written nothing:
  // opening that one puts an empty evidence panel in front of the boss while the
  // slice above it sits waiting to be accepted. Nothing worked on yet: everything
  // stays shut rather than defaulting to a slice with nothing under it.
  const worked = [...slices].reverse().find(
    (s) =>
      ["self_review", "gate", "qa", "awaiting_boss", "rejected"].includes(s.status) ||
      (s.status === "running" && Object.keys(gates(s)).length > 0),
  );
  // `null` = nobody has clicked, take the default. `"none"` = the boss shut the
  // default one; without a distinct value that click falls straight back to the
  // default and the row will not close.
  const [picked, setPicked] = useState<number | "none" | null>(null);
  const shown = picked === "none" ? undefined : slices.find((s) => s.id === picked) ?? worked;

  const draft = g.status === "DRAFT" || g.status === "PLANNING";
  const active = tab ?? (mine.length ? "ask" : "slice");
  /** Open questions somebody else in the chain is still holding. */
  const others = asks.filter((a) => !mine.includes(a));
  // The record is fetched by the panel that shows it, so the tab has to be told.
  const [notes, setNotes] = useState<number | null>(null);

  return (
    // Four things this page holds, and they were stacked in two columns down one
    // scroll: questions, slices, the record, the roster — plus a composer that
    // ended up below however many slices there were. Tabs put one at a time in
    // front of the boss, each scrolling inside itself, with the header and the
    // box you type into pinned. Long shell commands inside an escalation used to
    // push the whole page into a horizontal scroll; every column is min-w-0 and
    // the text breaks now.
    <section className="flex min-h-0 flex-1 flex-col">
      <Header st={st} g={g} refresh={refresh} slices={slices} />
      {broke && <BudgetWall g={g} refresh={refresh} />}

      {draft ? (
        <Pane className="mt-4">
          <Draft st={st} g={g} refresh={refresh} />
        </Pane>
      ) : (
        <Tabs
          value={active}
          onValueChange={onTab}
          className="mt-3 flex min-h-0 flex-1 flex-col"
        >
          <TabList>
            <Tab value="slice" count={slices.length}>切片</Tab>
            {/* Only the ones on the boss are 待你决策. The rest are open questions
                the chain is still holding, and counting them under that heading
                made the badge lie about how much of this was a decision. */}
            <Tab value="ask" count={asks.length} mine={mine.length > 0}>
              {mine.length ? "待你决策" : "问题"}
            </Tab>
            <Tab value="notes" count={notes ?? undefined}>记录</Tab>
          </TabList>

          <TabPanel value="slice" className="flex min-h-0 flex-1 flex-col">
            {slices.length ? (
              /* The evidence opens under the row it belongs to. It used to sit in
                 a second pane below the whole list, so the diff for S2 was drawn
                 under S3 and the row it answers was two rows away from the two
                 buttons that answer it. One accordion: rows and the one open body
                 in the same scroll, the evidence header pinned inside it so the
                 verdict buttons stay reachable while you read the diff.

                 The box hugs its rows and is capped at what is left of the screen
                 — not `flex-1`, which drew an 800px empty frame under three closed
                 rows. The scroll still lives here once the open slice outgrows
                 the pane. */
              <div className="min-h-0 max-h-full overflow-y-auto overflow-x-hidden rounded-lg border border-rule">
                <Accordion value={shown ? String(shown.id) : ""} onValueChange={(v) => setPicked(v ? Number(v) : "none")}>
                  {slices.map((s) => (
                    <AccordionItem key={s.id} value={String(s.id)}>
                      <SliceRow st={st} g={g} s={s} selected={s.id === shown?.id} />
                      <AccordionBody>
                        <SliceDetail st={st} g={g} s={s} refresh={refresh} />
                      </AccordionBody>
                    </AccordionItem>
                  ))}
                </Accordion>
              </div>
            ) : (
              <Pane>
                <Working>正在拆解</Working>
              </Pane>
            )}
          </TabPanel>

          {/* Two lists, not one. Everything used to sit in a single accordion at
              one weight: a question the boss has to answer, a question the
              Architect is still holding, and a stand-in's old answer, each with
              the same tint, the same type and the same click. The Architect's read
              like work — it is not, and its body is a shell command the boss can
              do nothing with.

              So: the decisions, in full, each with its answer box. Then what
              somebody else is holding, one line each, quiet. Then who answered for
              you, only if anyone has. */}
          {/* One scroll for the whole tab, not a capped box per section. The
              questions box owned the scroll, so a long question pushed the answer
              box it belongs to below the box's own bottom edge — the boss saw a
              question cut mid-sentence and no way to reply to it. */}
          <TabPanel value="ask" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overflow-x-hidden pb-2 pr-1">
            {mine.length > 0 && (
              <div className="shrink-0 overflow-hidden rounded-lg border border-accent">
                <Accordion value={openAsk ?? String(mine[0]!.id)} onValueChange={setOpenAsk}>
                  {mine.map((e) => (
                    <AccordionItem key={e.id} value={String(e.id)}>
                      <Ask e={e} refresh={refresh} open={String(e.id) === (openAsk ?? String(mine[0]!.id))} />
                    </AccordionItem>
                  ))}
                </Accordion>
              </div>
            )}

            {others.length > 0 && <Held rows={others} />}

            {!asks.length && (
              <div className="text-[0.8125rem] text-ink-3">没有开着的问题。这一组的人现在不等你。</div>
            )}

            {/* An answer a stand-in gave for the boss belongs with the questions,
                which is where someone goes looking for it. It used to sit in a
                roster tab: 这个组的人 listed role, activity, turns and tokens for
                every agent in the group — the 工位墙 in miniature, one column
                narrower, on a page about a requirement rather than about people.
                The tab is gone; this was the only part of it doing work. */}
            <Delegated rows={st.answered.filter((a) => a.grp_id === g.id)} refresh={refresh} />
          </TabPanel>

          <TabPanel value="notes" className="flex min-h-0 flex-1 flex-col">
            <Pane>
              <Notes grpId={g.id} compact onCount={setNotes} />
            </Pane>
          </TabPanel>
        </Tabs>
      )}

      {/* Pinned and one line tall until it is wanted. A composer that is always
          open costs four rows of the slice list to sit there empty, and this page
          is read far more often than it is typed into — but it has to stay
          reachable without scrolling, because it is how the boss answers what
          they just read. */}
      {/* A decision carries its own answer box, and that box is the one that
          unblocks the agent hanging on it. Two inputs on one screen asks the boss
          to work out which of them the words go to. */}
      {open && !draft && !(active === "ask" && mine.length > 0) && (
        <SayDock g={g} refresh={refresh} />
      )}
    </section>
  );
}

/** Identity and state on the left, the one useful control on the right, the rest in a menu. */
function Header({ st, g, refresh, slices }: { st: State; g: Group; refresh: () => void; slices: Slice[] }) {
  const inQueue = st.mergeQueue.some((m) => m.grpId === g.id);
  const url = prUrl(st, g);
  const broke = g.budget_tokens != null && g.spent_tokens >= g.budget_tokens;
  const act = async (a: string) => { await post(`/api/groups/${g.id}/${a}`); refresh(); };
  const running = ["RUNNING", "PAUSING"].includes(g.status);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-rule pb-3">
      <span className="font-display text-[1.25rem] font-semibold">{g.name}</span>
      <Badge
        tone={
          heldApproved(g) ? "muted" : g.status === "DRAFT" ? "mine" : g.status === "RUNNING" ? "live" : "muted"
        }
      >
        {statusLabel(g)}
      </Badge>
      <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {g.branch && <Meta>{g.branch}</Meta>}
        <Meta>{K(g.spent_tokens)} tokens</Meta>
        <Budget g={g} refresh={refresh} />
      </span>

      <span className="ml-auto flex flex-wrap items-center gap-1.5">
        {/* Merging is the one step that stays the boss's hand, on GitHub. Nothing
            here confirms it: `pollPrs` asks GitHub every tick and winds the group
            up by itself. */}
        {url && <LinkButton href={url}>{inQueue ? "去合并 PR ↗" : "打开 PR ↗"}</LinkButton>}
        {/* Closed PR: reopening it on GitHub is enough and the watchdog sees it,
            but a branch that was force-pushed or deleted cannot be reopened at
            all — so the way out has to exist here too. */}
        {g.status === "PAUSED" && g.pr_number != null && <NewPr grpId={g.id} refresh={refresh} />}
        {!inQueue && g.status === "PR_OPEN" && <Badge>排队中</Badge>}
        {g.status === "RUNNING" && <Button onClick={() => act("pause")}>暂停</Button>}
        {["PAUSED", "PAUSING"].includes(g.status) && !broke && <Button onClick={() => act("resume")}>继续</Button>}
        {g.status === "PARKED" && <Button variant="go" onClick={() => act("wake")}>唤醒</Button>}
        {/* Interrupt and park are rare and consequential. Sitting in the header at
            the same weight as 暂停 they read as ordinary, and one of them discards a
            turn's work. */}
        <Menu label="更多">
          {running && (
            <MenuItem
              hint="停止当前 turn，改动留着，下一个 turn 会被告知"
              onSelect={async () => { await post(`/api/groups/${g.id}/interrupt`, { mode: "keep" }); refresh(); }}
            >
              打断，保留改动
            </MenuItem>
          )}
          {running && (
            <MenuItem
              danger
              hint="回到这一轮开始前的 checkpoint，这个 turn 的改动全丢"
              onSelect={async () => {
                const go = await ask({
                  title: "打断并回滚", body: "丢弃当前 turn 的全部改动，退回到这一轮开始前。",
                  yes: "打断并回滚", danger: true,
                });
                if (!go) return;
                await post(`/api/groups/${g.id}/interrupt`, { mode: "rollback" });
                refresh();
              }}
            >
              打断并回滚
            </MenuItem>
          )}
          {["RUNNING", "PAUSING", "PAUSED"].includes(g.status) && (
            <MenuItem
              hint="释放并发槽，worktree 和 checkpoint 原地不动"
              onSelect={() => act("park")}
            >
              封存
            </MenuItem>
          )}
          {slices.length > 0 && (
            <MenuItem hint="打开这一组的 worktree 路径" onSelect={() => navigator.clipboard?.writeText(g.worktree ?? "")}>
              复制 worktree 路径
            </MenuItem>
          )}
          {/* 退回重拆 sends it back to the Dispatcher, which writes another card for
              work nobody wants. A requirement that turned out to be a duplicate, or
              that someone already fixed, needs to leave the board instead. */}
          <MenuItem
            danger
            hint="排队的 turn 全取消，占的路径交还给别的组。worktree、分支和记录都留着"
            onSelect={async () => {
              const go = await ask({
                title: "不做了",
                body: `${g.name} 会从看板上消失，排队的 turn 全部取消。worktree 和记录留着，组不会再被拉起。`,
                yes: "不做了",
                danger: true,
              });
              if (!go) return;
              await post(`/api/groups/${g.id}/drop`, {});
              refresh();
            }}
          >
            不做了
          </MenuItem>
        </Menu>
      </span>
    </div>
  );
}

/** One line per slice: order, title, gates, and who is on it. */
function SliceRow({ st, g, s, selected }: { st: State; g: Group; s: Slice; selected: boolean }) {
  const gs = gates(s);
  const waiting = s.status === "awaiting_boss";
  const on = st.agents.filter((a) => a.grp_id === g.id && a.state === "running");
  return (
    <AccordionTrigger
      className={cn(
        "grid grid-cols-[2rem_minmax(0,1fr)_auto_auto] items-center gap-x-3",
        "px-4 py-2 transition-colors",
        "max-[52rem]:grid-cols-[2rem_minmax(0,1fr)_auto]",
        waiting ? "bg-accent-soft/60 hover:bg-accent-soft" : selected ? "bg-rail" : "hover:bg-rail/60",
      )}
    >
      <span className="font-mono text-[0.75rem] text-ink-3">S{s.seq}</span>
      <span className="min-w-0">
        <span className="block truncate text-[0.8125rem]">
          {s.title} <span className="font-mono text-[0.625rem] text-ink-3">{s.difficulty}</span>
        </span>
        <span className="block truncate font-mono text-[0.6875rem] text-ink-3">
          {s.status === "pending"
            ? "等前序切片"
            : s.status === "rejected"
              ? "已退回，等它修"
              : waiting
                ? s.awaiting_at
                  ? `待你查收 · ${waited(s.awaiting_at)}`
                  : "待你查收"
                : on.length
                  ? on.map((a) => { const [verb, detail] = activityOf(a); return `${a.role} ▸ ${verb ? `${verb} ` : ""}${detail}`; }).join(" · ")
                  : s.accept_spec}
        </span>
      </span>
      <Ticks s={s} gs={gs} />
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
  const waiting = s.status === "awaiting_boss";
  return (
    <span className="flex items-center gap-1.5">
      {[...STOPS, ["boss", waiting ? "待查收" : "查收"] as [string, string]].map(([k, zh]) => {
        const v = k === "boss" ? (waiting ? "wait" : s.status === "accepted" ? "pass" : "") : gs[k];
        return (
          <span
            key={k}
            className={cn(
              "flex items-center gap-1 text-[0.6875rem]",
              v === "pass" && "text-ok",
              v === "fail" && "text-bad",
              v === "wait" && "font-semibold text-accent",
              !v && "text-ink-3",
            )}
          >
            <span
              className={cn(
                "size-2 rounded-full border",
                v === "pass" && "border-ok bg-ok",
                v === "fail" && "border-bad bg-bad",
                v === "wait" && "border-accent bg-accent",
                !v && s.status === k && "breathe border-ink",
                !v && s.status !== k && "border-ink-3",
              )}
            />
            <b className="whitespace-nowrap font-medium max-[64rem]:hidden">{zh}</b>
          </span>
        );
      })}
    </span>
  );
}

/** The selected slice, in full: what it promised, what it did, and the two buttons. */
function SliceDetail({ st, g, s, refresh }: { st: State; g: Group; s: Slice; refresh: () => void }) {
  const tasks = st.tasks.filter((t) => t.slice_id === s.id);
  const waiting = s.status === "awaiting_boss";
  // A header saying `S2 <title> 验收：<spec>` sat here, directly under the lane row
  // that says S2 and the title, directly above the evidence panel that leads with
  // the acceptance line. Three copies of two facts, stacked. The buttons were the
  // only thing here that was not a repeat, so they moved next to the evidence they
  // are a verdict on.
  const act = waiting ? (
    <span className="flex shrink-0 gap-1.5">
      <Button variant="go" onClick={async () => { await post(`/api/slices/${s.id}/accept`); refresh(); }}>
        查收
      </Button>
      <RejectSlice sliceId={s.id} refresh={refresh} />
    </span>
  ) : null;

  if (s.status === "pending") {
    return <div className="border-t border-rule-soft py-2 pl-14 pr-3 text-[0.75rem] text-ink-3">还没开工，等前面的切片查收。</div>;
  }
  return (
    <div className="border-t border-rule-soft">
      {/* Only when it says something the slice title does not: one task whose title
          is the slice's own is the same line twice with a tick in front. */}
      {(tasks.length > 1 || (tasks[0] && tasks[0].title !== s.title)) && (
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
    <Button variant="go" onClick={async () => {
      const go = await ask({
        title: "开一个新 PR",
        body: "能在 GitHub 上重开旧 PR 就不用这个。分支被强推或删过才用：会用当前分支重提一个，回到合入队列。",
        yes: "开新 PR",
      });
      if (!go) return;
      const r = await post(`/api/groups/${grpId}/newpr`);
      if (!r.ok) await ask({ title: "开不出来", body: r.text, yes: "知道了" });
      refresh();
    }}>开新 PR</Button>
  );
}

/**
 * Sending a slice back.
 *
 * The words are the whole payload: they become a blackboard fact and the PM plans
 * the correction from them, so this is the same composer as everywhere else and
 * takes a screenshot of what is wrong.
 */
export function RejectSlice({
  sliceId, refresh, children,
}: {
  sliceId: number; refresh: () => void; children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>{children ?? "不满意"}</Button>
      <ComposerDialog
        open={open}
        onOpenChange={setOpen}
        title="退回这一片"
        hint="原话记进黑板，PM 据此安排修正。截图直接粘。"
        placeholder="哪里不满意。⌘Enter 退回"
        submit="退回"
        rows={4}
        onSubmit={async ({ text, attachments }) => {
          const r = await post(`/api/slices/${sliceId}/reject`, { feedback: text, attachments });
          refresh();
          return r.ok;
        }}
      />
    </>
  );
}

/** Spend against its cap, and the cap itself, editable. Nothing sets one otherwise. */
function Budget({ g, refresh }: { g: Group; refresh: () => void }) {
  const set = async (tokens: number | null) => {
    await post(`/api/groups/${g.id}/budget`, { tokens });
    refresh();
  };
  if (g.budget_tokens == null) {
    return (
      <button
        className="cursor-pointer font-mono text-[0.6875rem] text-ink-3 underline decoration-dotted hover:text-ink"
        onClick={async () => {
          const v = await ask({ title: "给这个需求设 token 上限", body: "用满就挂起，等你决定加不加。", yes: "设定", field: "例如 2000000" });
          const n = Number(String(v ?? "").replace(/[^\d]/g, ""));
          if (n > 0) await set(n);
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
        <Meta>{K(g.spent_tokens)}/{K(g.budget_tokens)}</Meta>
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
  const set = async (tokens: number | null) => {
    await post(`/api/groups/${g.id}/budget`, { tokens });
    refresh();
  };
  const doubled = Math.max(g.budget_tokens * 2, g.spent_tokens + 100_000);
  return (
    <Card tone="mine" className="mt-2.5">
      <CardBody>
        <CardTitle className="text-[0.9375rem] text-accent">预算用尽，全组挂起</CardTitle>
        <div className="mt-0.5 text-[0.75rem] text-ink-2">
          已花 {K(g.spent_tokens)} tokens，上限 {K(g.budget_tokens)}。
          加上限才动得了，「继续」不生效。
        </div>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <Button variant="go" onClick={() => set(doubled)}>翻倍到 {K(doubled)}</Button>
          <Button onClick={() => set(null)}>取消上限</Button>
          <Button variant="quiet" onClick={async () => { await post(`/api/groups/${g.id}/park`); refresh(); }}>
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
function Delegated({
  rows, refresh,
}: {
  rows: State["answered"]; refresh: () => void;
}) {
  // Nothing at all when nobody has answered for you. A sentence explaining what
  // an empty block would have contained is the page reporting an absence, which
  // is what PRODUCT.md says an empty state must not do — and this one sat under
  // the question the boss was there to answer.
  if (!rows.length) return null;
  return (
    <div className="shrink-0">
      <Meta className="block px-1 pb-1">替你答过 {rows.length} 条</Meta>
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
              <Button variant="quiet" size="sm" onClick={async () => {
                const go = await ask({
                  title: "撤销并接管",
                  body: "回滚到提问时的 checkpoint，之后的改动作废，由你重新回答。",
                  yes: "撤销并接管", danger: true,
                });
                if (!go) return;
                await post(`/api/escalations/${a.id}/revoke`);
                refresh();
              }}>撤销并接管</Button>
            </div>
            <div className="mt-1 max-w-[72ch] text-[0.75rem] text-ink-3">
              <Clamp lines={2}>{nl(a.question)}</Clamp>
            </div>
            {/* The answer is the half worth reading, so it is the darker of the
                two, on the surface everything not written by the boss sits on. */}
            <div className="mt-1 max-w-[72ch] rounded-md bg-sunk px-2.5 py-1.5 text-[0.8125rem] text-ink-2">
              <Clamp lines={3}>{nl(a.answer)}</Clamp>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** One line at rest, the full composer once clicked. */
function SayDock({ g, refresh }: { g: Group; refresh: () => void }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
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
 * The boss's own voice, and what it counts as.
 *
 * PLAN.md §7 puts three readings on the same words: patch keeps going, respec
 * throws the decomposition out, reject drops the whole thing. Without respec here
 * every complaint is heard as "change one line", which is exactly how a wrong
 * decomposition survives to the end.
 */
function Say({ g, refresh, projectId }: { g: Group; refresh: () => void; projectId?: number }) {
  const draft = g.status === "DRAFT" || g.status === "PLANNING";
  const send = async (d: { text: string; attachments: unknown[] }, as?: "patch" | "respec" | "reject") => {
    const r = await post("/api/say", { group_id: g.id, body: d.text, attachments: d.attachments, as });
    refresh();
    return r.ok;
  };

  // Before approval the exits live next to the approve button, where the decision
  // is. A second composer down here asked the boss to type into whichever one they
  // found first, and neither said where the words would go.
  if (draft) return null;

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
              <Button size="sm" disabled={busy || !text}
                      onClick={async () => (await send({ text, attachments }, "patch")) && clear()}>
                要改一处
              </Button>
            </Tip>
            <Tip label="整个需求退回 Dispatcher 重新深挖，已写的代码留在分支上">
              <Button size="sm" disabled={busy || !text} onClick={async () => {
                const go = await ask({
                  title: "退回重新拆解",
                  body: "这句话作为最高优先级 fact，整个需求退回 Dispatcher 重新深挖。已写的代码留在分支上。",
                  yes: "退回重拆",
                });
                if (go && (await send({ text, attachments }, "respec"))) clear();
              }}>方向错了</Button>
            </Tip>
            <Tip label="停止派发，分支保留不合入，仍然要写 retro">
              <Button size="sm" disabled={busy || !text} onClick={async () => {
                const go = await ask({
                  title: "作废这个需求",
                  body: "停止派发，分支保留不合入。仍然要求写 retro。",
                  yes: "作废", danger: true,
                });
                if (go && (await send({ text, attachments }, "reject"))) clear();
              }}>不做了</Button>
            </Tip>
          </>
        )}
      />
    </>
  );
}

function Draft({ st, g, refresh }: { st: State; g: Group; refresh: () => void }) {
  const filed = st.draftCards.find((c) => c.grpId === g.id)?.body ?? "";
  const idea = st.ideas.find((i) => i.grpId === g.id)?.body ?? "";
  const late = st.lateObjections.filter((o) => o.grpId === g.id);
  const proposal = st.dropProposals.find((p) => p.grpId === g.id);
  const card0 = st.draftCards.find((c) => c.grpId === g.id);
  const unknown: string[] = (() => {
    try {
      const v = JSON.parse(card0?.unknownPaths ?? "null");
      return Array.isArray(v) ? (v as string[]) : [];
    } catch {
      return [];
    }
  })();
  const [card, setCard] = useState(filed);

  return (
    <>
      {idea && <div className="my-2 border-l border-rule pl-2.5 text-[0.8125rem] text-ink-2">{idea}</div>}
      {/* An objection that arrived after the card was filed. Without this the card
          reads 反对 : 无 and the boss approves a plan somebody already argued with. */}
      {late.map((o, i) => (
        <div key={i} className="my-2 break-words whitespace-pre-wrap rounded-md bg-sunk px-2.5 py-2 text-[0.75rem]">
          <b className="font-semibold text-warn">{o.author} 后补反对</b> {o.body}
        </div>
      ))}
      {/* Paths the card names that are not in the repo. A plan that creates a file
          names it, so this is not an error — but a plan written from memory of the
          codebase instead of from reading it also names files that were never
          there, and that is the cheapest visible symptom of a decomposition
          pointed the wrong way. The 20 seconds is where that gets caught. */}
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
      {proposal && (
        <div className="my-3 rounded-md border border-warn/40 bg-sunk px-3 py-2.5">
          <div className="text-[0.8125rem] font-semibold text-warn">规划岗建议作废</div>
          <div className="my-1 break-words whitespace-pre-wrap text-[0.8125rem]">{proposal.body}</div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button variant="go" size="sm" onClick={async () => {
              const go = await ask({
                title: "作废这条需求",
                body: `${g.name} 会从看板上消失，排队的 turn 全部取消。worktree 和记录都留着。`,
                yes: "作废", danger: true,
              });
              if (!go) return;
              await post(`/api/groups/${g.id}/drop`, { why: proposal.body.split("\n")[0] });
              refresh();
            }}>确认作废</Button>
            <Button size="sm" onClick={async () => {
              await post("/api/say", {
                group_id: g.id,
                body: "不是重复，也不算已经做完了 —— 接着拆。",
                as: "respec",
              });
              refresh();
            }}>不，接着做</Button>
          </div>
        </div>
      )}
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
            <b className="font-semibold text-warn">已批准，边界挡着</b>{" "}
            {st.approvedBlocked.find((b) => b.grpId === g.id)?.reason ?? "等 Architect 切边界"}
          </div>
          <Working>让开之后自动开工，不用再点一次</Working>
        </>
      ) : (
        <>
          <Textarea
            rows={Math.max(7, filed.split("\n").length + 1)}
            value={card}
            onChange={(e) => setCard(e.target.value)}
            aria-label="计划卡"
          />
          <div className="mt-3 flex items-baseline gap-3">
            <Button variant="go" onClick={async () => {
              // Send the text only when edited: an untouched card is approved as
              // filed, so "approve" and "edit then approve" stay distinct requests.
              const edited = card.trim() && card.trim() !== filed.trim();
              await post(`/api/draft/${g.id}/approve`, edited ? { card: card.trim() } : {});
              refresh();
            }}>批准开工</Button>
            <span className="text-[0.75rem] text-ink-3">卡可以直接改再批</span>
          </div>
        </>
      )}
      <Exits g={g} refresh={refresh} projectId={g.project_id} />
    </>
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
  const send = async (d: { text: string; attachments: unknown[] }, as: "patch" | "respec") => {
    const r = await post("/api/say", { group_id: g.id, body: d.text, attachments: d.attachments, as });
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
            <Tip label="整条需求退回 Dispatcher 重新深挖，这句话作为最高优先级 fact">
              <Button size="sm" disabled={busy || !text} onClick={async () => {
                const go = await ask({
                  title: "退回重新拆解",
                  body: "整个需求退回 Dispatcher 重新深挖，这句话作为最高优先级 fact。",
                  yes: "退回重拆",
                });
                if (go && (await send({ text, attachments }, "respec"))) clear();
              }}>退回重拆</Button>
            </Tip>
            <Tip label="排队的 turn 全取消，占的路径交还给别的组">
              {/* Not a red button. Two filled buttons on one row and the destructive
                  one outweighs 批准开工, which is the answer this screen usually wants.
                  The confirm carries the weight instead. */}
              <Button size="sm" disabled={busy} onClick={async () => {
                const go = await ask({
                  title: "不做了",
                  body: `${g.name} 会从看板上消失，排队的 turn 全部取消。worktree 和记录都留着。`,
                  yes: "不做了", danger: true,
                });
                if (!go) return;
                await post(`/api/groups/${g.id}/drop`, { why: text });
                refresh();
              }}>不做了</Button>
            </Tip>
          </>
        )}
      />
      <div className="mt-1.5 text-[0.75rem] text-ink-3">
        两个都发给 Dispatcher，它改完卡再回来给你批。
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
  // Seeding by remount: the composer owns its text once the boss starts typing,
  // and a controlled value here would fight them for it. Nothing is sent by the
  // draft — its button fills the box and the boss sends it.
  const [seed, setSeed] = useState("");
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

      <AccordionBody className="px-4 pb-3">
        {/* Six lines, then a click. A watchdog escalation quotes three QA verdicts
            verbatim and runs to fifteen — the decision is usually made by line
            three, with the rest there to check the reasoning against. */}
        <div className="max-w-[72ch]">
          <Clamp lines={6}>
            <WithAttachments body={e.question} className="text-[0.8125rem]" />
          </Clamp>
        </div>
        <Suggested escId={e.id} onUse={setSeed} />
        <Composer
          key={seed}
          initial={seed}
          rows={2}
          placeholder="答复。发出去直接解开被阻塞的 agent。⌘Enter 发送"
          submit="回答"
          onSubmit={async ({ text, attachments }) => {
            const r = await post(`/api/escalations/${e.id}/answer`, { answer: text, attachments });
            refresh();
            return r.ok;
          }}
          actions={({ text, busy }) => (
            <>
              <Tip label="技术选型和架构边界归 Architect 判断，它答不了会自己回来">
                <Button size="sm"
                  onClick={async () => { await post(`/api/escalations/${e.id}/delegate`, { to: "architect" }); refresh(); }}>
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
                <Button size="sm" disabled={busy} onClick={async () => {
                  const r = await post(`/api/escalations/${e.id}/requirement`, { text });
                  refresh();
                  if (r.ok) toast.success(r.text);
                }}>
                  开成需求
                </Button>
              </Tip>
            </>
          )}
        />
      </AccordionBody>
    </>
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
  const [open, setOpen] = useState("");
  return (
    <div className="shrink-0">
      <Meta className="block px-1 pb-1">别人还在处理 {rows.length} 条</Meta>
      {/* Quiet, but it opens. Reading the question is not the same as answering
          it — the boss opens one of these to decide whether to take it over, and
          a row that ends in `…` with no way to see the rest cannot answer that. */}
      <div className="overflow-hidden rounded-lg border border-rule-soft">
        <Accordion value={open} onValueChange={setOpen}>
          {rows.map((e) => (
            <AccordionItem key={e.id} value={String(e.id)}>
              <AccordionTrigger className="flex flex-wrap items-baseline gap-x-2 px-4 py-1.5 transition-colors hover:bg-rail/60">
                <span className="shrink-0 font-mono text-[0.6875rem] text-ink-3">
                  {e.asker ?? "系统"} · {waited(e.created_at)} · {WHERE_ZH[e.chain_state] ?? e.chain_state}
                </span>
                {String(e.id) !== open && (
                  <span className="min-w-0 flex-1 truncate text-[0.75rem] text-ink-3">{nl(e.question)}</span>
                )}
              </AccordionTrigger>
              <AccordionBody className="px-4 pb-2">
                <div className="max-w-[72ch]">
                  <Clamp lines={8}>
                    <WithAttachments body={e.question} className="text-[0.8125rem] text-ink-2" />
                  </Clamp>
                </div>
              </AccordionBody>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </div>
  );
}

/**
 * What the answer probably is, worked out for you before you got here.
 *
 * Most of what reaches this box is not a judgement call — it is a question whose
 * answer is already on the blackboard, asked by an agent that could not find it.
 * Writing that out by hand is the boss doing retrieval, which is the one job the
 * system exists to do for them.
 *
 * Fetched on open, every open, never stored: the blackboard moves while a
 * question waits, and a draft written an hour ago can be arguing from facts that
 * have since been overturned. Nothing is sent from here — the button fills the
 * composer, where it is edited and sent by hand like any other answer. A draft
 * that does not arrive leaves no trace.
 *
 * It was labelled 参考答复 · 便宜模型现算，没发出去: three facts, two of them about
 * the implementation. What the boss needs to know is who wrote it and that it has
 * not gone anywhere, and the rest belongs on hover.
 */
function Suggested({ escId, onUse }: { escId: number; onUse: (t: string) => void }) {
  const [text, setText] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setText(null);
    void pull<{ text: string }>(`/api/escalations/${escId}/draft`).then((r) => setText(r?.text?.trim() || ""));
  }, [escId]);

  if (text === null) return <Meta className="my-2 block">AI 在替你想一个答复…</Meta>;
  if (!text) return null;
  return (
    // A recessed well: this is the one block here nobody wrote, machine text
    // between the agent's question and the boss's answer, and it has to be told
    // apart from both at a glance.
    <div className="my-2 max-w-[72ch] rounded-md bg-sunk px-3 py-2">
      <div className="flex items-baseline gap-2">
        <Tip label="按这一组的黑板现算的，还没发给任何人。填进输入框后你可以改">
          <Meta className="cursor-help">AI 替你拟的答复</Meta>
        </Tip>
        <span className="grow" />
        <Button size="sm" onClick={() => onUse(text)}>填进输入框</Button>
      </div>
      <div
        onClick={() => setOpen(!open)}
        className={cn(
          "mt-1 cursor-pointer whitespace-pre-wrap break-words text-[0.8125rem] text-ink-2",
          !open && "line-clamp-3",
        )}
      >
        {nl(text)}
      </div>
    </div>
  );
}
