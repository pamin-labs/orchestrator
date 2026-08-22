/**
 * Hard rejection, not hints.
 *
 * A prompt that says "keep it under six lines" is forgotten by turn 20. A
 * validator that returns an error and makes the agent rewrite is not. Every
 * length and shape rule in docs/project/plan.md lives here.
 */
import type { Nodes, Root, RootContent, Table } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { z } from "zod";

export interface Invalid {
  ok: false;
  /** Shown to the agent verbatim, so it must say what to fix. */
  error: string;
}
export type Result<T> = ({ ok: true } & T) | Invalid;
const invalid = (error: string): Invalid => ({ ok: false, error });

const JOURNAL_MAX_LINES = 6;
/**
 * Content lines, not physical ones: section paragraphs, list items, and slice
 * rows. Headings and the table header are structure and carry nothing, so they
 * do not count. Twelve is the same budget the line-per-field card had — six
 * sections, one line each, plus six lines of detail to spend where it matters.
 */
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
  // Padding is refused by the line cap above and by nothing else. There was a
  // second check here — two rows of Chinese hedges and two of English ones — and
  // it refused a journal, in two of the ten languages an agent writes in. Same
  // shape as `GENERIC_GATE` and `testOnly`, and one more reason besides: the cap
  // already owns "be terse", in every language, so a lexicon beside it was a
  // second owner of one rule. ADR 046.
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

/**
 * The card's section keys, and they are a protocol rather than copy.
 *
 * They were Chinese, pinned there by `roles/dispatcher.yaml` writing `## 目标`
 * whatever `output.language` said — so a card came back with a Chinese heading
 * over English prose, and only because the model copied the template rather
 * than translating it, which nothing guaranteed. ASCII removes the coin flip:
 * the keys are the same five names `validateDraftCard` already returns, so the
 * document and the parsed shape stop disagreeing.
 */
const DRAFT_FIELDS = ["goal", "non-goals", "accept", "slices", "risk", "objection"] as const;
type Field = (typeof DRAFT_FIELDS)[number];

/**
 * Headings a stored card can still carry. Cards live in `note.body` and are
 * re-validated on approval, so a card filed before this change has to keep
 * parsing — otherwise the boss meets `missing sections` on a card that is
 * plainly complete, and cannot approve it. Retire with `draftLegacy` in 0.2.0.
 */
const ALIAS: Record<string, Field> = {
  目标: "goal",
  不做: "non-goals",
  验收: "accept",
  切片: "slices",
  风险: "risk",
  反对: "objection",
};

/**
 * The field a heading names, in either grammar, or null.
 *
 * Lowercased because Markdown headings are conventionally capitalised and a
 * model writing `## Goal` is not making a mistake worth a rejected card. Chinese
 * had no such case to fold, which is why the exact match was safe before.
 */
function fieldOf(name: string): Field | null {
  // `Object.hasOwn`, not a truthy index: `ALIAS` is a plain object, so
  // `ALIAS["constructor"]` is `Object` — truthy, and enough to make `## constructor`
  // name a section. Same accident `schemaAt` in `contracts/config.ts` closed.
  if (Object.hasOwn(ALIAS, name)) return ALIAS[name]!;
  const lower = name.toLowerCase();
  return DRAFT_FIELDS.find((field) => field === lower) ?? null;
}
/**
 * The same six, named — so a rejection can be written in English and still quote
 * the heading the Dispatcher has to type. Interpolated rather than spelled out
 * again: an error naming a section that `DRAFT_FIELDS` no longer holds sends the
 * model to write a heading the parser will not accept.
 */
const [GOAL, NOT_DOING, ACCEPT, SLICES, RISK, OBJECTION] = DRAFT_FIELDS;
/** What the Architect writes when it has no objection. Content, not a key — so
 *  the prompt asks for it in the agent's own output language rather than fixing
 *  a word here. This is only what the rejection suggests. */
const NO_OBJECTION = "none";

