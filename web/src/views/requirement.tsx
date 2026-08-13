import { Button, LinkButton } from "../ui/button";
import { H2, Meta, Textarea, Working } from "../ui/bits";
import { Badge } from "../ui/badge";
import { Card, CardBody, CardTitle } from "../ui/card";
import { Bar } from "../ui/table";
import { Tip } from "../ui/tooltip";
import { ask } from "../ui/confirm";
import { Composer, ComposerDialog } from "../ui/composer";
import { post, type Escalation, type Group, type State } from "../lib/api";
import { STATUS_ZH, STOPS, WHERE_ZH, asksOf, gates, prUrl } from "../lib/select";
import { cn, K, money, waited } from "../lib/utils";
import { useState } from "react";
import { EvidencePanel } from "./evidence";
import { Notes } from "./notes";

/** One requirement in full: slices, their tasks, who is on it, and what it asks. */
export function Requirement({
  st, g, refresh, open,
}: {
  st: State; g: Group; refresh: () => void; open: boolean;
}) {
  const slices = st.slices.filter((s) => s.grp_id === g.id);
  const done = slices.filter((s) => s.status === "accepted").length;
  const asks = asksOf(st, g.id);
  const inQueue = st.mergeQueue.some((m) => m.grpId === g.id);
  const url = prUrl(st, g);
  const act = async (a: string) => { await post(`/api/groups/${g.id}/${a}`); refresh(); };
  const broke = g.budget_tokens != null && g.spent_tokens >= g.budget_tokens;

  return (
    <section className="border-t border-rule py-4 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1.5">
        <span className="font-display text-[1.125rem] font-semibold">{g.name}</span>
        <Badge tone={g.status === "DRAFT" ? "mine" : g.status === "RUNNING" ? "live" : "muted"}>
          {STATUS_ZH[g.status] ?? g.status}
        </Badge>
        {slices.length > 0 && <Meta>已查收 {done}/{slices.length}</Meta>}
        {g.branch && <Meta>{g.branch}</Meta>}
        <Meta>{money(g.spent_usd)}</Meta>
        <Budget g={g} refresh={refresh} />
        <span className="ml-auto flex flex-wrap gap-1.5">
          {g.status === "RUNNING" && <Button onClick={() => act("pause")}>暂停</Button>}
          {["PAUSED", "PAUSING"].includes(g.status) && !broke && (
            <Button onClick={() => act("resume")}>继续</Button>
          )}
          {g.status === "PARKED" && <Button onClick={() => act("wake")}>唤醒</Button>}
          {["RUNNING", "PAUSING"].includes(g.status) && (
            <>
              <Tip label="停止当前 turn，保留未完成改动">
                <Button variant="quiet"
                  onClick={async () => { await post(`/api/groups/${g.id}/interrupt`, { mode: "keep" }); refresh(); }}>
                  打断
                </Button>
              </Tip>
              <Button variant="quiet"
                onClick={async () => {
                  const go = await ask({
                    title: "打断并回滚", body: "丢弃当前 turn 的全部改动，退回到这一轮开始前。",
                    yes: "打断并回滚", danger: true,
                  });
                  if (!go) return;
                  await post(`/api/groups/${g.id}/interrupt`, { mode: "rollback" });
                  refresh();
                }}>
                打断并回滚
              </Button>
            </>
          )}
          {url && <LinkButton href={url}>打开 PR ↗</LinkButton>}
          {inQueue && <Landed grpId={g.id} refresh={refresh} />}
          {!inQueue && g.status === "PR_OPEN" && <Badge>排队中</Badge>}
          {/* 封存 only where it does something. Offered on a PARKED or PR_OPEN group
              it is a button that silently changes nothing. */}
          {["RUNNING", "PAUSING", "PAUSED"].includes(g.status) && (
            <Tip label="停下来收好：交接 journal 写掉，session 退休，worktree 和 checkpoint 原地不动，随时唤醒">
              <Button variant="quiet" onClick={() => act("park")}>封存</Button>
            </Tip>
          )}
        </span>
      </div>

      {broke && <BudgetWall g={g} refresh={refresh} />}

      {g.status === "DRAFT" ? (
        <Draft st={st} g={g} refresh={refresh} />
      ) : slices.length ? (
        slices.map((s) => <Lane key={s.id} st={st} g={g} s={s} refresh={refresh} open={open} />)
      ) : (
        <Working>{g.status === "PLANNING" ? "正在重新拆解" : "正在拆解"}</Working>
      )}

      {asks.length > 0 && (
        <>
          <H2 className="mt-6">待你决策</H2>
          {asks.map((e) => <Ask key={e.id} e={e} refresh={refresh} />)}
        </>
      )}

      {open && (
        <>
          <Delegated st={st} g={g} refresh={refresh} />
          {/* What this group decided and why. The journal is ≤6 lines by force, so
              this is the cheapest honest account of the work that exists. */}
          <H2 className="mt-6">记录</H2>
          <Notes grpId={g.id} compact />
          <Roster st={st} g={g} />
          <Say g={g} refresh={refresh} />
        </>
      )}
    </section>
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
function Delegated({ st, g, refresh }: { st: State; g: Group; refresh: () => void }) {
  const rows = st.answered.filter((a) => a.grp_id === g.id);
  if (!rows.length) return null;
  return (
    <>
      <H2 className="mt-6">别人替你答的</H2>
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
function Say({ g, refresh }: { g: Group; refresh: () => void }) {
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
          placeholder="补充要求，或者写退回理由。截图、设计稿直接粘。⌘Enter 补充给 Dispatcher"
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
        placeholder="下一个 turn 开头就会读到。截图可以直接粘。⌘Enter 发给 PM"
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

function Lane({ st, g, s, refresh, open }: { st: State; g: Group; s: State["slices"][0]; refresh: () => void; open: boolean }) {
  const gs = gates(s);
  const waiting = s.status === "awaiting_boss";
  const on = st.agents.filter((a) => a.grp_id === g.id && a.state === "running");
  const tasks = st.tasks.filter((t) => t.slice_id === s.id);
  // Open by default on the one the boss has to judge. Anything already accepted or
  // still running is a click away, because it is being looked up, not decided.
  const [look, setLook] = useState(false);
  const showEvidence = waiting || look;

  return (
    <div
      className={cn(
        "grid items-start gap-x-3 gap-y-1.5 border-t border-rule-soft py-2",
        "grid-cols-[1.75rem_minmax(0,1fr)_13rem_8.5rem]",
        "max-[78rem]:grid-cols-[1.75rem_minmax(0,1fr)_auto] max-[52rem]:grid-cols-[1.75rem_minmax(0,1fr)]",
        waiting && "-mx-2 rounded-md border-t-transparent bg-accent-soft px-2",
      )}
    >
      <span className="pt-px font-mono text-[0.75rem] text-ink-3">S{s.seq}</span>
      <div className="min-w-0">
        <div className="text-[0.8125rem]">
          {s.title} <span className="font-mono text-[0.625rem] text-ink-3">{s.difficulty}</span>
        </div>
        <div className="mt-px font-mono text-[0.6875rem] text-ink-3">{s.accept_spec}</div>
        {s.status === "pending" && <div className="mt-px text-[0.6875rem] text-ink-3">等前序切片</div>}
        {s.status === "rejected" && (
          <div className="mt-px text-[0.6875rem] font-medium text-bad">已退回，等它修</div>
        )}
        {["in_progress", "running", "gate", "qa"].includes(s.status) && on.length > 0 && (
          <div className="mt-px font-mono text-[0.6875rem] text-ink-2">
            {on.map((a) => `${a.role} ▸ ${a.activity ?? a.state}`).join(" · ")}
          </div>
        )}
        {open && tasks.length > 0 && (
          <ul className="mt-1.5 list-none p-0">
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
        {open && !waiting && s.status !== "pending" && (
          <button
            onClick={() => setLook((v) => !v)}
            className="mt-1 cursor-pointer font-mono text-[0.6875rem] text-ink-3 underline decoration-dotted hover:text-ink"
          >
            {look ? "收起改动" : "看改动"}
          </button>
        )}
        {showEvidence && <EvidencePanel sliceId={s.id} />}
      </div>
      <span className="flex items-center max-[52rem]:col-span-full max-[52rem]:col-start-2 max-[52rem]:pl-0">
        {[...STOPS, ["boss", waiting ? "待查收" : "查收"] as [string, string]].map(([k, zh], i, arr) => {
          const v = k === "boss" ? (waiting ? "wait" : s.status === "accepted" ? "pass" : "") : gs[k];
          return (
            <span key={k} className={cn(
              "flex items-center gap-1 text-[0.6875rem]",
              v === "pass" && "text-ok", v === "fail" && "text-bad",
              v === "wait" && "font-semibold text-accent",
              !v && s.status === k && "text-ink", !v && s.status !== k && "text-ink-3",
            )}>
              <span className={cn(
                "size-2 rounded-full border",
                v === "pass" && "border-ok bg-ok", v === "fail" && "border-bad bg-bad",
                v === "wait" && "border-accent bg-accent",
                !v && s.status === k && "breathe border-ink", !v && s.status !== k && "border-ink-3",
              )} />
              <b className="whitespace-nowrap font-medium">{zh}</b>
              {i < arr.length - 1 && <span className="mx-1.5 h-px w-3.5 bg-rule" />}
            </span>
          );
        })}
      </span>
      <span className="flex items-center justify-end gap-1.5 max-[78rem]:col-span-full max-[78rem]:justify-start">
        {waiting && (
          <>
            <Button variant="go" onClick={async () => { await post(`/api/slices/${s.id}/accept`); refresh(); }}>
              查收
            </Button>
            <RejectSlice sliceId={s.id} refresh={refresh} />
          </>
        )}
      </span>
    </div>
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

function Roster({ st, g }: { st: State; g: Group }) {
  const rows = st.agents.filter((a) => a.grp_id === g.id);
  if (!rows.length) return null;
  return (
    <>
      <H2 className="mt-6">这个组的人</H2>
      <div className="grid gap-1">
        {rows.map((a) => (
          <div key={a.id} className="grid grid-cols-[5rem_minmax(0,1fr)_auto] items-baseline gap-2 text-[0.75rem]">
            <span className="font-mono text-[0.6875rem] text-ink-2">{a.role}</span>
            <span className="truncate text-ink-3">{a.activity ?? a.state}</span>
            <Meta>{money(a.total_usd)}</Meta>
          </div>
        ))}
      </div>
    </>
  );
}
