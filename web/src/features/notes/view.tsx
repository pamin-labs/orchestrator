import { useEffect, useRef, useState } from "react";
import { Meta, Pane } from "../../ui/bits";
import { Badge } from "../../ui/badge";
import { Tip } from "../../ui/tooltip";
import { Button } from "../../ui/button";
import { Tab, TabList, TabPanel, Tabs } from "../../ui/tabs";
import { api, readApi } from "../../shared/api";
import { usePaged } from "../../shared/page";
import { clock } from "../../shared/format";
import { cn } from "../../ui/cn";
import { WithAttachments } from "../../ui/attachments";
import { z } from "zod";
import { jsonOr } from "../../../../src/contracts/json.ts";
import { NotesResponseSchema, type PanelNote as Note } from "../../../../src/contracts/panel";

/**
 * The blackboard's static half.
 *
 * docs/project/plan.md §7: the journal is where "做了啥 + 为啥 + 风险" lives, the retro is the only
 * thing a dissolved group leaves behind, and the lesson list is the single mechanism
 * by which the twentieth group is smarter than the first. All of it was written,
 * exported to the repo, injected into prompts — and unreadable from the panel, which
 * made the system's memory something only the agents could see.
 *
 * Newest first, ≤6 lines each by construction (`orch journal add` refuses more), so
 * the whole body is shown rather than truncated: a 6-line note with a "more" link
 * would be a click to see two extra lines.
 */
const KINDS: [string, string][] = [
  ["journal", "日志"],
  ["decision", "决策"],
  ["retro", "复盘"],
  ["lesson", "教训"],
  ["onboarding", "入职包"],
  ["risk", "风险"],
  ["fact", "老板说的"],
];

const ZH = new Map(KINDS.map(([k, zh]) => [k, zh]));
const FrontmatterSchema = z.object({
  files: z.array(z.string()).optional(),
  gate: z.string().nullable().optional(),
});
const GATES: Record<string, { text: string; className?: string }> = {
  pass: { text: "过", className: "text-ok" },
  fail: { text: "没过", className: "text-bad" },
};

function Evidence({ note, gate, files }: { note: Note; gate: string | null; files: string[] }) {
  if (![gate, note.exportPath, ...files].some(Boolean)) return null;
  const verdict = gate ? (GATES[gate] ?? { text: gate }) : null;
  return (
    <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3">
      {verdict && <Meta className={verdict.className}>闸门 {verdict.text}</Meta>}
      {files.map((file) => (
        <Tip key={file} label={file}>
          <Meta className="min-w-0 truncate font-mono">{file}</Meta>
        </Tip>
      ))}
      {note.exportPath && (
        <Tip label={note.exportPath}>
          <Meta className="cursor-default underline decoration-dotted">md</Meta>
        </Tip>
      )}
    </div>
  );
}

export function Notes({
  projectId,
  grpId,
  compact,
  tab,
  onTab,
  onCount,
}: {
  projectId?: number;
  grpId?: number;
  compact?: boolean;
  /** From the hash where this is a whole view; local where it is embedded. */
  tab?: string | null;
  onTab?: (t: string) => void;
  /** How many were found, for a tab label that cannot fetch them itself. */
  onCount?: (n: number) => void;
}) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const onCountRef = useRef(onCount);

  useEffect(() => {
    onCountRef.current = onCount;
  }, [onCount]);

  useEffect(() => {
    setNotes(null);
    const query = grpId ? { group: String(grpId) } : projectId ? { project: String(projectId) } : {};
    void readApi(api.notes.$get({ query }), NotesResponseSchema).then((r) => {
      const found = r?.notes ?? [];
      setNotes(found);
      onCountRef.current?.(found.length);
    });
  }, [grpId, projectId]);

  return (
    <NotesBoard
      notes={notes}
      {...(compact !== undefined ? { compact } : {})}
      {...(tab !== undefined ? { tab } : {})}
      {...(onTab ? { onTab } : {})}
    />
  );
}

/** The blackboard once the read has landed. Split from the fetch above so every
 *  state it can be in — nothing yet, nothing at all, one requirement's mixed
 *  list, the full tabbed board — is reachable without a server. */