/**
 * A card, structured, whichever grammar it arrived in.
 *
 * `sections` holds one entry per content line, so the rules below never learn
 * which parser produced them. `slices` is deferred because a malformed slice
 * must be reported after the missing-section and count checks, not before.
 */
interface CardParts {
  sections: Map<string, string[]>;
  /** Content lines: what the 12-line cap is a cap on. */
  count: number;
  slices: () => Result<{ slices: DraftSlice[] }>;
}

const markdown = unified().use(remarkParse).use(remarkGfm);

/** Every string a node carries, in order. Emphasis and code markers are structure. */
function textOf(node: Nodes): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node) return node.children.map(textOf).join("");
  return "";
}

/**
 * The DRAFT field this heading names, or null if it names something else.
 *
 * NFKC before the match, not a hand-written pair of colons. Unicode's own
 * compatibility fold maps every fullwidth form to its ASCII one, so a heading
 * typed on a CJK keyboard matches without this file keeping a list of the
 * characters it has met. It normalises the lookup key only; the card's text is
 * never rewritten.
 */
function headingField(node: Nodes): Field | null {
  return fieldOf(textOf(node).normalize("NFKC").trim().replace(/:\s*$/, ""));
}

/** Which section is this node in: the nodes under each field heading, in order. */
function bySection(root: Root): Map<string, RootContent[]> {
  const sections = new Map<string, RootContent[]>();
  let current: RootContent[] | null = null;
  for (const node of root.children) {
    if (node.type !== "heading") {
      current?.push(node);
      continue;
    }
    const field = headingField(node);
    if (field === null) {
      current = null;
      continue;
    }
    current = sections.get(field) ?? [];
    sections.set(field, current);
  }
  return sections;
}

/** Slice rows, cells intact. The header row labels the columns; it is not a slice. */
function tableRows(node: Table): string[][] {
  return node.children.slice(1).map((row) => row.children.map((cell) => textOf(cell).trim()));
}

/**
 * What does this node contain: one entry per content line.
 *
 * A soft-wrapped paragraph is still two lines to a reader, so it is two here —
 * otherwise the cap is escapable by not pressing enter.
 */
function contentLines(node: RootContent): string[] {
  if (node.type === "table") return tableRows(node).map((cells) => cells.join(" | "));
  const texts = node.type === "list" ? node.children.map(textOf) : [textOf(node)];
  return texts.flatMap((text) => text.split("\n").map((line) => line.trim())).filter(Boolean);
}

/**
 * Markdown, parsed as Markdown.
 *
 * Headings name the sections, list items and paragraphs are their content, and
 * `slices` is a GFM table because three fields per slice is a shape every Markdown
 * reader already understands. Returns null when the text has no headings at
 * all, which is the one signal that it predates this format.
 */
function draftMarkdown(text: string): CardParts | null {
  const root = markdown.parse(text);
  if (!root.children.some((n) => n.type === "heading")) return null;

  const grouped = bySection(root);
  const sections = new Map([...grouped].map(([field, nodes]) => [field, nodes.flatMap(contentLines)]));
  const count = [...sections.values()].reduce((n, lines) => n + lines.length, 0);
  const rows = grouped.get(SLICES)?.flatMap((n) => (n.type === "table" ? tableRows(n) : [])) ?? [];

  return { sections, count, slices: () => tableSlices(rows) };
}

function tableSlices(rows: string[][]): Result<{ slices: DraftSlice[] }> {
  const slices: DraftSlice[] = [];
  for (const row of rows) {
    const title = row[0]?.trim() ?? "";
    const difficulty = DifficultySchema.safeParse(row[1]?.trim().toLowerCase());
    const accept = row[2]?.trim() ?? "";
    if (!title || !accept || !difficulty.success)
      return invalid(
        `slice row ${JSON.stringify(row.join(" | "))} must be "| title | trivial|normal|hard | ` +
          `how it is accepted |". The difficulty column picks the model, so it is not optional.`,
      );
    slices.push({ title, difficulty: difficulty.data, accept });
  }
  return { ok: true, slices };
}

