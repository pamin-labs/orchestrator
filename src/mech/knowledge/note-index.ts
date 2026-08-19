import { create, insertMultiple, search } from "@orama/orama";
import { stemmer as arabic } from "@orama/stemmers/arabic";
import { stemmer as english } from "@orama/stemmers/english";
import { stemmer as russian } from "@orama/stemmers/russian";
import type { DB } from "../../platform/persistence/database.ts";
import { type Doc, type Hit, KIND_WEIGHT } from "./ctx.ts";
import { terms } from "./terms.ts";

/**
 * The retrieval index for `orch ctx query`. Orama, not a hand-written BM25 and
 * not SQLite FTS5 — the numbers and the FTS5 argument are ADR 020.
 *
 * Two things that constrain edits here. `Intl.Segmenter` goes in through Orama's
 * documented `components.tokenizer` seam rather than around it, because that is
 * what makes the index multilingual — Orama's own tokenizer has no CJK. And the
 * schema is shaped for vectors: adding an embedding later is a field here and a
 * mode passed to `search`, never a second retrieval system beside this one.
 */

/**
 * Ranking that is ours, kept out of the library on purpose.
 *
 * Orama answers "how well does this document match those words". It cannot know
 * that a recorded decision is worth more to recall than a journal entry, or that
 * a note from this morning beats one from last quarter. Those two are product
 * policy and they stay here, multiplied over the library's relevance rather than
 * folded into it, so the two halves can be read apart.
 */
const recency = (at: number, now: number): number => 1 + 0.25 / (1 + Math.max(0, (now - at) / 86_400_000));

/** How many the library returns before our own weights re-order them. */
const CANDIDATES = 60;

interface Row extends Doc {
  grpId: number | null;
  projectId: number | null;
}

/**
 * A version stamp for the note table, cheap enough to read on every query.
 *
 * Three numbers rather than one, because notes are not purely append-only:
 * `saveSingletonNote` rewrites a row in place. A growing `maxId` means new rows
 * and an incremental insert; anything else moving means a row was rewritten or
 * removed, and the index is rebuilt. Both are indexed aggregates over a table
 * that holds thousands of rows, not millions.
 */
interface Stamp {
  count: number;
  maxId: number;
  maxAt: number;
}

const stampOf = (db: DB): Stamp =>
  db
    .query<Stamp, []>(
      "SELECT count(*) AS count, coalesce(max(id), 0) AS maxId, coalesce(max(at), 0) AS maxAt FROM note",
    )
    .get()!;

const rowsAfter = (db: DB, afterId: number): Row[] =>
  db
    .query<Row, [number]>(
      `SELECT id, kind, body, export_path AS exportPath, at, slice_id AS sliceId,
              grp_id AS grpId, project_id AS projectId
         FROM note
        WHERE kind NOT IN ('pageindex', 'map') AND id > ?
        ORDER BY id`,
    )
    .all(afterId);

type Index = ReturnType<typeof emptyIndex>;

/**
 * A stemmer per script, so a query reaches a form of the word it did not use.
 *
 * Retrieval matched the exact surface form: `testing` missed `tests`, `граничные`
 * missed `граничных`. Snowball has none for Chinese, Japanese, Korean or Thai — the
 * first three do not inflect and the fourth is agglutinative, so that is the right
 * answer rather than a gap.
 */
/**
 * Here rather than in `terms()`, and that is the whole of why it is safe: this is the
 * index's own tokeniser, so a query and a document are stemmed by the same function.
 * `repomap.ts` matches \`terms(question)\` against *raw* text with `includes`, where a
 * stem is a substring — `use` becomes `us` and hits `status`, `bus` and `cluster`.
 *
 * Dispatched on the token's script, never on a configured language, because one note
 * holds more than one. The English stemmer returns 测试, テスト, 테스트 and гранич
 * unchanged, so a token only ever meets the stemmer built for it.
 */
const CYRILLIC = /[\p{Script=Cyrillic}]/u;
const ARABIC = /[\p{Script=Arabic}]/u;
const LATIN = /[\p{Script=Latin}]/u;

function stemmed(raw: string): string[] {
  return terms(raw).map((token) => {
    if (CYRILLIC.test(token)) return russian(token);
    if (ARABIC.test(token)) return arabic(token);
    return LATIN.test(token) ? english(token) : token;
  });
}

function emptyIndex() {
  return create({
    schema: { body: "string", kind: "string" },
    components: {
      // Orama's own extension point. `language` and `normalizationCache` are
      // required by the interface and unused by a tokenizer that segments with
      // ICU rather than by stemming an English word list.
      tokenizer: { language: "english", normalizationCache: new Map(), tokenize: (raw: string) => stemmed(raw) },
    },
  });
}

export interface NoteIndex {
  /** Notes matching the question, best first, already scoped and re-weighted. */
  search(question: string, scope: { grpId: number | null; projectId: number | null }, now: number): Hit[];
}

/**
 * Built once and kept fresh, which is state — so it is created by the
 * composition layer and handed to whoever needs it, never reached for from a
 * module. Building costs 315ms at four hundred notes and grows with the corpus,
 * so it happens on first use rather than at boot: nothing is delayed that a
 * person is waiting on, and the cost is paid once per process.
 */
export function makeNoteIndex(db: DB): NoteIndex {
  let index: Index | null = null;
  let stamp: Stamp = { count: -1, maxId: -1, maxAt: -1 };
  const docs = new Map<string, Row>();

  const refresh = (): Index => {
    const now = stampOf(db);
    const rewritten = now.count < stamp.count || (now.maxAt !== stamp.maxAt && now.maxId === stamp.maxId);
    if (index && rewritten) index = null;
    if (!index) {
      index = emptyIndex();
      docs.clear();
      stamp = { count: now.count, maxId: 0, maxAt: now.maxAt };
    }
    const fresh = rowsAfter(db, stamp.maxId);
    if (fresh.length) {
      const inserted = insertMultiple(
        index,
        fresh.map((row) => ({ id: String(row.id), body: row.body, kind: row.kind })),
      );
      // Orama's signature is `Promise<string[]> | string[]`: it goes async only
      // when a component or plugin does, and every one here is synchronous.
      // Checked rather than `void`-ed, because the failure a floating promise
      // produces is notes that were indexed a moment after the search that
      // needed them — silent, and indistinguishable from a bad query.
      if (inserted instanceof Promise) throw new Error("note index went async on insert; components here are sync");
      for (const row of fresh) docs.set(String(row.id), row);
    }
    stamp = now;
    return index;
  };

  return {
    search(question, scope, now) {
      if (!terms(question).length) return [];
      const found = search(refresh(), { term: question, properties: ["body"], limit: CANDIDATES });
      if (found instanceof Promise) throw new Error("note index went async; every component here is synchronous");
      const hits: Hit[] = [];
      for (const hit of found.hits) {
        const doc = docs.get(String(hit.id));
        // Scoped after the library rather than through its filters: the rule is
        // "this group, or this project, or belonging to neither", which is one
        // predicate over three nullable columns and reads plainly here.
        if (!doc) continue;
        const mine =
          (scope.grpId !== null && doc.grpId === scope.grpId) ||
          (scope.projectId !== null && doc.projectId === scope.projectId) ||
          (doc.grpId === null && doc.projectId === null);
        if (!mine) continue;
        hits.push({ doc, score: hit.score * (KIND_WEIGHT[doc.kind] ?? 1) * recency(doc.at, now) });
      }
      return hits.sort((a, b) => b.score - a.score);
    },
  };
}
