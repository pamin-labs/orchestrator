import { useEffect, useState } from "react";
import { Meta } from "../ui/bits";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tab, TabList, TabPanel, Tabs } from "../ui/tabs";
import { pull } from "../lib/api";
import { usePaged } from "../lib/page";
import { clock } from "../lib/utils";

/**
 * The blackboard's static half.
 *
 * PLAN.md §7: the journal is where "做了啥 + 为啥 + 风险" lives, the retro is the only
 * thing a dissolved group leaves behind, and the lesson list is the single mechanism
 * by which the twentieth group is smarter than the first. All of it was written,
 * exported to the repo, injected into prompts — and unreadable from the panel, which
 * made the system's memory something only the agents could see.
 *
 * Newest first, ≤6 lines each by construction (`orch journal add` refuses more), so
 * the whole body is shown rather than truncated: a 6-line note with a "more" link
 * would be a click to see two extra lines.
 */
export interface Note {
  id: number;
  grpId: number | null;
  kind: string;
  body: string;
  at: number;
  exportPath: string | null;
  frontmatter: string | null;
  group: string | null;
}

const KINDS: [string, string, string][] = [
  ["journal", "日志", "每个 turn 的产出：做了啥、为什么、风险。硬性 ≤6 行"],
  ["decision", "决策", "定下来的事，后面的组会引用它"],
  ["retro", "复盘", "解散前必写，不写不许解散 —— 系统唯一的长期记忆"],
  ["lesson", "教训", "从 retro 归纳出来，注入后续组的 prompt。硬上限 20 条"],
  ["onboarding", "入职包", "怎么 build、怎么测、已知坑。新 agent 第一个 turn 免费拿到"],
  ["risk", "风险", "写下来的风险，不是猜的"],
  ["fact", "老板说的", "你的原话，作为最高优先级 fact"],
];

const ZH = new Map(KINDS.map(([k, zh]) => [k, zh]));

export function Notes({ projectId, grpId, compact, tab, onTab }: {
  projectId?: number; grpId?: number; compact?: boolean;
  /** From the hash where this is a whole view; local where it is embedded. */
  tab?: string | null; onTab?: (t: string) => void;
}) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const scope = grpId ? `group=${grpId}` : projectId ? `project=${projectId}` : "";

  useEffect(() => {
    setNotes(null);
    void pull<{ notes: Note[] }>(`/api/notes?${scope}`).then((r) => setNotes(r?.notes ?? []));
  }, [scope]);

  if (!notes) return <Meta>读记录…</Meta>;
  if (!notes.length) {
    return (
      <div className="text-[0.8125rem] text-ink-3">
        还没有记录。agent 每个 turn 写 journal（≤6 行，超了 `orch` 拒收），组解散前必须写 retro，
        Librarian 把 retro 归纳成教训注入后续组。
      </div>
    );
  }

  // Inside one requirement the list is short and mixed — kinds as tabs there would be
  // four tabs with one row each.
  if (compact) return <List notes={notes} size={8} showKind />;

  const present = KINDS.filter(([k]) => notes.some((n) => n.kind === k));
  return (
    <Tabs value={tab ?? present[0]?.[0] ?? "journal"} onValueChange={onTab}>
      <TabList>
        {present.map(([k, zh]) => (
          <Tab key={k} value={k} count={notes.filter((n) => n.kind === k).length}>
            {zh}
          </Tab>
        ))}
      </TabList>
      {present.map(([k, , hint]) => (
        <TabPanel key={k} value={k}>
          <Meta className="mb-1.5 block">{hint}</Meta>
          <List notes={notes.filter((n) => n.kind === k)} size={25} />
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
        <Row key={n.id} n={n} showKind={showKind} />
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
  let files: string[] = [];
  let gate: string | null = null;
  try {
    const f = JSON.parse(n.frontmatter ?? "{}");
    files = Array.isArray(f.files) ? f.files.slice(0, 6) : [];
    gate = typeof f.gate === "string" ? f.gate : null;
  } catch {}

  return (
    <div className="border-t border-rule-soft py-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {showKind && <Badge>{ZH.get(n.kind) ?? n.kind}</Badge>}
        {n.group && <Meta>{n.group}</Meta>}
        <Meta>{clock(n.at)}</Meta>
        {gate && (
          <Meta className={gate === "pass" ? "text-ok" : gate === "fail" ? "text-bad" : undefined}>gate {gate}</Meta>
        )}
        {files.length > 0 && <Meta className="min-w-0 truncate">{files.join(" ")}</Meta>}
        {n.exportPath && <Meta className="min-w-0 truncate text-ink-3">{n.exportPath}</Meta>}
      </div>
      <div className="mt-0.5 whitespace-pre-wrap text-[0.8125rem] leading-relaxed text-ink-2">{n.body}</div>
    </div>
  );
}
