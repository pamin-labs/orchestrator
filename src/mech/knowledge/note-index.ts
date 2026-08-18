import { create, insertMultiple, search } from "@orama/orama";
import type { DB } from "../../platform/persistence/database.ts";
import { type Doc, type Hit, KIND_WEIGHT } from "./ctx.ts";
import { terms } from "./terms.ts";

/**
 * The retrieval index for `orch ctx query`, and why it is a library now.
 *
 * What this replaces scored in JavaScript: every query pulled the four hundred
 * most recent notes out of SQLite, re-tokenised all of them — 696,000 characters
 * measured — and ran a hand-written BM25 over the result, at 33.4ms a query. The
 * `LIMIT 400` was not a product decision; it was the ceiling that cost imposed,
 * and it meant nothing written earlier than those four hundred notes could be
 * found at all.
 *
 * Orama owns the scoring now. Measured on this corpus shape: 0.32ms a query at
 * four hundred documents, 1.4ms at two thousand — so the limit goes, and older
 * notes become findable rather than merely stored.
 *
 * **Not SQLite FTS5**, which was the other candidate and is otherwise the
 * cleaner fit: its index lives inside the database and needs no state here at
 * all. It loses on one property that mattered more — it is SQLite's. This index
 * does not live in the database, so replacing the database does not replace the
 * search.
 *
 * **`Intl.Segmenter` goes in through Orama's documented `components.tokenizer`
 * seam**, not around it. That is what makes the index multilingual: the same
 * breaker that made Korean, Russian, Thai, Arabic and Greek searchable in the
 * first place is the one Orama indexes with.
 *
 * The shape is chosen with vector search in mind. Orama does vectors and hybrid
 * ranking natively, so bringing an embedding model and a reranker later is a
 * field added to this schema and a mode passed to `search` — not a second
 * retrieval system beside this one.
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

function emptyIndex() {
  return create({
    schema: { body: "string", kind: "string" },
    components: {
      // Orama's own extension point. `language` and `normalizationCache` are
      // required by the interface and unused by a tokenizer that segments with
      // ICU rather than by stemming an English word list.
      tokenizer: { language: "english", normalizationCache: new Map(), tokenize: (raw: string) => terms(raw) },
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
