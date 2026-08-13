import { useEffect, useMemo, useRef, useState } from "react";
import parseDiff from "parse-diff";
import { diffWordsWithSpace } from "diff";
import { Meta } from "./bits";
import { cn } from "../lib/utils";

/**
 * The diff, as the one thing the boss actually reads before accepting.
 *
 * It used to be the raw unified diff in one `<pre>`: `diff --git` and `index`
 * lines rendered as grey noise, every changed line coloured red or green as
 * *text*, no line numbers, no file boundaries, cut at 120 lines wherever that
 * landed. Reading it was work — which is the failure mode PRODUCT.md names,
 * because accepting is one of the three things the boss is here to do.
 *
 * Four decisions, each aimed at one reason it was tiring:
 *
 * 1. **Side by side.** Old on the left, new on the right, aligned. A unified diff
 *    makes the reader reconstruct the pairing themselves; that reconstruction is
 *    the tiring part, and it is arithmetic a computer should do.
 * 2. **Tint the row, not the ink.** Coloured body text on paper is hard to read
 *    for more than a few lines. The row gets a wash and the code stays in normal
 *    ink, so + and − are legible at a glance and still readable close up.
 * 3. **Word-level marks.** A one-character change used to look like a whole line
 *    rewritten. The changed span inside a paired line is marked; everything else
 *    stays quiet.
 * 4. **Line numbers on both sides, and a file list.** QA's verdict says
 *    `requirement.tsx:177`, and there was no way to find line 177.
 *
 * Parsing is `parse-diff` and the intra-line pass is `diff` — both are small,
 * dependency-free and battle-tested. What is deliberately NOT a library is the
 * rendering: diff2html and friends bring their own stylesheet and a syntax
 * highlighter, and this page has its own design language and fetches nothing at
 * runtime (test/smoke.test.ts enforces that).
 *
 * ponytail: no syntax highlighting. It is a whole tokenizer or a big dependency,
 * and the thing being read is a change, not a program. Add it if reading the
 * change turns out to need the language.
 */

type Row = {
  left?: { n: number; text: string; changed?: boolean };
  right?: { n: number; text: string; changed?: boolean };
  /** Hunk boundary, rendered as a rule rather than a `@@` line. */
  gap?: string;
};

/** Pair deletions with additions inside one hunk, so the two sides line up. */
function rowsOf(chunk: parseDiff.Chunk): Row[] {
  const out: Row[] = [];
  let dels: { n: number; text: string }[] = [];
  let adds: { n: number; text: string }[] = [];

  const flush = () => {
    // Same count on both sides means this was an edit, not a delete and an
    // unrelated insert: pair them up and mark the words that moved.
    const paired = dels.length === adds.length;
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      const l = dels[i];
      const r = adds[i];
      out.push({
        left: l && { ...l, changed: paired },
        right: r && { ...r, changed: paired },
      });
    }
    dels = [];
    adds = [];
  };

  for (const c of chunk.changes) {
    if (c.type === "del") dels.push({ n: (c as any).ln, text: c.content.slice(1) });
    else if (c.type === "add") adds.push({ n: (c as any).ln, text: c.content.slice(1) });
    else {
      flush();
      const ln1 = (c as any).ln1 ?? (c as any).ln;
      const ln2 = (c as any).ln2 ?? (c as any).ln;
      out.push({
        left: { n: ln1, text: c.content.slice(1) },
        right: { n: ln2, text: c.content.slice(1) },
      });
    }
  }
  flush();
  return out;
}

/** The changed spans of a paired line. Whitespace is kept: indentation is meaning. */
function marks(a: string, b: string, side: "left" | "right") {
  const parts = diffWordsWithSpace(a, b);
  const want = side === "left" ? "removed" : "added";
  return parts
    .filter((p) => (want === "removed" ? !p.added : !p.removed))
    .map((p, i) => (
      <span key={i} className={cn((p as any)[want] && (side === "left" ? "bg-bad-mark" : "bg-ok-mark"))}>
        {p.value}
      </span>
    ));
}

