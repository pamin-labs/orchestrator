/**
 * Hard rejection, not hints.
 *
 * A prompt that says "keep it under six lines" is forgotten by turn 20. A
 * validator that returns an error and makes the agent rewrite is not. Every
 * length and shape rule in docs/project/plan.md lives here.
 */
import { z } from "zod";

export interface Invalid {
  ok: false;
  /** Shown to the agent verbatim, so it must say what to fix. */
  error: string;
}
export type Result<T> = ({ ok: true } & T) | Invalid;
const invalid = (error: string): Invalid => ({ ok: false, error });

const JOURNAL_MAX_LINES = 6;
const DRAFT_MAX_LINES = 12;

const JOURNAL_KINDS = ["fact", "decision", "journal", "retro", "handoff", "risk", "onboarding", "lesson"] as const;
const JournalKindSchema = z.enum(JOURNAL_KINDS);
export type JournalKind = z.infer<typeof JournalKindSchema>;

export interface JournalInput {
  kind: string;
  body: string;
  files?: string[];
}

export interface JournalOk {
  kind: JournalKind;
  body: string;
  lines: number;
}

/**
 * Journal entries: structured frontmatter, body of at most six lines covering
 * "what changed / why / risk". Process belongs in the timeline, not here — that
 * is the whole reason for the cap.
 */
export function validateJournal(input: JournalInput): Result<JournalOk> {
  const kind = input.kind?.trim();
  const parsedKind = JournalKindSchema.safeParse(kind);
  if (!parsedKind.success) {
    return {
      ok: false,
      error: `kind must be one of: ${JOURNAL_KINDS.join(", ")} (got ${JSON.stringify(input.kind)})`,
    };
  }

  const lines = nonEmptyLines(input.body);
  if (lines.length === 0) return { ok: false, error: "body is empty" };
  if (lines.length > JOURNAL_MAX_LINES) {
    return {
      ok: false,
      error:
        `body is ${lines.length} lines, max ${JOURNAL_MAX_LINES}. Keep what changed, why, ` +
        `and the risk. Drop the process — it is already in the timeline, and ` +
        `\`orch ctx query\` can retrieve it.`,
    };
  }
  const filler = findFiller(lines.join(" "));
  if (filler) {
    return {
      ok: false,
      error: `drop filler (${filler}). State the change, the reason, the risk.`,
    };
  }
  return { ok: true, kind: parsedKind.data, body: lines.join("\n"), lines: lines.length };
}

const DifficultySchema = z.enum(["trivial", "normal", "hard"]);
export type Difficulty = z.infer<typeof DifficultySchema>;

export interface DraftSlice {
  title: string;
  difficulty: Difficulty;
  accept: string;
}

export interface DraftOk {
  goal: string;
  notDoing: string;
  accept: string[];
  slices: DraftSlice[];
  risk: string[];
  objection: string;
  lines: number;
}

const DRAFT_FIELDS = ["目标", "不做", "验收", "切片", "风险", "反对"] as const;

function draftSections(lines: string[]): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of lines) {
    const match = /^\s*([^\s:：]+)\s*[:：]\s*(.*)$/.exec(line);
    const head = match?.[1];
    if (head && (DRAFT_FIELDS as readonly string[]).includes(head)) {
      current = head;
      if (!sections.has(head)) sections.set(head, []);
      const rest = match[2]!.trim().replace(/^[-•]\s*/, "");
      if (rest) sections.get(head)!.push(rest);
    } else if (current) {
      sections.get(current)!.push(line.replace(/^\s*[-•]\s*/, "").trim());
    }
  }
  return sections;
}

function draftSlices(rawSlices: string[]): Result<{ slices: DraftSlice[] }> {
  const slices: DraftSlice[] = [];
  for (const raw of rawSlices) {
    const parsed = parseSlice(raw);
    if (!parsed)
      return invalid(
        `slice ${JSON.stringify(raw)} must read "title [trivial|normal|hard] — how it is ` +
          `accepted". The difficulty tag picks the model, so it is not optional.`,
      );
    slices.push(parsed);
  }
  return { ok: true, slices };
}

