import { useState, useTransition } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, LinkButton } from "../../ui/button";
import { Tip } from "../../ui/tooltip";
import { Meta } from "../../ui/bits";
import { AnswerDraftSchema, api, mutate, readApi } from "../../shared/api";
import { usePaged } from "../../shared/page";
import type { State } from "../../shared/api";
import { groupName } from "./rank";
import { KIND_ZH } from "../../shared/select";
import { K } from "../../shared/format";
import { cn } from "../../ui/cn";
import { foldQueueItems, queueClusters, queueItems, type QueueCluster, type QueueItem } from "./model";

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
  const items = queueItems(st, projectId);

  // Was the label plus an explanation of the label: a sentence naming the four
  // things that would refill it and promising a notification. A queue that fills
  // itself does not need a paragraph saying it will.
  if (!items.length) {
    return <div className="text-[0.8125rem] text-ok">都处理完了</div>;
  }

  const blocks = queueClusters(items).map((cluster) => ({
    node: <Cluster key={cluster.grpId} st={st} c={cluster} onOpen={onOpen} refresh={refresh} />,
  }));

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
  c: QueueCluster;
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
  const folded = foldQueueItems(c.items);
  const shown = folded.slice(0, 6);
  return (
    <div
      role="button"
      aria-disabled={standing}
      tabIndex={clusterTabIndex(standing)}
      onClick={(event) => openClusterFromClick(event, standing, c.grpId, onOpen)}
      onKeyDown={(event) => openClusterFromKey(event, standing, c.grpId, onOpen)}
      className={clusterClass(standing)}
    >
      <ClusterIdentity st={st} c={c} standing={standing} hard={hard} />
      <ClusterTickets folded={folded} shown={shown} refresh={refresh} standing={standing} />

      <span data-queue-action className="flex items-center gap-2 whitespace-nowrap">
        <MergeAction items={c.items} />
        <ClusterBranch branch={g?.branch} />
      </span>
    </div>
  );
}

const clusterTabIndex = (standing: boolean) => (standing ? -1 : 0);
const clusterClass = (standing: boolean) =>
  cn(
    "grid grid-cols-[14rem_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2",
    "border-t border-rule-soft px-2 py-2.5 transition-colors first:border-t-0",
    !standing && "cursor-pointer hover:bg-rail/70",
    "max-[60rem]:grid-cols-[minmax(0,1fr)_auto]",
  );

function ClusterBranch({ branch }: { branch: string | null | undefined }) {
  return <Meta>{branch ?? ""}</Meta>;
}

const fromQueueAction = (target: EventTarget | null) =>
  target instanceof Element && target.closest("[data-queue-action]") !== null;

function openClusterFromClick(event: React.MouseEvent, standing: boolean, grpId: number, onOpen: (id: number) => void) {
  if (standing) return;
  if (fromQueueAction(event.target)) return;
  onOpen(grpId);
}

function openClusterFromKey(
  event: React.KeyboardEvent,
  standing: boolean,
  grpId: number,
  onOpen: (id: number) => void,
) {
  if (standing || event.target !== event.currentTarget) return;
  if (!new Set(["Enter", " "]).has(event.key)) return;
  event.preventDefault();
  onOpen(grpId);
}

function ClusterIdentity({ st, c, standing, hard }: { st: State; c: QueueCluster; standing: boolean; hard: number }) {
  const group = st.groups.find((candidate) => candidate.id === c.grpId);
  return (
    <div className="min-w-0">
      <div className="truncate font-display text-[0.9375rem] font-semibold">{clusterName(st, c.grpId, standing)}</div>
      <Meta>
        {clusterWaiting(hard, c.items.length)}
        {clusterTokens(group?.spent_tokens)}
      </Meta>
    </div>
  );
}

const clusterName = (st: State, grpId: number, standing: boolean) => (standing ? "常驻岗" : groupName(st, grpId));
const clusterWaiting = (hard: number, total: number) => (hard > 0 ? `${hard} 条卡着全组` : `${total} 条等你`);
const clusterTokens = (tokens: number | undefined) => (tokens ? ` · ${K(tokens)} tokens` : "");

