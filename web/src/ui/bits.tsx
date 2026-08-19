import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./button";
import { cn } from "./cn";

/**
 * Section label.
 *
 * Was 10px, uppercase, tracked out to 0.13em. Uppercase buys contrast in Latin and
 * nothing at all in Chinese, where it only widens the tracking of characters that
 * were already too small to read. 12px, normal case, ink-2.
 */
export const H2 = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <h2 className={cn("mb-2.5 text-[0.75rem] font-semibold tracking-[0.02em] text-ink-2", className)}>{children}</h2>
);

/**
 * A section's title band: what it is, one line of what it does, and whatever acts
 * on it pushed to the right.
 *
 * Lifted out of 工位墙 and 所有权, which both had it inline. A heading with a count
 * beside it and a control at the far end is the shape every pane here wants, and
 * three hand-written copies of it drift.
 */
export const Head = ({
  title,
  note,
  children,
}: {
  title: React.ReactNode;
  note?: React.ReactNode;
  children?: React.ReactNode;
}) => (
  <div className="mb-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
    <H2 className="mb-0">{title}</H2>
    {note && <Meta>{note}</Meta>}
    <span className="grow" />
    {children}
  </div>
);

export const Meta = ({ children, className, ...rest }: React.HTMLAttributes<HTMLSpanElement>) => (
  <span className={cn("font-mono text-[0.6875rem] text-ink-3", className)} {...rest}>
    {children}
  </span>
);

/** Absence, with a reason. An empty panel that only says "none" teaches nothing. */
export const Empty = ({ children }: { children: React.ReactNode }) => (
  <div className="max-w-[44rem] text-[0.75rem] leading-relaxed text-ink-3">{children}</div>
);

/** Work in flight with nothing for the boss to do yet. */
export const Working = ({ children }: { children: React.ReactNode }) => (
  <div className="flex items-center gap-2 py-3 text-[0.8125rem] text-ink-2">
    <i className="breathe size-1.5 rounded-full bg-ink-3" />
    {children}
  </div>
);

const field =
  "w-full rounded-md border border-rule bg-paper text-ink placeholder:text-ink-3 " +
  "transition-colors duration-150 focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent-soft";

export const Input = ({ className, ...rest }: React.InputHTMLAttributes<HTMLInputElement>) => (
  <input className={cn(field, "px-2 py-1 text-[0.8125rem]", className)} {...rest} />
);

export const Textarea = ({
  className,
  ref,
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: React.Ref<HTMLTextAreaElement> }) => (
  <textarea
    ref={ref}
    className={cn(field, "resize-y px-2 py-1 font-mono text-[0.75rem] leading-relaxed", className)}
    {...rest}
  />
);

/**
 * A list that fills what is left of the screen and scrolls inside itself.
 *
 * The page height is fixed in the shell, so a view that simply grows pushes its
 * own controls — the tab strip, the verdict line, the totals — off the top the
 * moment there are twenty rows. Anything that can be long goes in one of these
 * and the things you steer with stay put. 13rem is header, nav, and one block of
 * page-level facts.
 */
export const Pane = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <div className={cn("min-h-0 flex-1 overflow-y-auto pr-1", className)}>{children}</div>
);

/**
 * Long prose, cut to a few lines until asked for the rest.
 *
 * Everything an agent writes to the boss is a paragraph: a QA verdict names every
 * file it checked, a watchdog escalation quotes three verbatim. The decision is
 * usually made by line three and the rest is there to check the reasoning against.
 *
 * The toggle appears only when the text is actually longer than the clamp, or every
 * two-word question grows a 展开 that does nothing.
 */
export function Clamp({ lines = 2, children }: { lines?: number; children: React.ReactNode }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (el && !open) setOver(el.scrollHeight > el.clientHeight + 2);
  }, [children, lines, open]);
  return (
    <>
      <div
        ref={box}
        className={open ? undefined : "overflow-hidden [display:-webkit-box] [-webkit-box-orient:vertical]"}
        style={open ? undefined : { WebkitLineClamp: lines }}
      >
        {children}
      </div>
      {(over || open) && (
        <Button variant="quiet" size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? t("ui.bits.collapse", "收起") : t("ui.bits.expand", "展开")}
        </Button>
      )}
    </>
  );
}

/**
 * Somebody is writing a reply, on the side the reply will land on.
 *
 * A wait is worth animating exactly once on this page: when the thing being
 * waited for is a sentence somebody (or something) is composing right now. It
 * reads as a chat bubble because that is what it is — a message that has not
 * arrived. Opacity only, like `breathe`; nothing here moves the layout.
 */
export const Typing = ({ label }: { label: string }) => (
  <div className="my-2 ml-auto flex w-fit items-center gap-2 rounded-2xl rounded-tr-sm border border-dashed border-rule bg-paper px-3.5 py-2.5">
    <Meta>{label}</Meta>
    <span className="typing flex gap-1">
      <span className="size-1.5 rounded-full bg-ink-3" />
      <span className="size-1.5 rounded-full bg-ink-3" />
      <span className="size-1.5 rounded-full bg-ink-3" />
    </span>
  </div>
);