/**
 * The DRAFT card blocks the boss, so it must be readable in 20 seconds.
 * Rejecting a long card and making the Dispatcher rewrite is cheaper than
 * training the boss to skim.
 *
 * Expected shape (see docs/project/plan.md §7):
 *   目标 : one line
 *   不做 : one line
 *   验收 : 2-3 executable lines
 *   切片 : 3-5 lines of "title [difficulty] — how it is accepted"
 *   风险 : <=2 lines
 *   反对 : Architect's objection, <=2 lines, or 无
 */
export function validateDraftCard(text: string): Result<DraftOk> {
  const lines = nonEmptyLines(text);
  if (lines.length > DRAFT_MAX_LINES) {
    return {
      ok: false,
      error:
        `card is ${lines.length} lines, max ${DRAFT_MAX_LINES}. This card blocks the boss; ` +
        `it must be readable in 20 seconds. Cut detail, not sections — implementation ` +
        `detail does not belong on the card.`,
    };
  }

  const sections = draftSections(lines);

  const missing = DRAFT_FIELDS.filter((f) => !sections.has(f));
  if (missing.length) {
    return { ok: false, error: `missing sections: ${missing.join(", ")}` };
  }

  const one = (f: string) => (sections.get(f) ?? []).join(" ").trim();
  const many = (f: string) => (sections.get(f) ?? []).filter(Boolean);

  const accept = many("验收");
  if (accept.length < 2 || accept.length > 3) {
    return { ok: false, error: `验收 needs 2-3 executable criteria (got ${accept.length})` };
  }

  const rawSlices = many("切片");
  // 1, not 3. A floor of three made the Dispatcher invent work: measured, it
  // filed "切片 2、3 是为满足最少切片数补的相邻能力" as a risk on its own card, and
  // one of those padded slices would have changed what existing callers get.
  // A one-line requirement is one slice, and the boss can read that in 5 seconds.
  if (rawSlices.length < 1 || rawSlices.length > 5) {
    return { ok: false, error: `切片 needs 1-5 slices (got ${rawSlices.length})` };
  }
  const parsedSlices = draftSlices(rawSlices);
  if (!parsedSlices.ok) return parsedSlices;
  const slices = parsedSlices.slices;

  const split = checkSplit(slices);
  if (split) return { ok: false, error: split };

  const risk = many("风险");
  if (risk.length > 2) return { ok: false, error: `风险 max 2 lines (got ${risk.length})` };

  if (!one("目标")) return { ok: false, error: "目标 is empty" };
  if (!one("不做")) return { ok: false, error: "不做 is empty — say what is out of scope" };
  if (!one("反对")) {
    return { ok: false, error: "反对 is empty — write the Architect's objection, or 无" };
  }

  return {
    ok: true,
    goal: one("目标"),
    notDoing: one("不做"),
    accept,
    slices,
    risk,
    objection: one("反对"),
    lines: lines.length,
  };
}

/**
 * The one deterministic check on slice quality.
 *
 * Slicing is otherwise the only step in the whole pipeline with no automatic
 * guard, and the abstract rule ("each slice must be independently acceptable") was
 * already in the Dispatcher's prompt when a real run produced three steps of one
 * change. These three cases are the ones that can be caught without judgement.
 */
function overlapError(a: string, b: string, left: DraftSlice, i: number, j: number): string | null {
  if (!a || !b) return null;
  if (a === b)
    return (
      `slices ${i + 1} and ${j + 1} are accepted by the same thing ("${left.accept}"), ` +
      `so they are one deliverable, not two. Merge them.`
    );
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 8 || !long.includes(short) || GENERIC_GATE.test(short)) return null;
  return (
    `slice ${i + 1} and slice ${j + 1} have nested acceptance criteria, so one is finished ` +
    `by finishing the other. Split them by what could ship alone, or merge them.`
  );
}

function splitOverlap(slices: DraftSlice[]): string | null {
  const norm = (value: string) => value.toLowerCase().replace(/[\s\p{P}]+/gu, "");
  for (let i = 0; i < slices.length; i++) {
    for (let j = i + 1; j < slices.length; j++) {
      const error = overlapError(norm(slices[i]!.accept), norm(slices[j]!.accept), slices[i]!, i, j);
      if (error) return error;
    }
  }
  return null;
}

