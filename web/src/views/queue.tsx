import { useEffect, useState } from "react";
import { Button, LinkButton } from "../ui/button";
import { Tip } from "../ui/tooltip";
import { Meta } from "../ui/bits";
import { AnswerDraftSchema, api, mutate, readApi } from "../lib/api";
import { usePaged } from "../lib/page";
import type { State } from "../lib/api";
import { byRequirement, groupName, rank, REASONS, type Reason } from "../lib/rank";
import { KIND_ZH, pending, prUrl } from "../lib/select";
import { brief, cn, K } from "../lib/utils";

/**
 * Everything waiting on the boss, ordered by what ignoring it costs.
 *
 * It can reach zero, and that matters: "都处理完了" is achievable, where a board always
 * looks half empty and trains the reader to ignore it.
 *
 * Two earlier versions were wrong in opposite directions. The first tinted all five
 * rows in the accent, so the accent stopped meaning anything. The second split them
 * into 停着不动 / 可以稍后 — true, but only two levels, and "everything in this list is
 * important" is exactly right: the question is never whether an item matters, it is
 * which one to open first. So each row carries the reason it sits where it does, and
 * rows on the same requirement cluster — one trip instead of three context switches.
 */
interface Item {
  key: string;
  kind: string;
  what: string;
  /** Which requirement it came from. A question with no home reads as the system's. */
  where?: string;
  sub: string;
  /** Who is stuck. The boss reads a queue by role before anything else. */
  who?: string;
  /** Blocking work, or merely asking. Two shapes, not two paragraphs. */
  hard?: boolean;
  /** env | spec | boundary | design | other — what the question is about. */
  about?: string;
  grpId: number | null;
  points: number;
  reasons: Reason[];
  flag?: string;
  actions: React.ReactElement | null;
  /** An open question, answerable without leaving the list. */
  escId?: number;
  /** Told, not asked: 知道了 is the only move. */
  fyi?: boolean;
}

