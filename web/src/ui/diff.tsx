import { useEffect, useMemo, useRef, useState } from "react";
import parseDiff from "parse-diff";
import { diffWordsWithSpace } from "diff";
import * as Collapsible from "@radix-ui/react-collapsible";
import { Group, Panel, Separator } from "react-resizable-panels";
import { Button } from "./button";
import { Meta } from "./bits";
import { Tip } from "./tooltip";
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

interface Dir {
  name: string;
  dirs: Map<string, Dir>;
  files: { name: string; i: number; add: number; del: number }[];
}

const emptyDir = (name: string): Dir => ({ name, dirs: new Map(), files: [] });

/**
 * The rail as a folder tree, the way a diff is normally read.
 *
 * Single-child chains are folded into one row — `docs/journal/more-menu-dead`
 * rather than three nested rows with one child each — because the intermediate
 * folders carry no choice, and a column this narrow cannot spend indentation on
 * rows that say nothing.
 */
function buildTree(files: parseDiff.File[], nameOf: (f: parseDiff.File) => string): Dir {
  const root = emptyDir("");
  files.forEach((f, i) => {
    const parts = nameOf(f).split("/");
    let at = root;
    for (const seg of parts.slice(0, -1)) {
      if (!at.dirs.has(seg)) at.dirs.set(seg, emptyDir(seg));
      at = at.dirs.get(seg)!;
    }
    at.files.push({ name: parts.at(-1)!, i, add: f.additions, del: f.deletions });
  });

  const squash = (d: Dir): Dir => {
    let cur = d;
    while (cur.files.length === 0 && cur.dirs.size === 1) {
      const only = [...cur.dirs.values()][0]!;
      cur = { ...only, name: cur.name ? `${cur.name}/${only.name}` : only.name };
    }
    return { ...cur, dirs: new Map([...cur.dirs].map(([k, v]) => [k, squash(v)])) };
  };
  return { ...root, dirs: new Map([...root.dirs].map(([k, v]) => [k, squash(v)])) };
}

/**
 * The order the rail shows, so scrolling and the rail agree.
 *
 * They did not: the rail groups by folder and the panes were rendered in `git
 * diff` order, so scrolling down went somewhere the rail could not explain and
 * the highlight jumped backwards. Same traversal as `Branch` — sub-directories
 * first, then this level's files.
 */
function flatten(d: Dir): number[] {
  return [...[...d.dirs.values()].flatMap(flatten), ...d.files.map((f) => f.i)];
}

const _base = (f: parseDiff.File) => {
  const n = f.to && f.to !== "/dev/null" ? f.to : (f.from ?? "?");
  return n.slice(n.lastIndexOf("/") + 1);
};

type Row = {
  left?: { n: number; text: string; changed?: boolean };
  right?: { n: number; text: string; changed?: boolean };
  /** Hunk boundary, rendered as a rule rather than a `@@` line. */
  gap?: string;
};