function checkSplit(slices: DraftSlice[]): string | null {
  const overlap = splitOverlap(slices);
  if (overlap) return overlap;
  // "Add tests" is never a deliverable on its own: tests belong with the change
  // they test, and a slice of them can only be accepted after another slice is.
  const testOnly =
    /^(补充?|添加|新增|加上?|补齐|write|add|create)?\s*(单元)?(测试|单测|test|tests|unit ?tests?|用例|测试用例)\s*$/i;
  const idx = slices.findIndex((s) => testOnly.test(s.title.trim()));
  if (idx !== -1 && slices.length > 1) {
    return (
      `slice ${idx + 1} ("${slices[idx]!.title}") is tests on their own. Tests belong with the ` +
      `change they test — fold them into the slice that makes the change.`
    );
  }
  return null;
}

/** "the suite passes" and friends: true of every slice, so never evidence of overlap. */
const GENERIC_GATE =
  /^(bun|npm|pnpm|yarn|cargo|go|pytest|dotnet|make)?(test|tests|check|build|lint|typecheck)?(全绿|绿|通过|pass|passes|passing|ok|green|全部通过)?$/i;

function parseSlice(raw: string): DraftSlice | null {
  const m = /^(.*?)\[(\w+)\]\s*(?:[—–-]+\s*)?(.*)$/.exec(raw);
  if (!m) return null;
  const title = m[1]!.trim();
  const difficulty = DifficultySchema.safeParse(m[2]!.toLowerCase());
  const accept = m[3]!.trim();
  if (!title || !accept || !difficulty.success) return null;
  return { title, difficulty: difficulty.data, accept };
}

/**
 * Self-review that says nothing is not self-review. It must reference the
 * acceptance criteria and its own diff, or it is just self-congratulation.
 */
export function validateSelfReview(text: string, criteriaCount: number): Result<{ checked: number }> {
  const lines = nonEmptyLines(text);
  const vacuous = /^(looks?\s+(good|fine|ok)|lgtm|no\s+(issues?|problems?)|all\s+good|seems?\s+(fine|correct))\b/i;
  if (lines.length === 0 || (lines.length === 1 && vacuous.test(lines[0]!))) {
    return {
      ok: false,
      error:
        "self-review must state a verdict per acceptance criterion and cite the diff lines it " +
        "checked. 'looks good' carries no information.",
    };
  }
  // One verdict per criterion, at minimum. Fewer means something went unchecked.
  const verdicts = lines.filter((l) => /\b(pass|fail|ok|not\s+met|met)\b/i.test(l)).length;
  if (verdicts < criteriaCount) {
    return {
      ok: false,
      error: `covered ${verdicts} of ${criteriaCount} acceptance criteria — state a verdict for each`,
    };
  }
  return { ok: true, checked: verdicts };
}

/**
 * How many separate things an acceptance line asks for.
 *
 * Only `；;` and newlines, never the comma: Chinese prose uses `，` as ordinary
 * punctuation, so counting those would demand five verdicts for one criterion and
 * teach the writer to pad. A single-clause spec asks for one verdict, which is the
 * same floor self-review already has — this only bites on specs that genuinely
 * listed several things and got one word back.
 */
export function criteriaIn(acceptSpec: string): number {
  const parts = (acceptSpec ?? "")
    .split(/[；;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return Math.max(1, parts.length);
}

function nonEmptyLines(s: string): string[] {
  return (s ?? "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
}

/**
 * Politeness and hedging carry no information and cost tokens forever.
 * No `\b` on the CJK patterns — word boundaries do not exist between Han
 * characters, so `\b其实\b` never matches inside a Chinese sentence.
 */
const FILLER = [
  /(基本上|其实|实际上|简单来说|需要注意的是|值得一提的是)/,
  /\b(basically|actually|simply|just to be clear|it should be noted)\b/i,
  /\b(as (an )?AI|I('| a)?m happy to|certainly|of course)\b/i,
];

function findFiller(s: string): string | null {
  for (const re of FILLER) {
    const m = re.exec(s);
    if (m) return m[0];
  }
  return null;
}
