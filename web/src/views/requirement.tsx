import { ChevronRight } from "lucide-react";
import { Button, LinkButton } from "../ui/button";
import { Menu, MenuItem } from "../ui/menu";
import { Tab, TabList, TabPanel, Tabs } from "../ui/tabs";
import { H2, Meta, Textarea, Working } from "../ui/bits";
import { Badge } from "../ui/badge";
import { Card, CardBody, CardTitle } from "../ui/card";
import { Bar } from "../ui/table";
import { Tip } from "../ui/tooltip";
import { ask } from "../ui/confirm";
import { Composer, ComposerDialog } from "../ui/composer";
import { post, type Escalation, type Group, type Slice, type State } from "../lib/api";
import { STOPS, WHERE_ZH, asksOf, gates, heldApproved, prUrl, statusLabel } from "../lib/select";
import { cn, K, money, waited } from "../lib/utils";
import { useState } from "react";
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
  st, g, refresh, open,
}: {
  st: State; g: Group; refresh: () => void; open: boolean;
}) {
  const slices = st.slices.filter((s) => s.grp_id === g.id);
  const asks = asksOf(st, g.id);
  const broke = g.budget_tokens != null && g.spent_tokens >= g.budget_tokens;

  // Select what needs the boss; failing that, what is moving; failing that, the first.
  const wants = slices.find((s) => s.status === "awaiting_boss");
  const moving = slices.find((s) => !["accepted", "pending"].includes(s.status));
  const [picked, setPicked] = useState<number | null>(null);
  const shown = slices.find((s) => s.id === picked) ?? wants ?? moving ?? slices[0];

  return (
    <section>
      <Header st={st} g={g} refresh={refresh} slices={slices} />
      {broke && <BudgetWall g={g} refresh={refresh} />}

      {/* Questions come before the work: an unanswered blocker means the group is
          stopped, so nothing below it can move anyway. */}
      {asks.length > 0 && (
        <div className="mt-4">
          <H2>待你决策 <span className="font-normal text-ink-3">{asks.length}</span></H2>
          {asks.map((e) => <Ask key={e.id} e={e} refresh={refresh} />)}
        </div>
      )}

      {g.status === "DRAFT" || g.status === "PLANNING" ? (
        <div className="mt-4">
          <Draft st={st} g={g} refresh={refresh} />
        </div>
      ) : slices.length ? (
        <div className="mt-4">
          <H2>交付切片 <span className="font-normal text-ink-3">{slices.filter((s) => s.status === "accepted").length}/{slices.length} 已查收</span></H2>
          <div className="overflow-hidden rounded-lg border border-rule">
            {slices.map((s) => (
              <SliceRow
                key={s.id}
                st={st}
                g={g}
                s={s}
                selected={s.id === shown?.id}
                onPick={() => setPicked(s.id === shown?.id ? null : s.id)}
              />
            ))}
          </div>
          {shown && <SliceDetail key={shown.id} st={st} g={g} s={shown} refresh={refresh} />}
        </div>
      ) : (
        <Working>正在拆解</Working>
      )}

      {open && (
        <>
          <Aside st={st} g={g} refresh={refresh} />
          <Say g={g} refresh={refresh} projectId={g.project_id} />
        </>
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
        <Meta>{money(g.spent_usd)}</Meta>
        <Budget g={g} refresh={refresh} />
      </span>

      <span className="ml-auto flex flex-wrap items-center gap-1.5">
        {url && <LinkButton href={url}>打开 PR ↗</LinkButton>}
        {inQueue && <Landed grpId={g.id} refresh={refresh} />}
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
              hint="停止当前 turn，未完成的改动留着，下一个 turn 会被告知"
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
              hint="写交接 journal、退休 session、释放并发槽。worktree 和 checkpoint 原地不动"
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
            hint="整条需求下线：排队的 turn 全取消，占的路径立刻交还给别的组。worktree、分支和记录都留着"
            onSelect={async () => {
              const go = await ask({
                title: "不做了",
                body: `${g.name} 会从看板上消失，排队的 turn 全部取消。worktree 和记录都留着，但组不会再被拉起。`,
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
function SliceRow({
  st, g, s, selected, onPick,
}: {
  st: State; g: Group; s: Slice; selected: boolean; onPick: () => void;
}) {
  const gs = gates(s);
  const waiting = s.status === "awaiting_boss";
  const on = st.agents.filter((a) => a.grp_id === g.id && a.state === "running");
  return (
    <button
      onClick={onPick}
      className={cn(
        "grid w-full cursor-pointer grid-cols-[2rem_minmax(0,1fr)_auto_auto] items-center gap-x-3",
        "border-t border-rule-soft px-3 py-2 text-left transition-colors first:border-t-0",
        "max-[52rem]:grid-cols-[2rem_minmax(0,1fr)_auto]",
        selected ? "bg-sunk" : "hover:bg-sunk/60",
        waiting && "bg-accent-soft/60 hover:bg-accent-soft",
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
                  ? on.map((a) => `${a.role} ▸ ${a.activity ?? a.state}`).join(" · ")
                  : s.accept_spec}
        </span>
      </span>
      <Ticks s={s} gs={gs} />
      <ChevronRight
        size={13}
        strokeWidth={2}
        className={cn("shrink-0 text-ink-3 transition-transform max-[52rem]:hidden", selected && "rotate-90")}
      />
    </button>
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
  return (
    <div className="mt-3 rounded-lg border border-rule">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rule px-3.5 py-2">
        <b className="text-[0.875rem] font-semibold">S{s.seq} {s.title}</b>
        <Meta>验收：{s.accept_spec}</Meta>
        <span className="grow" />
        {waiting && (
          <span className="flex gap-1.5">
            <Button variant="go" onClick={async () => { await post(`/api/slices/${s.id}/accept`); refresh(); }}>
              查收
            </Button>
            <RejectSlice sliceId={s.id} refresh={refresh} />
          </span>
        )}
      </div>
      {tasks.length > 0 && (
        <ul className="list-none border-b border-rule-soft px-3.5 py-2">
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
      {s.status === "pending" ? (
        <div className="px-3.5 py-3 text-[0.75rem] text-ink-3">还没开工，等前面的切片查收。</div>
      ) : (
        <div className="p-3">
          <EvidencePanel sliceId={s.id} />
        </div>
      )}
    </div>
  );
}

/** Records, stand-in answers, roster: real but not what the page is for. */
function Aside({ st, g, refresh }: { st: State; g: Group; refresh: () => void }) {
  const answered = st.answered.filter((a) => a.grp_id === g.id);
  const roster = st.agents.filter((a) => a.grp_id === g.id);
  return (
    <div className="mt-8">
      <Tabs defaultValue="notes">
        <TabList>
          <Tab value="notes">记录</Tab>
          <Tab value="answered" count={answered.length}>别人替你答的</Tab>
          <Tab value="roster" count={roster.length}>这个组的人</Tab>
        </TabList>
        <TabPanel value="notes">
          {/* The journal is ≤6 lines by force, so this is the cheapest honest account
              of the work that exists. */}
          <Notes grpId={g.id} compact />
        </TabPanel>
        <TabPanel value="answered">
          <Delegated rows={answered} refresh={refresh} />
        </TabPanel>
        <TabPanel value="roster">
          <Roster rows={roster} />
        </TabPanel>
      </Tabs>
    </div>
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
        hint="原话记进黑板，PM 据此安排修正。截图可以直接粘。"
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
          已花 {K(g.spent_tokens)} tokens（{money(g.spent_usd)}），上限 {K(g.budget_tokens)}。
          加上限才动得了；「继续」在这个状态下不生效。
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
 * Confirming a merge dissolves the group, so the server checks GitHub first and
 * refuses on anything but MERGED. The force path exists for a repo merged by hand
 * or a machine without `gh` — and says so, rather than pretending it verified.
 */
export function Landed({ grpId, refresh }: { grpId: number; refresh: () => void }) {
  return (
    <Button variant="go" onClick={async () => {
      const go = await ask({
        title: "确认已合入 main",
        body: "先向 GitHub 核对 PR 状态。确认后本组归档，队列里下一个放行，其余需求会被要求 rebase。",
        yes: "核对并收尾",
      });
      if (!go) return;
      const r = await post(`/api/groups/${grpId}/landed`);
      if (!r.ok) {
        const force = await ask({
          title: "GitHub 说它还没合",
          body: `${r.text}\n\n如果你是在别处手动合的，可以强制收尾 —— 但这一步不可撤销。`,
          yes: "我确定，强制收尾", danger: true,
        });
        if (force) await post(`/api/groups/${grpId}/landed`, { force: true });
      }
      refresh();
    }}>确认已合入</Button>
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
  if (!rows.length) {
    return (
      <div className="text-[0.8125rem] text-ink-3">
        没有代答。PM → Architect → CoS 任一级答了会出现在这里，每条都能撤销并接管。
      </div>
    );
  }
  return (
    <>
      {rows.map((a) => (
        <div key={a.id} className="border-t border-rule-soft py-2 first:border-t-0">
          <div className="flex items-baseline gap-2">
            <Meta>{a.answered_by}</Meta>
            <span className="min-w-0 grow text-[0.8125rem]">{a.question}</span>
            <Button variant="quiet" onClick={async () => {
              const go = await ask({
                title: "撤销并接管",
                body: "回滚到提这个问题时的 checkpoint，之后的改动作废，由你重新回答再往下跑。",
                yes: "撤销并接管", danger: true,
              });
              if (!go) return;
              await post(`/api/escalations/${a.id}/revoke`);
              refresh();
            }}>撤销并接管</Button>
          </div>
          <div className="mt-px border-l border-rule pl-2.5 text-[0.75rem] text-ink-2">{a.answer}</div>
        </div>
      ))}
    </>
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

  // Before approval there is no PM and no work to patch: the only two things worth
  // saying are "also do this" and "start over".
  if (draft) {
    return (
      <>
        <H2 className="mt-6">要说点什么</H2>
        <Composer
          rows={2}
          projectId={projectId}
          placeholder="补充要求，或者写退回理由。截图、设计稿直接粘，/ 插技能路径。⌘Enter 补充给 Dispatcher"
          submit="补充要求"
          onSubmit={(d) => send(d, "patch")}
          actions={({ text, attachments, busy, clear }) => (
            <Tip label="这句话作为最高优先级 fact，整个需求退回 Dispatcher 重新深挖">
              <Button size="sm" disabled={busy || !text} onClick={async () => {
                const r = await post(`/api/draft/${g.id}/reject`, { reason: text, attachments });
                refresh();
                if (r.ok) clear();
              }}>退回重拆</Button>
            </Tip>
          )}
        />
      </>
    );
  }

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
            <Tip label="局部改：原话记进黑板，PM 安排一条修正 task，组继续跑">
              <Button size="sm" disabled={busy || !text}
                      onClick={async () => (await send({ text, attachments }, "patch")) && clear()}>
                要改一处
              </Button>
            </Tip>
            <Tip label="方向错了：整个需求退回 Dispatcher 重新深挖，代码留在分支上待判断能否复用">
              <Button size="sm" disabled={busy || !text} onClick={async () => {
                const go = await ask({
                  title: "退回重新拆解",
                  body: "这句话作为最高优先级 fact，整个需求退回 Dispatcher 重新深挖。已写的代码留在分支上。",
                  yes: "退回重拆",
                });
                if (go && (await send({ text, attachments }, "respec"))) clear();
              }}>方向错了</Button>
            </Tip>
            <Tip label="作废：停止派发，分支保留不合入，但仍然要写 retro">
              <Button size="sm" disabled={busy || !text} onClick={async () => {
                const go = await ask({
                  title: "作废这个需求",
                  body: "停止派发，分支保留不合入。仍然要求写 retro —— 白干的那次教训最值钱。",
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
  const [card, setCard] = useState(filed);

  return (
    <>
      {idea && <div className="my-2 border-l border-rule pl-2.5 text-[0.8125rem] text-ink-2">{idea}</div>}
      {/* An objection that arrived after the card was filed. Without this the card
          reads 反对 : 无 and the boss approves a plan somebody already argued with. */}
      {late.map((o, i) => (
        <div key={i} className="my-2 whitespace-pre-wrap rounded-md bg-sunk px-2.5 py-2 text-[0.75rem]">
          <b className="font-semibold text-warn">{o.author} 后补反对</b> {o.body}
        </div>
      ))}
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
            <span className="text-[0.75rem] text-ink-3">
              卡可以直接改再批。要退回重拆就在下面写理由。
            </span>
          </div>
        </>
      )}
    </>
  );
}

function Ask({ e, refresh }: { e: Escalation; refresh: () => void }) {
  const mine = e.chain_state === "boss";
  return (
    <div className="border-t border-rule-soft py-2.5 first:border-t-0">
      <div className={cn("font-mono text-[0.6875rem]", e.severity === "blocker" ? "text-bad" : "text-ink-3")}>
        {e.asker ?? "?"} · {e.severity === "blocker" ? "阻塞" : "非阻塞"} ·{" "}
        {WHERE_ZH[e.chain_state] ?? e.chain_state} · {waited(e.created_at)}
      </div>
      <div className="my-1 text-[0.8125rem]">{e.question}</div>
      {mine && (
        <Composer
          rows={2}
          placeholder="答复。这条会直接解开被阻塞的那个 agent。⌘Enter 发送"
          submit="回答"
          onSubmit={async ({ text, attachments }) => {
            const r = await post(`/api/escalations/${e.id}/answer`, { answer: text, attachments });
            refresh();
            return r.ok;
          }}
          actions={() => (
            <Tip label="技术选型和架构边界是 Architect 的判断，不是你的。转过去，它答不了会自己回来。">
              <Button size="sm"
                onClick={async () => { await post(`/api/escalations/${e.id}/delegate`, { to: "architect" }); refresh(); }}>
                转 Architect
              </Button>
            </Tip>
          )}
        />
      )}
    </div>
  );
}

function Roster({ rows }: { rows: State["agents"] }) {
  if (!rows.length) {
    return <div className="text-[0.8125rem] text-ink-3">还没雇人。批准计划卡之后 PM / Engineer / QA 会被雇进这一组。</div>;
  }
  return (
    <>
      <div className="grid gap-1">
        {rows.map((a) => (
          <div key={a.id} className="grid grid-cols-[5rem_minmax(0,1fr)_auto_auto] items-baseline gap-3 text-[0.75rem]">
            <span className="font-mono text-[0.6875rem] text-ink-2">{a.role}</span>
            <span className="truncate text-ink-3">{a.activity ?? a.state}</span>
            <Meta className={a.turns >= 15 ? "text-warn" : undefined}>{a.turns || 0} turn</Meta>
            <Meta>{money(a.total_usd)}</Meta>
          </div>
        ))}
      </div>
    </>
  );
}
