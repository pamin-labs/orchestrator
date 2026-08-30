import { useCallback, useMemo, useRef, useState } from "react";
import parseDiff from "parse-diff";
import * as Collapsible from "@radix-ui/react-collapsible";
import { Group, Panel, Separator } from "react-resizable-panels";
import { Button } from "../../ui/button";
import { Meta } from "../../ui/bits";
import { Tip } from "../../ui/tooltip";
import { type Cell, markSpans, type SideName, sideTone, type Tone } from "./model";
import { cn } from "../../ui/cn";
import { type ListHandle, VirtualList } from "../../ui/virtual-list";
import { Trans } from "@lingui/react/macro";

/**
 * The diff, as the one thing the boss actually reads before accepting.
 *
 * Parsing is `parse-diff` with an intra-line pass by `diff`; the rendering is
 * ours. Which four decisions that rendering makes, and why a diff viewer was
 * refused, is ADR 033 — including the syntax highlighting that is deliberately
 * absent and what would reopen it.
 */

interface Dir {
  name: string;
  dirs: Map<string, Dir>;
  files: { name: string; i: number; add: number; del: number }[];
}

const emptyDir = (name: string): Dir => ({ name, dirs: new Map(), files: [] });

/** A rename shows its new path; a deletion falls back to the one it had. */
const nameOf = (f: parseDiff.File) => (f.to && f.to !== "/dev/null" ? f.to : (f.from ?? "?"));

/**
 * The rail as a folder tree, the way a diff is normally read.
 *
 * Single-child chains are folded into one row — `docs/journal/more-menu-dead`
 * rather than three nested rows with one child each — because the intermediate
 * folders carry no choice, and a column this narrow cannot spend indentation on
 * rows that say nothing.
 */