/**
 * LEGACY — cards written before Markdown, still in `note.body`.
 *
 * Reached only when a card has no headings at all. Nothing emits this shape any
 * more; it exists so stored cards approved months ago still parse. Remove in
 * 0.2.0, once no `note` row with `draft_card` predates the Markdown format.
 */
function draftLegacy(text: string): CardParts {
  const lines = nonEmptyLines(text);
  const sections = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of lines) {
    const match = /^\s*([^\s:：]+)\s*[:：]\s*(.*)$/.exec(line);
    // Through `fieldOf`, so a card in either grammar keys `sections` by the
    // canonical name — which is what lets every read below name one spelling.
    const head = match?.[1] ? fieldOf(match[1]) : null;
    if (match && head) {
      current = head;
      if (!sections.has(head)) sections.set(head, []);
      const rest = (match[2] ?? "").trim().replace(/^[-•]\s*/, "");
      if (rest) sections.get(head)!.push(rest);
    } else if (current) {
      sections.get(current)!.push(line.replace(/^\s*[-•]\s*/, "").trim());
    }
  }
  return { sections, count: lines.length, slices: () => legacySlices(sections.get(SLICES) ?? []) };
}

/** LEGACY, with `draftLegacy`: "title [difficulty] — how it is accepted". */
function legacySlices(rawSlices: string[]): Result<{ slices: DraftSlice[] }> {
  const slices: DraftSlice[] = [];
  for (const raw of rawSlices) {
    const m = /^(.*?)\[(\w+)\]\s*(?:[—–-]+\s*)?(.*)$/.exec(raw);
    const title = m?.[1]?.trim();
    const difficulty = DifficultySchema.safeParse(m?.[2]?.toLowerCase());
    const accept = m?.[3]?.trim();
    if (!title || !accept || !difficulty.success)
      return invalid(
        `slice ${JSON.stringify(raw)} must read "title [trivial|normal|hard] — how it is ` +
          `accepted". The difficulty tag picks the model, so it is not optional.`,
      );
    slices.push({ title, difficulty: difficulty.data, accept });
  }
  return { ok: true, slices };
}

/**
 * The DRAFT card blocks the boss, so it must be readable in 20 seconds. Rejecting a
 * long card and making the Dispatcher rewrite is cheaper than training the boss to
 * skim.
 *
 * Expected: `## goal` and `## non-goals` one line each, `## accept` 2–3
 * executable list items, `## slices` a table of `| slice | difficulty | accept |`
 * with 1–5 body rows, `## risk` at most 2 items, and `## objection` the
 * Architect's objection in at most 2 lines, or a statement that there is none.
 */
