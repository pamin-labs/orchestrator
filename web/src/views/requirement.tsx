import { Button, LinkButton } from "../ui/button";
import { Empty, H2, Input, Meta, Pill, Textarea, Working } from "../ui/bits";
import { ask } from "../ui/confirm";
import { post, type Escalation, type Group, type State } from "../lib/api";
import { STATUS_ZH, STOPS, WHERE_ZH, asksOf, gates, prUrl } from "../lib/select";
import { cn, money, waited } from "../lib/utils";
import { useState } from "react";

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

  return (
    <section className="border-t border-rule py-4 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline gap-2.5">
        <span className="font-display text-[1.125rem] font-semibold">{g.name}</span>
        <Pill tone={g.status === "DRAFT" ? "mine" : g.status === "RUNNING" ? "live" : "muted"}>
          {STATUS_ZH[g.status] ?? g.status}
        </Pill>
        {slices.length > 0 && <Meta>已查收 {done}/{slices.length}</Meta>}
        {g.branch && <Meta>{g.branch}</Meta>}
        <Meta>{money(g.spent_usd)}</Meta>
        <span className="ml-auto flex gap-1.5">
          {g.status === "RUNNING" && <Button onClick={() => act("pause")}>暂停</Button>}
          {["PAUSED", "PAUSING"].includes(g.status) && <Button onClick={() => act("resume")}>继续</Button>}
          {g.status === "PARKED" && <Button onClick={() => act("wake")}>唤醒</Button>}
          {["RUNNING", "PAUSING"].includes(g.status) && (
            <>
              <Button variant="quiet" title="停止当前 turn，保留未完成改动"
                onClick={async () => { await post(`/api/groups/${g.id}/interrupt`, { mode: "keep" }); refresh(); }}>
                打断
              </Button>
              <Button variant="quiet" title="停止当前 turn 并回滚到起点"
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
          {inQueue && (
            <Button variant="go" onClick={async () => {
              const go = await ask({
                title: "确认已合入 main",
                body: "本组收尾归档，队列中下一个需求放行，其余需求会被要求 rebase。",
                yes: "已合入，收尾",
              });
              if (!go) return;
              await post(`/api/groups/${g.id}/landed`);
              refresh();
            }}>确认已合入</Button>
          )}
          {!inQueue && g.status === "PR_OPEN" && <Pill>排队中</Pill>}
          <Button variant="quiet" onClick={() => act("park")}>封存</Button>
        </span>
      </div>

      {g.status === "DRAFT" ? (
        <Draft st={st} g={g} refresh={refresh} />
      ) : slices.length ? (
        slices.map((s) => <Lane key={s.id} st={st} g={g} s={s} refresh={refresh} open={open} />)
      ) : (
        <Working>正在拆解</Working>
      )}

      {asks.length > 0 && (
        <>
          <H2 className="mt-6">待你决策</H2>
          {asks.map((e) => <Ask key={e.id} e={e} refresh={refresh} />)}
        </>
      )}

      {open && <Roster st={st} g={g} />}
    </section>
  );
}

function Draft({ st, g, refresh }: { st: State; g: Group; refresh: () => void }) {
  const filed = st.draftCards.find((c) => c.grpId === g.id)?.body ?? "";
  const idea = st.ideas.find((i) => i.grpId === g.id)?.body ?? "";
  const late = st.lateObjections.filter((o) => o.grpId === g.id);
  const [card, setCard] = useState(filed);
  const [why, setWhy] = useState("");

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
          <div className="mt-3 flex items-center gap-2">
            <Button variant="go" onClick={async () => {
              // Send the text only when edited: an untouched card is approved as
              // filed, so "approve" and "edit then approve" stay distinct requests.
              const edited = card.trim() && card.trim() !== filed.trim();
              await post(`/api/draft/${g.id}/approve`, edited ? { card: card.trim() } : {});
              refresh();
            }}>批准开工</Button>
            <Input className="grow" placeholder="退回理由" value={why} onChange={(e) => setWhy(e.target.value)} />
            <Button onClick={async () => { await post(`/api/draft/${g.id}/reject`, { reason: why }); refresh(); }}>
              退回重拆
            </Button>
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
  return (
    <div
      className={cn(
        "grid items-start gap-x-3 gap-y-1.5 border-t border-rule-soft py-2",
        "grid-cols-[1.75rem_minmax(0,1fr)_13rem_8.5rem] max-[78rem]:grid-cols-[1.75rem_minmax(0,1fr)_auto]",
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
      </div>
      <span className="flex items-center">
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
            <Button onClick={async () => {
              const w = await ask({ title: "退回这一片", body: "原话记入黑板，PM 据此安排修正。", yes: "退回", field: "哪里不满意" });
              if (w === null) return;
              await post(`/api/slices/${s.id}/reject`, { feedback: w });
              refresh();
            }}>不满意</Button>
          </>
        )}
      </span>
    </div>
  );
}

function Ask({ e, refresh }: { e: Escalation; refresh: () => void }) {
  const [answer, setAnswer] = useState("");
  const mine = e.chain_state === "boss";
  return (
    <div className="border-t border-rule-soft py-2.5 first:border-t-0">
      <div className={cn("font-mono text-[0.6875rem]", e.severity === "blocker" ? "text-bad" : "text-ink-3")}>
        {e.asker ?? "?"} · {e.severity === "blocker" ? "阻塞" : "非阻塞"} ·{" "}
        {WHERE_ZH[e.chain_state] ?? e.chain_state} · {waited(e.created_at)}
      </div>
      <div className="my-1 text-[0.8125rem]">{e.question}</div>
      {mine && (
        <div className="flex items-center gap-2">
          <Input className="grow" placeholder="答复" value={answer} onChange={(ev) => setAnswer(ev.target.value)} />
          <Button variant="go" onClick={async () => { await post(`/api/escalations/${e.id}/answer`, { answer }); refresh(); }}>
            回答
          </Button>
          <Button title="转交 Architect 判断"
            onClick={async () => { await post(`/api/escalations/${e.id}/delegate`, { to: "architect" }); refresh(); }}>
            转 Architect
          </Button>
        </div>
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