function buildTree(files: parseDiff.File[]): Dir {
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

export type Row = {
  left?: Cell;
  right?: Cell;
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
        ...(l ? { left: { ...l, changed: paired } } : {}),
        ...(r ? { right: { ...r, changed: paired } } : {}),
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
function marks(text: string, other: string, side: SideName) {
  const mark = side === "left" ? "bg-bad-mark" : "bg-ok-mark";
  return markSpans(text, other, side).map((span) => (
    <span key={span.key} className={cn(span.marked && mark)}>
      {span.text}
    </span>
  ));
}

/** A hunk boundary reads as its context line, or as an ellipsis when there is none. */
export function gapLabel(gap: string): string {
  return gap.replace(/^@@[^@]*@@\s*/, "") || "…";
}

/** The changed-or-orphaned tone a gutter earns on its own side. */
function gutterTone(row: Row, side: "left" | "right"): "bad" | "ok" | undefined {
  const cell = side === "left" ? row.left : row.right;
  const other = side === "left" ? row.right : row.left;
  return cell && (!other || cell.changed) ? (side === "left" ? "bad" : "ok") : undefined;
}

export function gutterProps(row: Row, side: "left" | "right"): { n?: number; tone?: "bad" | "ok" } {
  const cell = side === "left" ? row.left : row.right;
  const tone = gutterTone(row, side);
  return { ...(cell ? { n: cell.n } : {}), ...(tone ? { tone } : {}) };
}

export function sideProps(
  row: Row,
  side: "left" | "right",
): {
  cell?: NonNullable<Row["left"]>;
  other?: NonNullable<Row["left"]>;
} {
  const cell = side === "left" ? row.left : row.right;
  const other = side === "left" ? row.right : row.left;
  return { ...(cell ? { cell } : {}), ...(other ? { other } : {}) };
}

function DiffRow({ row }: { row: Row }) {
  if (row.gap !== undefined) {
    return (
      <tr>
        <td colSpan={4} className="border-y border-rule-soft bg-sunk px-3.5 py-0.5 text-ink-3">
          {gapLabel(row.gap)}
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <Gutter {...gutterProps(row, "left")} />
      <Side {...sideProps(row, "left")} side="left" />
      <Gutter {...gutterProps(row, "right")} split />
      <Side {...sideProps(row, "right")} side="right" />
    </tr>
  );
}

/**
 * How many rows one file draws before it asks.
 *
 * Left at 400 deliberately. Measured over 24 merges and 1,483 changed files:
 * median 63 rows, p75 154, p90 345, and 8.8% over 400. Lowering it to 120 —
 * which is what "the cheap half of windowing" looked like before it was measured
 * — puts **30.7%** of every review behind a button to save a render that happens
 * once. The mounted total was never the cap's fault; it was that every file was
 * mounted.
 */
const CAP = 400;

/** The rows one file draws, hunk gaps included. */
const rowsIn = (file: parseDiff.File): Row[] =>
  file.chunks.flatMap((chunk): Row[] => [{ gap: chunk.content }, ...rowsOf(chunk)]);

/**
 * How tall a file will be, before one is drawn.
 *
 * `leading-[1.55]` over `--text-meta: 0.6875rem` is a 17px row; the header and
 * the "more lines" button are the rest. A single number for every file would be
 * wrong by two orders of magnitude at both ends of this list, and the scrollbar
 * would jump as each one measured.
 */
/**
 * Computed once for the whole diff rather than inside `estimateSize`, which is
 * asked per index and asks again as rows measure. Pairing a file's rows is real
 * work — it was being done twice per call, for every file, on every pass.
 */
const heightsOf = (files: parseDiff.File[]): number[] =>
  files.map((file) => {
    const count = rowsIn(file).length;
    return HEAD_PX + Math.min(count, CAP) * ROW_PX + (count > CAP ? MORE_PX : 0);
  });

const ROW_PX = 17;
const HEAD_PX = 34;
const MORE_PX = 32;

function DiffFile({ file, expanded, onExpand }: { file: parseDiff.File; expanded: boolean; onExpand: () => void }) {
  const name = nameOf(file);
  const rows = rowsIn(file);
  const shown = expanded ? rows : rows.slice(0, CAP);
  const hiddenLines = rows.length - shown.length;
  return (
    <div>
      <div className="mt-2 flex items-baseline gap-2 border-y-2 border-rule bg-sunk px-3.5 py-1.5 first:mt-0">
        <span className="font-mono text-meta font-semibold">{name}</span>
        <span className="font-mono text-pill">
          <span className="text-ok">+{file.additions}</span> <span className="text-bad">−{file.deletions}</span>
        </span>
      </div>
      <table className="w-full table-fixed border-collapse font-mono text-meta leading-[1.55]">
        <colgroup>
          <col className="w-10" />
          <col className="w-[calc(50%-2.5rem)]" />
          <col className="w-10" />
          <col />
        </colgroup>
        <tbody>
          {shown.map((row) => (
            <DiffRow key={row.gap ?? `${row.left?.n ?? ""}:${row.right?.n ?? ""}`} row={row} />
          ))}
        </tbody>
      </table>
      {rows.length > shown.length && (
        <div className="border-y border-rule-soft bg-sunk px-3.5 py-1">
          <Button variant="quiet" size="sm" onClick={onExpand}>
            <Trans>{hiddenLines} more lines</Trans>
          </Button>
        </div>
      )}
    </div>
  );
}

export function DiffView({ diff, truncated }: { diff: string; truncated?: boolean }) {
  const files = useMemo(() => parseDiff(diff), [diff]);
  const [here, setHere] = useState(0);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const list = useRef<ListHandle>(null);

  const tree = useMemo(() => buildTree(files), [files]);
  const order = useMemo(() => flatten(tree), [tree]);
  const heights = useMemo(() => heightsOf(files), [files]);

  // Not scrollIntoView: it scrolls every scrollable ancestor, so clicking a file
  // also threw the whole page to a fixed position. The list is windowed, so the
  // target may not be mounted to measure an offset against either — it is asked
  // by position in the order the rail shows, which is the order the list holds.
  const go = (i: number) => list.current?.scrollTo(order.indexOf(i));

  // Which file the reader is in, from what is at the top of the pane. Scrolling
  // IS the navigation here; the rail follows it rather than replacing it.
  //
  // This was an IntersectionObserver over every file's header. It could not
  // survive windowing — an unmounted file has no header to observe — and it does
  // not have to: a windowed list already knows its first visible item, which is
  // the same question asked one layer down.
  const onTop = useCallback((at: number) => setHere(order[at] ?? 0), [order]);

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
        <div className="flex h-full min-h-0 flex-col">
          <VirtualList
            items={order}
            estimate={(index) => heights[index] ?? HEAD_PX}
            keyOf={(index) => nameOf(files[index]!)}
            handle={list}
            onTop={onTop}
            className="min-h-0 flex-1"
          >
            {(index) => (
              <DiffFile
                file={files[index]!}
                expanded={open.has(index)}
                onExpand={() => setOpen(new Set([...open, index]))}
              />
            )}
          </VirtualList>
          {/* Below the list rather than after the last file: the list owns the
              scroller now, and a warning that the diff is incomplete is worth
              more where it cannot be scrolled past. */}
          {truncated && (
            <Meta className="block shrink-0 px-3.5 py-2">
              <Trans>
                Changes exceed 400k characters; tail not retrieved. Remaining changes are in the sandbox checkout.
              </Trans>
            </Meta>
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
          type="button"
          key={f.i}
          onClick={() => go(f.i)}
          style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
          className={cn(
            "flex w-full cursor-pointer items-baseline gap-1.5 py-0.5 pr-2 text-left font-mono text-meta hover:bg-sunk",
            f.i === here && "bg-accent-soft text-accent",
          )}
        >
          <span className="min-w-0 grow truncate">{f.name}</span>
          <span className="shrink-0 text-pill">
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
        className="flex w-full cursor-pointer items-baseline gap-1 py-0.5 pr-2 text-left font-mono text-pill text-ink-3 hover:text-accent"
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
        "select-none border-r border-rule-soft px-1.5 text-right align-top text-pill text-ink-3 tabular-nums",
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

const WASH: Record<Tone, string> = { empty: "bg-sunk", left: "bg-bad-soft", right: "bg-ok-soft", same: "" };

function Side({ cell, other, side }: { cell?: Cell; other?: Cell; side: SideName }) {
  return (
    <td className={cn("whitespace-pre-wrap break-words px-2 align-top", WASH[sideTone(side, cell, other)])}>
      {cell && (cell.changed && other ? marks(cell.text, other.text, side) : cell.text || " ")}
    </td>
  );
}