/** Pair deletions with additions inside one hunk, so the two sides line up. */
export function rowsOf(chunk: parseDiff.Chunk): Row[] {
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
    // `\ No newline at end of file` is not a line of the file, and `parse-diff`
    // does not say so: it carries the marker by cloning the change before it, so
    // it arrives with that change's `type` and its `ln`. A file without a
    // trailing newline — a `.env`, generated JSON, anything a `printf` wrote —
    // therefore produced a second del *and* a second add, equal counts, paired,
    // tinted red and green, both gutters repeating line 3, reading
    // " No newline at end of file" as if it were source. No prefixed diff line
    // can begin with a backslash, so this is the marker and nothing else.
    if (c.content.startsWith("\\ ")) continue;
    // `Change` is a discriminated union on `type`, so each branch already knows
    // its own line numbers — `del`/`add` carry `ln`, `normal` carries `ln1`/`ln2`
    // and no `ln` at all. The casts were reading fields the narrow hands over.
    if (c.type === "del") dels.push({ n: c.ln, text: c.content.slice(1) });
    else if (c.type === "add") adds.push({ n: c.ln, text: c.content.slice(1) });
    else {
      flush();
      out.push({
        left: { n: c.ln1, text: c.content.slice(1) },
        right: { n: c.ln2, text: c.content.slice(1) },
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
      <span key={i} className={cn(p[want] && (side === "left" ? "bg-bad-mark" : "bg-ok-mark"))}>
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

  const tree = useMemo(() => buildTree(files, nameOf), [files]);
  const order = useMemo(() => flatten(tree), [tree]);

  // Not scrollIntoView: it scrolls every scrollable ancestor, so clicking a file
  // also threw the whole page to a fixed position.
  const go = (i: number) => {
    const el = heads.current[i];
    if (el && pane.current) pane.current.scrollTop = el.offsetTop - pane.current.offsetTop;
  };

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
    // Resizable, because the two halves compete for the same width and which one
    // needs it depends on the diff: `docs/journal/more-menu-dead/015-decision.md`
    // wants a wide rail, a file of long lines wants none of it. This is the
    // primitive shadcn's Resizable wraps — a drag handle carries keyboard
    // resizing and aria-valuenow, which is exactly the kind of behaviour we do
    // not write ourselves.
    <Group orientation="horizontal" className="flex h-full min-h-0">
      {/* The rail is index and summary at once: what changed, by how much, and where
          you are. One file at a time was worse — a review reads a change, and a
          change spans files; making the reader click through thirty of them puts the
          work back on them. */}
      <Panel defaultSize="18rem" minSize="8rem" maxSize="50%" className="min-w-0">
        <nav className="h-full overflow-auto py-1">
          <Branch dir={tree} depth={0} here={here} go={go} />
        </nav>
      </Panel>
      <Separator className="w-px shrink-0 cursor-col-resize bg-rule transition-colors hover:bg-accent data-[state=dragging]:bg-accent" />

      <Panel className="min-w-0">
        <div ref={pane} className="h-full overflow-auto">
          {order.map((fi) => {
            const f = files[fi]!;
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
                  className="mt-2 flex items-baseline gap-2 border-y-2 border-rule bg-sunk px-3.5 py-1.5 first:mt-0"
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
                          <Gutter
                            n={r.right?.n}
                            tone={r.right && (!r.left || r.right.changed) ? "ok" : undefined}
                            split
                          />
                          <Side cell={r.right} other={r.left} side="right" />
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
                {rows.length > shown.length && (
                  <div className="border-y border-rule-soft bg-sunk px-3.5 py-1">
                    {/* The project's Button, not a hand-styled one: this is an action,
                      and every control in the page shares one shape and one set of
                      focus / hover / disabled states. The rows above are not — they
                      are a list you navigate, and dressing them as buttons would say
                      the wrong thing about what they do. */}
                    <Button variant="quiet" size="sm" onClick={() => setOpen(new Set([...open, fi]))}>
                      还有 {rows.length - shown.length} 行
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
          {truncated && (
            <Meta className="block px-3.5 py-2">改动超过 400k 字符，尾部没取回来，剩下的在沙盒的 checkout 里</Meta>
          )}
        </div>
      </Panel>
    </Group>
  );
}

function Branch({ dir, depth, here, go }: { dir: Dir; depth: number; here: number; go: (i: number) => void }) {
  return (
    <>
      {[...dir.dirs.values()].map((d) => (
        <Folder key={d.name} dir={d} depth={depth} here={here} go={go} />
      ))}
      {dir.files.map((f) => (
        <button
          key={f.i}
          onClick={() => go(f.i)}
          style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
          className={cn(
            "flex w-full cursor-pointer items-baseline gap-1.5 py-0.5 pr-2 text-left font-mono text-[0.6875rem] hover:bg-sunk",
            f.i === here && "bg-accent-soft text-accent",
          )}
        >
          <span className="min-w-0 grow truncate">{f.name}</span>
          <span className="shrink-0 text-[0.625rem]">
            <span className="text-ok">+{f.add}</span> <span className="text-bad">−{f.del}</span>
          </span>
        </button>
      ))}
    </>
  );
}

/** Radix, not a hand-rolled toggle: keyboard and aria-expanded come with it. */
function Folder({ dir, depth, here, go }: { dir: Dir; depth: number; here: number; go: (i: number) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger
        style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
        className="flex w-full cursor-pointer items-baseline gap-1 py-0.5 pr-2 text-left font-mono text-[0.625rem] text-ink-3 hover:text-accent"
      >
        <span className="w-2 shrink-0">{open ? "▾" : "▸"}</span>
        <Tip label={dir.name}>
          <span className="min-w-0 truncate">{dir.name}</span>
        </Tip>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <Branch dir={dir} depth={depth + 1} here={here} go={go} />
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

function Gutter({ n, tone, split }: { n?: number; tone?: "ok" | "bad"; split?: boolean }) {
  return (
    <td
      className={cn(
        "select-none border-r border-rule-soft px-1.5 text-right align-top text-[0.625rem] text-ink-3 tabular-nums",
        // The two sides had no edge between them, so a wash on one and paper on
        // the other read as one column with an odd background.
        split && "border-l-2 border-l-rule",
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