export function Queue({
  st,
  projectId,
  onOpen,
  refresh,
}: {
  st: State;
  projectId: number | null;
  onOpen: (grpId: number) => void;
  refresh: () => void;
}) {
  const w = pending(st, projectId);
  const now = Date.now();
  /**
   * Nothing is running on this requirement: its agents are idle until you act.
   *
   * A standing agent has no requirement, so there is no group to be stopped — the
   * row used to claim 组停着不动 about a question the Architect filed for information.
   */
  const halted = (grpId: number | null) =>
    grpId != null && !st.agents.some((a) => a.grp_id === grpId && a.state === "running");
  const spend = (grpId: number | null) => st.groups.find((g) => g.id === grpId)?.spent_tokens ?? 0;

  const items: Item[] = [];

  for (const g of w.cards) {
    const card = st.draftCards.find((c) => c.grpId === g.id);
    // A planner that found the work already covered files this instead of a card.
    // Labelled as a plan it read as "go review the slices" and there were none.
    const drop = st.dropProposals.find((p) => p.grpId === g.id);
    const goal = (card?.body.split("\n").find((l) => l.startsWith("目标")) ?? "").replace(/^目标\s*[:：]\s*/, "");
    items.push({
      key: `c${g.id}`,
      kind: drop ? "作废" : "计划",
      where: g.name,
      what: drop ? drop.body.split("\n")[0]! : goal || "计划卡未提交",
      who: "dispatcher",
      sub: "",
      grpId: g.id,
      ...rank([
        REASONS.unstarted(),
        card ? REASONS.waited(now - card.at) : null,
        spend(g.id) > 0 && REASONS.sunk(spend(g.id)),
      ]),
      ...(st.lateObjections.some((o) => o.grpId === g.id) ? { flag: "有反对意见" } : {}),
      // No button: the row is the way in. See `Cluster`.
      actions: null,
    });
  }
  for (const s of w.slices) {
    items.push({
      key: `s${s.id}`,
      kind: "切片",
      where: groupName(st, s.grp_id),
      what: s.title,
      who: "qa",
      sub: s.accept_spec,
      grpId: s.grp_id,
      ...rank([halted(s.grp_id) && REASONS.halted(), s.awaiting_at ? REASONS.waited(now - s.awaiting_at) : null]),
      // 查收 and 不满意 both happen on the requirement page, next to the diff and
      // the verdicts: accepting from a list is accepting a title, and rejecting
      // from one is rejecting a title.
      actions: null,
    });
  }
  for (const m of w.merges) {
    const g = st.groups.find((x) => x.id === m.grpId);
    const url = g ? prUrl(st, g) : null;
    // Everything queued behind the head cannot merge until this one does.
    const behind = Math.max(
      0,
      st.groups.filter((x) => x.status === "PR_OPEN" && x.project_id === g?.project_id).length - 1,
    );
    items.push({
      key: `m${m.grpId}`,
      kind: "PR",
      where: m.name,
      what: m.branch ?? "等你合入",
      who: "auditor",
      sub: url ? "" : "未找到 PR 链接",
      grpId: m.grpId,
      ...rank([
        REASONS.halted(),
        behind > 0 && REASONS.blocking(behind),
        spend(m.grpId) > 0 && REASONS.sunk(spend(m.grpId)),
      ]),
      // GitHub does the merging, and GitHub is asked whether it happened — so the
      // only action here is going there.
      actions: url ? <LinkButton href={url}>去合并 PR ↗</LinkButton> : null,
    });
  }
  for (const e of w.asks) {
    items.push({
      key: `a${e.id}`,
      kind: "提问",
      // The one line whoever filed it wrote for this list. The question itself is
      // an agent writing to another agent — `S2 "常驻岗独立分段" failed qa 3 times.
      // Latest: 结构: pass — splitDeskRows(tables.tsx:82-104)…` — and eight of
      // those is a page of prose in front of someone choosing what to open.
      what: e.brief?.trim() || brief(e.question),
      who: e.asker ?? "系统",
      hard: e.severity === "blocker",
      about: e.kind ?? "other",
      // The question was the only thing on the row, so a two-paragraph one filled
      // the card and never said which requirement was asking it.
      where: e.grp_id ? groupName(st, e.grp_id) : "常驻岗",
      // A watchdog escalation has no agent behind it, and "?" read like a bug.
      sub: e.asker ?? "系统",
      grpId: e.grp_id,
      ...rank([
        // `orch ask-boss` blocks its caller, so a blocker from an agent is that agent
        // hanging on you. A blocker the watchdog raised has no caller: the group is
        // suspended, and saying "an agent is waiting" would be the row inventing
        // urgency it cannot substantiate.
        e.severity === "blocker" && (e.asker ? REASONS.blocked(e.asker) : REASONS.suspended()),
        halted(e.grp_id) && REASONS.halted(),
        REASONS.waited(now - e.created_at),
      ]),
      ...(e.severity === "blocker" ? { flag: "全组已暂停" } : {}),
      escId: e.id,
      // A standing agent that files a non-blocker is telling you something, not
      // asking: nothing is hanging on the reply and there is no requirement to
      // reply about. A 回答 box there is a text field whose text goes nowhere.
      fyi: !e.grp_id && e.severity !== "blocker",
      // Answering happens where the question is readable in full, next to the
      // group's slices and its record — not from a row that shows two lines of
      // it. A standing agent has no requirement to go to, and `Cluster` gives
      // those the inline reply box instead.
      actions: null,
    });
  }

  // Was the label plus an explanation of the label: a sentence naming the four
  // things that would refill it and promising a notification. A queue that fills
  // itself does not need a paragraph saying it will.
  if (!items.length) {
    return <div className="text-[0.8125rem] text-ok">都处理完了</div>;
  }

  const { clustered, loose } = byRequirement(items);
  // Clusters and singletons interleave by weight: a lone blocker must not sit below a
  // cluster of three slow slices merely because the cluster has more rows.
  const blocks = [
    ...clustered.map((c) => ({
      points: c.points,
      node: <Cluster key={`g${c.grpId}`} st={st} c={c} onOpen={onOpen} refresh={refresh} />,
    })),
    // A question from a standing agent has no requirement to sit under, so it
    // gets one row of its own rather than a second shape in the list.
    ...(loose.length
      ? [
          {
            points: Math.max(...loose.map((i) => i.points)),
            node: <Cluster key="standing" st={st} c={{ grpId: -1, items: loose }} onOpen={onOpen} refresh={refresh} />,
          },
        ]
      : []),
  ].sort((a, b) => b.points - a.points);

  // No card, no second 待办 label: the tab this renders into already carries the
  // name and the count, and a titled card inside a titled tab was the same word
  // twice with two different numbers under it.
  // The sort order used to be printed above the list. Every row already carries
  // the reason it sits where it does, which is the same fact said once instead of
  // twice — and said on the row that has to justify itself.
  return <Paged blocks={blocks} />;
}

