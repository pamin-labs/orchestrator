import { useState } from "react";
import { X } from "lucide-react";
import { splitAttachments, type Attached } from "../lib/attach";
import { cn } from "../lib/utils";

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
      {text && <div className={cn("whitespace-pre-wrap break-words", className)}>{text}</div>}
      <Attachments files={files} />
    </>
  );
}

export function Attachments({ files }: { files: Attached[] }) {
  const [full, setFull] = useState<Attached | null>(null);
  if (!files.length) return null;
  const images = files.filter((f) => f.image);
  const rest = files.filter((f) => !f.image);
  return (
    <>
      {images.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {images.map((f) => (
            <button
              key={f.path}
              onClick={() => setFull(f)}
              title={f.name}
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
              {f.label ? `[${f.label}] ` : ""}{f.name}
            </a>
          ))}
        </div>
      )}
      {/* Not a dialog component: there is nothing to focus-trap and no decision to
          make, it is an image at its own size with a way out. Esc and the backdrop
          both close it. */}
      {full && (
        <div
          role="presentation"
          onClick={() => setFull(null)}
          onKeyDown={(e) => e.key === "Escape" && setFull(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/70 p-8 backdrop-blur-[2px]"
        >
          <img
            src={full.url}
            alt={full.name}
            className="max-h-full max-w-full rounded-md object-contain shadow-[0_20px_60px_var(--shade)]"
          />
          <button
            aria-label="关掉"
            onClick={() => setFull(null)}
            className="absolute right-4 top-4 grid size-8 cursor-pointer place-items-center rounded-md bg-paper/90 text-ink hover:bg-paper"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </div>
      )}
    </>
  );
}