export function validateDraftCard(text: string): Result<DraftOk> {
  const card = draftMarkdown(text) ?? draftLegacy(text);
  if (card.count > DRAFT_MAX_LINES) {
    return {
      ok: false,
      error:
        `card is ${card.count} content lines, max ${DRAFT_MAX_LINES} — counting section ` +
        `paragraphs, list items, and slice rows, not headings or the table header. This card ` +
        `blocks the boss; it must be readable in 20 seconds. Cut detail, not sections — ` +
        `implementation detail does not belong on the card.`,
    };
  }

  const sections = card.sections;

  const missing = DRAFT_FIELDS.filter((f) => !sections.has(f));
  if (missing.length) {
    return { ok: false, error: `missing sections: ${missing.join(", ")}` };
  }

  // `Field`, not `string`: a typo used to be a section that silently read empty,
  // and the rejection then named a heading the card already had.
  const one = (f: Field) => (sections.get(f) ?? []).join(" ").trim();
  const many = (f: Field) => (sections.get(f) ?? []).filter(Boolean);

  const accept = many(ACCEPT);
  if (accept.length < 2 || accept.length > 3) {
    return { ok: false, error: `${ACCEPT} needs 2-3 executable criteria (got ${accept.length})` };
  }

  const rawSlices = many(SLICES);
  // 1, not 3. A floor of three made the Dispatcher invent work: measured, it
  // filed "切片 2、3 是为满足最少切片数补的相邻能力" as a risk on its own card, and
  // one of those padded slices would have changed what existing callers get.
  // A one-line requirement is one slice, and the boss can read that in 5 seconds.
  if (rawSlices.length < 1 || rawSlices.length > 5) {
    return { ok: false, error: `${SLICES} needs 1-5 slices (got ${rawSlices.length})` };
  }
  const parsedSlices = card.slices();
  if (!parsedSlices.ok) return parsedSlices;
  const slices = parsedSlices.slices;

  const split = checkSplit(slices, accept.map(norm));
  if (split) return { ok: false, error: split };

  const risk = many(RISK);
  if (risk.length > 2) return { ok: false, error: `${RISK} max 2 lines (got ${risk.length})` };

  if (!one(GOAL)) return { ok: false, error: `${GOAL} is empty` };
  if (!one(NOT_DOING)) return { ok: false, error: `${NOT_DOING} is empty — say what is out of scope` };
  if (!one(OBJECTION)) {
    return { ok: false, error: `${OBJECTION} is empty — write the Architect's objection, or ${NO_OBJECTION}` };
  }

  return {
    ok: true,
    goal: one(GOAL),
    notDoing: one(NOT_DOING),
    accept,
    slices,
    risk,
    objection: one(OBJECTION),
    lines: card.count,
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
function overlapError(a: string, b: string, left: DraftSlice, i: number, j: number, generic: string[]): string | null {
  if (!a || !b) return null;
  if (a === b)
    return (
      `slices ${i + 1} and ${j + 1} are accepted by the same thing ("${left.accept}"), ` +
      `so they are one deliverable, not two. Merge them.`
    );
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  // The card's own `## accept` is the generic-gate list, and it is in whatever
  // language the card is written in. A slice criterion that only restates a
  // requirement-level one is true of every slice by construction, which is the
  // property the hand-written pattern was reaching for — while knowing English
  // and Chinese only. Containment rather than equality: a card criterion is
  // often the slice gate plus a clause.
  if (short.length < 8 || !long.includes(short) || generic.some((g) => g.includes(short))) return null;
  return (
    `slice ${i + 1} and slice ${j + 1} have nested acceptance criteria, so one is finished ` +
    `by finishing the other. Split them by what could ship alone, or merge them.`
  );
}

/** Case and punctuation off, so two criteria that differ only in how they were
 *  typed compare equal. Used by the overlap check and by the generic-gate list. */
const norm = (value: string) => value.toLowerCase().replace(/[\s\p{P}]+/gu, "");

function splitOverlap(slices: DraftSlice[], generic: string[]): string | null {
  for (let i = 0; i < slices.length; i++) {
    for (let j = i + 1; j < slices.length; j++) {
      const error = overlapError(norm(slices[i]!.accept), norm(slices[j]!.accept), slices[i]!, i, j, generic);
      if (error) return error;
    }
  }
  return null;
}

/**
 * "Tests on their own" is not checked here any more, and ADR 046 says why.
 *
 * It matched the slice *title*, which is prose in `output.language`, so the rule
 * existed for two of the ten locales and never for the other eight. All three
 * ways out fail, and 046 argues each.
 */
/**
 * It keeps three owners that do read ten languages: `roles/dispatcher.yaml`
 * states it with a worked example, the boss reads the card, and `reconcile`
 * catches the consequence as "nothing was claimed and nothing changed".
 */
const checkSplit = (slices: DraftSlice[], generic: string[]): string | null => splitOverlap(slices, generic);

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
 * Only semicolons and newlines, never the comma: Chinese prose uses `，` as ordinary
 * punctuation, so counting those would demand five verdicts for one criterion and
 * teach the writer to pad. A single-clause spec asks for one verdict, which is the
 * same floor self-review already has.
 */
/** NFKC first, so a fullwidth semicolon is a semicolon here without the split
 *  naming one. Only the count leaves this function, so folding is free. */
export function criteriaIn(acceptSpec: string): number {
  const parts = (acceptSpec ?? "")
    .normalize("NFKC")
    .split(/[;\n]/)
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
