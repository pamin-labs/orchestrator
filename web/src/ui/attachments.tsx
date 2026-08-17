import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { Tip } from "./tooltip";
import { splitAttachments, type Attached } from "./attach";
import { nl } from "../shared/prose";
import { cn } from "./cn";

/**
 * A message, and the files that came with it.
 *
 * Screenshots are how the boss says most of what they say — a bug is a picture
 * far more often than a paragraph — and they were rendering as
 * `- /Users/…/1755-0-Screenshot.png (image)` under the words they belonged to.
 *
 * Laid out as a row of tiles rather than full-width images: an attachment is
 * evidence beside the text, not the subject of the page, and one 3000px-wide
 * screenshot at full width pushes the question that came with it off the screen.
 * Uniform height, natural width, wrapping — so three narrow crops and one wide
 * one still read as one row of four things. Click opens the full size; that is
 * the whole viewer, because the browser already has one.
 */
export function WithAttachments({ body, className }: { body: string; className?: string }) {
  const { text, files } = splitAttachments(body);
  return (
    <>
      {text && <div className={cn("whitespace-pre-wrap break-words", className)}>{nl(text)}</div>}
      <Attachments files={files} />
    </>
  );
}

function Attachments({ files }: { files: Attached[] }) {
  const [full, setFull] = useState<Attached | null>(null);
  if (!files.length) return null;
  const images = files.filter((f) => f.image);
  const rest = files.filter((f) => !f.image);
  return (
    <>
      {images.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {images.map((f) => (
            <Tip key={f.path} label={f.name}>
              <button
                type="button"
                onClick={() => setFull(f)}
                className={cn(
                  "relative block h-24 cursor-zoom-in overflow-hidden rounded-md border border-rule bg-sunk",
                  "transition-colors hover:border-accent",
                )}
              >
                <img src={f.url} alt={f.name} className="h-full w-auto max-w-[22rem] object-cover" loading="lazy" />
                {/* The same marker the text uses. Three screenshots and a sentence
                  about 「第二张」 is a puzzle without it. */}
                {f.label && (
                  <span className="absolute left-1 top-1 rounded-sm bg-ink/75 px-1 font-mono text-[0.625rem] text-paper">
                    {f.label}
                  </span>
                )}
              </button>
            </Tip>
          ))}
        </div>
      )}
      {rest.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
          {rest.map((f) => (
            <a
              key={f.path}
              href={f.url}
              target="_blank"
              rel="noreferrer"
              className="truncate font-mono text-[0.6875rem] text-ink-3 underline decoration-dotted hover:text-accent"
            >
              {f.label ? `[${f.label}] ` : ""}
              {f.name}
            </a>
          ))}
        </div>
      )}
      {/* This used to argue it was not a dialog — "nothing to focus-trap and no
          decision to make" — and claimed Esc closed it. Esc did nothing: the
          handler sat on a `role="presentation"` div with no `tabIndex`, and focus
          stayed on the thumbnail button, which is this overlay's *sibling*, so
          the event never reached it. The way out was the mouse, on a page whose
          own composer is driven from the keyboard. 硬约束 4: Radix owns Esc, the
          focus trap, the return of focus to the thumbnail, and the scroll lock. */}
      <Dialog.Root open={!!full} onOpenChange={(o) => !o && setFull(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/70 backdrop-blur-[2px]" />
          <Dialog.Content
            onClick={() => setFull(null)}
            className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center p-8 focus:outline-none"
          >
            {/* The file's own name is the title. It is the only thing here a
                screen reader could announce, and hiding it visually keeps the
                image at its own size, which is the whole point of the view. */}
            <Dialog.Title className="sr-only">{full?.name}</Dialog.Title>
            {full && (
              <img
                src={full.url}
                alt={full.name}
                className="max-h-full max-w-full rounded-md object-contain shadow-[0_20px_60px_var(--shade)]"
              />
            )}
            <Dialog.Close
              aria-label="关掉"
              className="absolute right-4 top-4 grid size-8 cursor-pointer place-items-center rounded-md bg-paper/90 text-ink hover:bg-paper"
            >
              <X size={16} strokeWidth={2} />
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