export function NotesBoard({
  notes,
  compact,
  tab,
  onTab,
}: {
  notes: Note[] | null;
  compact?: boolean;
  tab?: string | null;
  onTab?: (t: string) => void;
}) {
  if (!notes) return <Meta>读记录…</Meta>;
  if (!notes.length) {
    return (
      <div className="text-[0.8125rem] text-ink-3">
        还没有记录。agent 每个 turn 写 journal，组解散前写 retro，retro 归纳成教训注入后续组。
      </div>
    );
  }

  // Inside one requirement the list is short and mixed — kinds as tabs there would be
  // four tabs with one row each.
  if (compact) return <List notes={notes} size={8} showKind />;

  const present = KINDS.filter(([k]) => notes.some((n) => n.kind === k));
  return (
    <Tabs
      value={tab ?? present[0]?.[0] ?? "journal"}
      {...(onTab ? { onValueChange: onTab } : {})}
      className="flex min-h-0 flex-1 flex-col"
    >
      <TabList>
        {present.map(([k, zh]) => (
          <Tab key={k} value={k} count={notes.filter((n) => n.kind === k).length}>
            {zh}
          </Tab>
        ))}
      </TabList>
      {/* No hint line under the strip. 「每个 turn 的产出：做了啥、为什么、风险。硬性
          ≤6 行」 sat above the journals themselves, which say all of that by being
          journals — and it cost a row of height on every tab, every visit. */}
      {present.map(([k]) => (
        <TabPanel key={k} value={k} className="flex min-h-0 flex-1 flex-col">
          <Pane>
            <List notes={notes.filter((n) => n.kind === k)} size={12} />
          </Pane>
        </TabPanel>
      ))}
    </Tabs>
  );
}

function List({ notes, size, showKind }: { notes: Note[]; size: number; showKind?: boolean }) {
  const { page, rest, more, total } = usePaged(notes, size);
  return (
    <>
      {page.map((n) => (
        <Row key={n.id} n={n} {...(showKind !== undefined ? { showKind } : {})} />
      ))}
      {rest > 0 && (
        <Button variant="quiet" size="sm" className="mt-2" onClick={more}>
          还有 {rest} 条（共 {total}）
        </Button>
      )}
    </>
  );
}

function Row({ n, showKind }: { n: Note; showKind?: boolean }) {
  // frontmatter is structured on purpose: files and the gate verdict are the
  // deterministic anchors that stop a journal being self-congratulation.
  const frontmatter = jsonOr(n.frontmatter, FrontmatterSchema, {});
  const files = frontmatter.files?.slice(0, 4) ?? [];
  const gate = frontmatter.gate ?? null;

  return (
    // Two columns, because there are two things here and they were on one line.
    // When it happened and which requirement it belongs to is what you scan; the
    // note is what you read. Interleaved — badge, name, clock, gate, files, md,
    // all at 0.6875rem — the eye had no column to run down, so twenty journals
    // read as one wall with rules through it.
    <div
      className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-x-5 border-t border-rule-soft py-3 first:border-t-0
                 max-[52rem]:grid-cols-1 max-[52rem]:gap-y-1"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2">
          {showKind && <Badge>{ZH.get(n.kind) ?? n.kind}</Badge>}
          <Meta>{clock(n.at)}</Meta>
        </div>
        {n.group && (
          <Tip label={n.group}>
            <div className="truncate text-[0.75rem] text-ink-2">{n.group}</div>
          </Tip>
        )}
      </div>
      <div className="min-w-0">
        <Body text={n.body} />
        {/* The deterministic anchors, under the prose they are meant to check: the
            files it touched and the gate's verdict are what stop a journal being
            self-congratulation. The export path was the widest thing on the old
            header — 60 characters of docs/journal/<一个很长的中文需求名>/020-journal.md
            saying less than the requirement name inside it. It is a hover. */}
        <Evidence note={n} gate={gate} files={files} />
      </div>
    </div>
  );
}

/**
 * A note's text, clamped until asked.
 *
 * Journals are capped at six lines by the validator, but a retro or a boss
 * remark is not, and one long entry pushed every other entry off the screen —
 * turning a list you scan into a document you scroll. Four lines is enough to
 * know whether this is the one, and the rest is one click away.
 */
function Body({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.split("\n").length > 4 || text.length > 320;
  return (
    <div className="mt-1.5">
      <div className={cn("text-[0.8125rem] leading-[1.7] text-ink-2", !open && long && "line-clamp-4")}>
        <WithAttachments body={text} />
      </div>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-0.5 cursor-pointer font-mono text-[0.6875rem] text-ink-3 hover:text-accent"
        >
          {open ? "收起" : "展开"}
        </button>
      )}
    </div>
  );
}