function ClusterTickets({
  folded,
  shown,
  refresh,
  standing,
}: {
  folded: { item: QueueItem; n: number }[];
  shown: { item: QueueItem; n: number }[];
  refresh: () => void;
  standing: boolean;
}) {
  return (
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
function MergeAction({ items }: { items: QueueItem[] }) {
  const href = items.find((item) => item.href)?.href;
  return href ? <LinkButton href={href}>去合并 PR ↗</LinkButton> : null;
}

function Ticket({
  item,
  n,
  refresh,
  standing,
}: {
  item: QueueItem;
  n: number;
  refresh: () => void;
  standing: boolean;
}) {
  return (
    <Tip label={item.what}>
      <span
        className={cn(
          "w-[13rem] shrink-0 rounded-[0.3125rem] border px-1.5 py-1",
          // Opaque, so it survives whatever the row does on hover.
          item.hard ? "border-bad/70 bg-bad-soft" : "border-rule-soft bg-sunk",
        )}
      >
        <TicketMeta item={item} n={n} />
        <span className="mt-px block truncate text-[0.6875rem] text-ink-2">{item.what}</span>
        {/* A standing agent has no requirement to open, so its reply box is the
            only way to clear it and it stays on the card. */}
        <TicketReply item={item} standing={standing} refresh={refresh} />
      </span>
    </Tip>
  );
}

function TicketMeta({ item, n }: { item: QueueItem; n: number }) {
  return (
    <span className="flex items-center gap-1 font-mono text-[0.625rem] text-ink-3">
      {item.who}
      <TicketAbout item={item} />
      {n > 1 && <span className="font-semibold text-ink-2">×{n}</span>}
      <span className="grow" />
      {item.reasons.find((reason) => reason.why.startsWith("等了"))?.why.replace("等了 ", "")}
    </span>
  );
}

function TicketAbout({ item }: { item: QueueItem }) {
  return item.about && KIND_ZH[item.about] ? <span className="text-ink-2">{KIND_ZH[item.about]}</span> : null;
}

function TicketReply({ item, standing, refresh }: { item: QueueItem; standing: boolean; refresh: () => void }) {
  if (!standing || item.escId == null) return null;
  return (
    <span data-queue-action className="mt-1 block">
      <Reply escId={item.escId} fyi={item.fyi} refresh={refresh} />
    </span>
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
  const [busy, startTransition] = useTransition();
  const send = (answer: string) => {
    // The re-entry guard stays: `startTransition` starts a second action rather
    // than refusing one, and `orch ask-boss` unblocks on the first answer — a
    // double press would post the same answer twice.
    if (busy || !answer.trim()) return;
    startTransition(async () => {
      await mutate(api.escalations[":id"].answer.$post({ param: { id: String(escId) }, json: { answer } }));
      setOpen(false);
      setText("");
      refresh();
    });
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
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(event) =>
          handleReplyKey(
            event,
            () => setOpen(false),
            () => send(text),
          )
        }
        placeholder="回答…  ⌘↵ 发送"
        className="w-[20rem] resize-none rounded-md border border-rule bg-paper px-2 py-1.5 text-[0.8125rem] outline-none focus:border-accent"
      />
      <Button variant="go" disabled={busy || !text.trim()} onClick={() => send(text)}>
        发送
      </Button>
    </span>
  );
}

const hasReplyModifier = (metaKey: boolean, ctrlKey: boolean) => metaKey || ctrlKey;

export function replyKeyAction(key: string, metaKey: boolean, ctrlKey: boolean): "close" | "send" | null {
  if (key === "Escape") return "close";
  if (key !== "Enter") return null;
  return hasReplyModifier(metaKey, ctrlKey) ? "send" : null;
}

function handleReplyKey(event: React.KeyboardEvent, close: () => void, send: () => void) {
  const action = replyKeyAction(event.key, event.metaKey, event.ctrlKey);
  if (action === "close") close();
  if (action === "send") send();
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
  // Keyed by the question it drafts an answer to. There is no race to fix here —
  // the list keys each row by `a${escalation.id}`, so a mounted `Draft` keeps
  // its `escId` for life — but a draft is a model call, and the box is opened,
  // shut and opened again while the boss reads the question. The cache means the
  // second open shows the draft it already has while it re-reads, rather than
  // paying for the call again before the button can appear.
  const { data: text } = useQuery({
    queryKey: ["answer-draft", escId],
    queryFn: async () =>
      (
        await readApi(api.escalations[":id"].draft.$get({ param: { id: String(escId) } }), AnswerDraftSchema)
      )?.text?.trim() ?? "",
  });
  if (!text) return null;
  return (
    <Tip label={text}>
      <Button size="sm" onClick={() => onUse(text)}>
        用草稿
      </Button>
    </Tip>
  );
}
