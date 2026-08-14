import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { Meta, Clamp } from "../ui/bits";
import { post, pull, type Escalation } from "../lib/api";
import { cn, nl, waited } from "../lib/utils";

/**
 * Answer everything waiting on you in one pass.
 *
 * Two questions on one requirement is the normal case, and they are usually two
 * halves of the same problem — the same premise is missing, the same acceptance
 * line is wrong. Answering them one at a time means reading the same context
 * twice, typing the same answer twice, and two round trips through a list that
 * reorders itself under you between them.
 *
 * So: every question on the boss, each with its drafted answer already in its
 * box, one send. The drafts are fetched in parallel on open — they are the whole
 * point of doing this in a batch, because reading three drafts and correcting
 * two is faster than writing three.
 *
 * A box left empty is a question skipped, not an empty answer sent. Nothing
 * leaves this dialog until 全部发送, and what is sent is whatever is in the boxes
 * at that moment — the drafts are a starting point, never the answer.
 */
export function AnswerAll({
  rows, refresh,
}: {
  rows: Escalation[]; refresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (rows.length < 2) return null;
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>一起回答 {rows.length} 条</Button>
      {open && <Sheet rows={rows} refresh={refresh} onClose={() => setOpen(false)} />}
    </>
  );
}

function Sheet({
  rows, refresh, onClose,
}: {
  rows: Escalation[]; refresh: () => void; onClose: () => void;
}) {
  // Keyed by escalation id, so a draft arriving late cannot land in another
  // question's box after the boss has started typing in it.
  const [text, setText] = useState<Record<number, string>>({});
  const [touched, setTouched] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    for (const e of rows) {
      void pull<{ text: string }>(`/api/escalations/${e.id}/draft`).then((r) => {
        const t = r?.text?.trim();
        if (!t) return;
        setText((prev) => (prev[e.id] || touched[e.id] ? prev : { ...prev, [e.id]: t }));
      });
    }
    // Once, on open: a re-fetch would overwrite what the boss has written.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ready = rows.filter((e) => (text[e.id] ?? "").trim());

  const send = async () => {
    if (!ready.length || busy) return;
    setBusy(true);
    // Sequential: each answer un-pauses its group and ticks the scheduler, and
    // firing four of those at once against one sqlite writer buys nothing.
    for (const e of ready) await post(`/api/escalations/${e.id}/answer`, { answer: text[e.id]!.trim() });
    setBusy(false);
    refresh();
    onClose();
  };

  return (
    <Dialog.Root open onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-[var(--scrim)]" />
        <Dialog.Content
          className="fade-in fixed left-1/2 top-[8%] z-50 flex max-h-[84vh] w-[min(52rem,94vw)] -translate-x-1/2
                     flex-col overflow-hidden rounded-xl border border-rule bg-paper shadow-[0_12px_40px_var(--shade)]"
        >
          <div className="flex items-baseline gap-3 border-b border-rule px-4 py-2.5">
            <Dialog.Title className="font-display text-[1.0625rem] font-semibold">
              一起回答 {rows.length} 条
            </Dialog.Title>
            <Dialog.Description asChild>
              <Meta>已经替你各拟了一份，改完一起发。留空的那条跳过。</Meta>
            </Dialog.Description>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {rows.map((e) => (
              <div key={e.id} className="border-t border-rule-soft px-4 py-3 first:border-t-0">
                <div className="flex flex-wrap items-baseline gap-x-2 font-mono text-[0.6875rem]">
                  <span className="text-ink-2">{e.asker ?? "系统"}</span>
                  <span className="text-ink-3">{waited(e.created_at)}</span>
                  {e.severity === "blocker" && <span className="font-semibold text-bad">全组停着</span>}
                </div>
                <div className="mt-1 max-w-[72ch] text-[0.8125rem] text-ink-2">
                  <Clamp lines={4}>{nl(e.question)}</Clamp>
                </div>
                <textarea
                  rows={3}
                  value={text[e.id] ?? ""}
                  onChange={(ev) => {
                    setTouched((p) => ({ ...p, [e.id]: true }));
                    setText((p) => ({ ...p, [e.id]: ev.target.value }));
                  }}
                  placeholder="留空跳过这条"
                  className={cn(
                    "mt-2 w-full resize-y rounded-md border border-rule bg-paper px-2.5 py-1.5",
                    "text-[0.8125rem] outline-none focus-visible:border-accent",
                  )}
                />
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2 border-t border-rule px-4 py-2.5">
            <Meta>{ready.length} / {rows.length} 条会发出去</Meta>
            <span className="grow" />
            <Button size="sm" onClick={onClose}>取消</Button>
            <Button variant="go" size="sm" disabled={busy || !ready.length} onClick={() => void send()}>
              {busy ? "…" : `全部发送 ${ready.length} 条`}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