/**
 * Twenty requirements, then the rest one click away.
 *
 * The list is sorted by what ignoring each one costs, so the tail is cheap to
 * defer — and never to hide: the count of what is not shown is on the button,
 * because a silently truncated list reads as a complete one.
 */
function Paged({ blocks }: { blocks: { node: React.ReactNode }[] }) {
  const { page, rest, more } = usePaged(blocks, 20);
  return (
    <div>
      {page.map((b) => b.node)}
      {rest > 0 && (
        <div className="border-t border-rule-soft px-2 py-2">
          <Button variant="quiet" size="sm" onClick={more}>
            还有 {rest} 条需求
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * One requirement and everything waiting on it, in the shape 进行中 already uses.
 *
 * Identity on the left, the things themselves as cards in a track, the way out on
 * the right. That page reads well because the eye lands on one fixed column of
 * names and then scans a row of discrete objects; the queue was a table of text
 * columns instead, so the two halves of the same tab were two different pages.
 *
 * Severity lives on the card, because that is the thing it belongs to: a card
 * with a red edge is a group stopped behind that one question. Counting them is
 * how the boss decides which requirement to open.
 */
function Cluster({
  st,
  c,
  onOpen,
  refresh,
}: {
  st: State;
  c: { grpId: number; items: Item[] };
  onOpen: (id: number) => void;
  refresh: () => void;
}) {
  const standing = c.grpId < 0;
  const g = st.groups.find((x) => x.id === c.grpId);
  const hard = c.items.filter((i) => i.hard).length;
  // A requirement with thirty open questions is a real state — one bad premise
  // strands every slice behind it — and thirty of them are usually the same
  // problem said thirty times: the worktree has no playwright, the acceptance
  // line cannot be verified. Fold by what they are about, so the row says how
  // many problems there are rather than how many messages.
  //
  // Blockers first; six cards, and the rest counted rather than hidden. What the
  // boss decides here is which requirement to open, and six answers it.
  const folded = fold(c.items);
  const shown = folded.slice(0, 6);
  const fromAction = (target: EventTarget | null) =>
    target instanceof Element && target.closest("[data-queue-action]") !== null;
  return (
    <div
      role="button"
      aria-disabled={standing}
      tabIndex={standing ? -1 : 0}
      onClick={(e) => {
        if (!standing && !fromAction(e.target)) onOpen(c.grpId);
      }}
      onKeyDown={(e) => {
        if (standing || e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        onOpen(c.grpId);
      }}
      className={cn(
        "grid grid-cols-[14rem_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2",
        "border-t border-rule-soft px-2 py-2.5 transition-colors first:border-t-0",
        // `rail`, not `sunk`: the cards are on `sunk`, and a row that hovers to the
        // card colour makes every card vanish under the cursor.
        !standing && "cursor-pointer hover:bg-rail/70",
        "max-[60rem]:grid-cols-[minmax(0,1fr)_auto]",
      )}
    >
      <div className="min-w-0">
        <div className="truncate font-display text-[0.9375rem] font-semibold">
          {standing ? "常驻岗" : groupName(st, c.grpId)}
        </div>
        <Meta>
          {hard > 0 ? `${hard} 条卡着全组` : `${c.items.length} 条等你`}
          {g?.spent_tokens ? ` · ${K(g.spent_tokens)} tokens` : ""}
        </Meta>
      </div>

      <div className="flex min-w-0 flex-wrap items-stretch gap-1.5 max-[60rem]:col-span-full">
        {shown.map(({ item, n }) => (
          <Ticket key={item.key} item={item} n={n} refresh={refresh} standing={standing} />
        ))}
        {folded.length > shown.length && (
          <span className="self-center font-mono text-[0.6875rem] text-ink-3">
            还有 {folded.length - shown.length} 条
          </span>
        )}
      </div>

      <span data-queue-action className="flex items-center gap-2 whitespace-nowrap">
        {c.items.find((i) => i.actions)?.actions}
        <Meta>{g?.branch ?? ""}</Meta>
      </span>
    </div>
  );
}

/**
 * One thing waiting, as a card the size of a slice card next door.
 *
 * Who is stuck on the first line, what about on the second. A blocker takes the
 * bad edge: it is not a louder version of a question, it is a different fact —
 * the group behind it is stopped until this is answered.
 */
/**
 * Same requirement, same kind, same role: one problem, however many times it was
 * asked. The newest one leads, because it is the one that has the current facts —
 * an environment question filed an hour ago has usually been overtaken by the one
 * filed ten minutes ago.
 */
function fold(items: Item[]): { item: Item; n: number }[] {
  const by = new Map<string, { item: Item; n: number }>();
  for (const i of items) {
    const key = i.about && i.about !== "other" ? `${i.kind}:${i.about}:${i.who}` : i.key;
    const seen = by.get(key);
    if (seen) seen.n += 1;
    else by.set(key, { item: i, n: 1 });
  }
  return [...by.values()].sort((a, b) => Number(b.item.hard) - Number(a.item.hard));
}

function Ticket({ item, n, refresh, standing }: { item: Item; n: number; refresh: () => void; standing: boolean }) {
  return (
    <Tip label={item.what}>
      <span
        className={cn(
          "w-[13rem] shrink-0 rounded-[0.3125rem] border px-1.5 py-1",
          // Opaque, so it survives whatever the row does on hover.
          item.hard ? "border-bad/70 bg-bad-soft" : "border-rule-soft bg-sunk",
        )}
      >
        <span className="flex items-center gap-1 font-mono text-[0.625rem] text-ink-3">
          {item.who ?? item.kind}
          {/* What it is about, and how many said the same thing. `环境 ×12` is one
              decision; twelve cards saying it is twelve. */}
          {item.about && KIND_ZH[item.about] && <span className="text-ink-2">{KIND_ZH[item.about]}</span>}
          {n > 1 && <span className="font-semibold text-ink-2">×{n}</span>}
          <span className="grow" />
          {item.reasons.find((r) => r.why.startsWith("等了"))?.why.replace("等了 ", "")}
        </span>
        <span className="mt-px block truncate text-[0.6875rem] text-ink-2">{item.what}</span>
        {/* A standing agent has no requirement to open, so its reply box is the
            only way to clear it and it stays on the card. */}
        {standing && item.escId != null && (
          <span data-queue-action className="mt-1 block">
            <Reply escId={item.escId} {...(item.fyi !== undefined ? { fyi: item.fyi } : {})} refresh={refresh} />
          </span>
        )}
      </span>
    </Tip>
  );
}

/**
 * Answer a question from the list.
 *
 * `orch ask-boss` blocks its caller until this lands, and the Architect files
 * questions with no requirement behind them — those had a 去回答 button that opened
 * a requirement id of null, so the one class of question the boss cannot navigate to
 * was also the one they could not clear. 知道了 is the whole point for an FYI: the
 * answer text is unimportant, unblocking the agent is not.
 */
function Reply({ escId, fyi, refresh }: { escId: number; fyi?: boolean; refresh: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async (answer: string) => {
    if (busy || !answer.trim()) return;
    setBusy(true);
    await mutate(api.escalations[":id"].answer.$post({ param: { id: String(escId) }, json: { answer } }));
    setBusy(false);
    setOpen(false);
    setText("");
    refresh();
  };
  if (fyi) {
    return (
      <Button variant="go" disabled={busy} onClick={() => send("知道了")}>
        知道了
      </Button>
    );
  }
  if (!open)
    return (
      <Button variant="go" onClick={() => setOpen(true)}>
        回答
      </Button>
    );
  return (
    <span className="flex items-end gap-1.5">
      <Draft escId={escId} onUse={setText} />
      <textarea
        autoFocus
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(text);
        }}
        placeholder="回答…  ⌘↵ 发送"
        className="w-[20rem] resize-none rounded-md border border-rule bg-paper px-2 py-1.5 text-[0.8125rem] outline-none focus:border-accent"
      />
      <Button variant="go" disabled={busy || !text.trim()} onClick={() => void send(text)}>
        发送
      </Button>
    </span>
  );
}

/**
 * The drafted answer, offered from the queue as well as the requirement page.
 *
 * This is where the boss actually answers now — 待办 is one tab and the question
 * has its reply box on the row — so a draft that only existed on the drill-in was
 * a draft nobody saw. Same call, same rule: computed on open, never stored, and
 * it goes into the box rather than to the agent.
 */
function Draft({ escId, onUse }: { escId: number; onUse: (t: string) => void }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    void readApi(api.escalations[":id"].draft.$get({ param: { id: String(escId) } }), AnswerDraftSchema).then((r) =>
      setText(r?.text?.trim() || ""),
    );
  }, [escId]);
  if (!text) return null;
  return (
    <Tip label={text}>
      <Button size="sm" onClick={() => onUse(text)}>
        用草稿
      </Button>
    </Tip>
  );
}