export function DiffView({ diff, truncated }: { diff: string; truncated?: boolean }) {
  const files = useMemo(() => parseDiff(diff), [diff]);
  const nameOf = (f: parseDiff.File) => (f.to && f.to !== "/dev/null" ? f.to : (f.from ?? "?"));
  const [here, setHere] = useState(0);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const pane = useRef<HTMLDivElement>(null);
  const heads = useRef<(HTMLDivElement | null)[]>([]);

  // Which file the reader is in, from what is actually at the top of the pane.
  // Scrolling IS the navigation here; the rail follows it rather than replacing it.
  useEffect(() => {
    const root = pane.current;
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setHere(Number((e.target as HTMLElement).dataset.i));
        }
      },
      { root, rootMargin: "0px 0px -85% 0px" },
    );
    for (const h of heads.current) if (h) io.observe(h);
    return () => io.disconnect();
  }, [files]);

  if (files.length === 0) return null;

  return (
    <div className="flex h-full min-h-0">
      {/* The rail is index and summary at once: what changed, by how much, and where
          you are. One file at a time was worse — a review reads a change, and a
          change spans files; making the reader click through thirty of them puts the
          work back on them. */}
      <nav className="w-56 shrink-0 overflow-auto border-r border-rule-soft py-1">
        {files.map((x, i) => {
          const n = nameOf(x);
          const cut = n.lastIndexOf("/");
          return (
            <button
              key={n}
              onClick={() => heads.current[i]?.scrollIntoView({ block: "start" })}
              className={cn(
                "flex w-full cursor-pointer flex-col items-start gap-px px-2.5 py-1 text-left font-mono text-[0.6875rem] hover:bg-sunk",
                i === here && "bg-accent-soft text-accent",
              )}
            >
              <span className="w-full truncate">{n.slice(cut + 1)}</span>
              <span className="flex w-full items-baseline gap-1.5">
                {cut > 0 && <span className="min-w-0 truncate text-[0.625rem] text-ink-3">{n.slice(0, cut)}</span>}
                <span className="ml-auto shrink-0 text-[0.625rem]">
                  <span className="text-ok">+{x.additions}</span> <span className="text-bad">−{x.deletions}</span>
                </span>
              </span>
            </button>
          );
        })}
      </nav>

      <div ref={pane} className="min-w-0 grow overflow-auto">
        {files.map((f, fi) => {
          const name = nameOf(f);
          const rows = f.chunks.flatMap((c) => [{ gap: c.content } as Row, ...rowsOf(c)]);
          // Bounded per file, not per diff: thirty files of four hundred rows each
          // is a DOM nobody scrolls, and the long file is usually not the one being
          // reviewed. Opening one is a click, and it stays open.
          const shown = open.has(fi) ? rows : rows.slice(0, 400);
          return (
            <div key={name}>
              <div
                ref={(el) => {
                  heads.current[fi] = el;
                }}
                data-i={fi}
                className="sticky top-0 z-10 flex items-baseline gap-2 border-y border-rule-soft bg-sunk px-3.5 py-1"
              >
                <span className="font-mono text-[0.6875rem] font-semibold">{name}</span>
                <span className="font-mono text-[0.625rem]">
                  <span className="text-ok">+{f.additions}</span> <span className="text-bad">−{f.deletions}</span>
                </span>
              </div>
              <table className="w-full table-fixed border-collapse font-mono text-[0.6875rem] leading-[1.55]">
                <colgroup>
                  <col className="w-10" />
                  <col className="w-[calc(50%-2.5rem)]" />
                  <col className="w-10" />
                  <col />
                </colgroup>
                <tbody>
                  {shown.map((r, i) =>
                    r.gap !== undefined ? (
                      <tr key={i}>
                        <td colSpan={4} className="border-y border-rule-soft bg-sunk px-3.5 py-0.5 text-ink-3">
                          {/* The useful half of `@@ -1,7 +1,9 @@` is the context after it. */}
                          {r.gap.replace(/^@@[^@]*@@\s*/, "") || "…"}
                        </td>
                      </tr>
                    ) : (
                      <tr key={i}>
                        <Gutter n={r.left?.n} tone={r.left && (!r.right || r.left.changed) ? "bad" : undefined} />
                        <Side cell={r.left} other={r.right} side="left" />
                        <Gutter n={r.right?.n} tone={r.right && (!r.left || r.right.changed) ? "ok" : undefined} />
                        <Side cell={r.right} other={r.left} side="right" />
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
              {rows.length > shown.length && (
                <button
                  className="w-full cursor-pointer border-y border-rule-soft bg-sunk py-1 text-[0.6875rem] text-ink-2 hover:text-accent"
                  onClick={() => setOpen(new Set([...open, fi]))}
                >
                  还有 {rows.length - shown.length} 行
                </button>
              )}
            </div>
          );
        })}
        {truncated && (
          <Meta className="block px-3.5 py-2">这一片的改动超过 400k 字符，尾部没取回来 —— 剩下的在 worktree 里</Meta>
        )}
      </div>
    </div>
  );
}

function Gutter({ n, tone }: { n?: number; tone?: "ok" | "bad" }) {
  return (
    <td
      className={cn(
        "select-none border-r border-rule-soft px-1.5 text-right align-top text-[0.625rem] text-ink-3 tabular-nums",
        tone === "ok" && "bg-ok-soft",
        tone === "bad" && "bg-bad-soft",
      )}
    >
      {n ?? ""}
    </td>
  );
}

function Side({
  cell,
  other,
  side,
}: {
  cell?: { n: number; text: string; changed?: boolean };
  other?: { n: number; text: string };
  side: "left" | "right";
}) {
  const tone = !cell ? "empty" : !other ? side : cell.changed ? side : "same";
  return (
    <td
      className={cn(
        "whitespace-pre-wrap break-words px-2 align-top",
        tone === "empty" && "bg-sunk",
        tone === "left" && "bg-bad-soft",
        tone === "right" && "bg-ok-soft",
      )}
    >
      {cell ? (cell.changed && other ? marks(cell.text, other.text, side) : cell.text || " ") : ""}
    </td>
  );
}
