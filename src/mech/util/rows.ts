import type { DB } from "../../platform/persistence/database.ts";
import { StoredProjectConfigSchema, type StoredProjectConfig } from "../../contracts/config.ts";
import { jsonOr } from "../../contracts/json.ts";

/**
 * The three row questions this codebase asks over and over.
 */

/**
 * A project's `config_json`, parsed, `{}` when there is none or it is broken.
 *
 * Six functions asked this and each wrote out the same four things: the SELECT,
 * the `?? "{}"`, the try, and the catch returning its own empty. One of them
 * said so — `installFor`'s docstring read "Same reader shape as `gatesFor`" —
 * which is the note you leave when copying is the only option on offer.
 *
 * Broken JSON is `{}` on purpose and always was: this column is edited by the
 * panel and by agents, and a project whose config lost a brace should run with
 * defaults rather than take its gates, its excludes and its sandbox down with
 * it. `patchProjectConfig` is the one caller that must not silently discard a
 * bad value, and it is the one that does not come through here.
 */
const ReadProjectConfigSchema = StoredProjectConfigSchema.extend({
  detected: StoredProjectConfigSchema.shape.detected.catch(undefined),
  gates: StoredProjectConfigSchema.shape.gates.catch(undefined),
  install: StoredProjectConfigSchema.shape.install.catch(undefined),
  shared: StoredProjectConfigSchema.shape.shared.catch(undefined),
  sandbox: StoredProjectConfigSchema.shape.sandbox.catch(undefined),
  index: StoredProjectConfigSchema.shape.index.catch(undefined),
});

export function projectConfig(db: DB, projectId: number | null | undefined): StoredProjectConfig {
  if (projectId == null) return {};
  const row = db
    .query<{ config_json: string | null }, [number]>("SELECT config_json FROM project WHERE id = ?")
    .get(projectId);
  return jsonOr(row?.config_json, ReadProjectConfigSchema, {});
}

/** Which project an agent belongs to. A standing agent has one and no group. */
export const projectOfAgent = (db: DB, agentId: number | null | undefined): number | null =>
  agentId == null
    ? null
    : (db.query<{ project_id: number | null }, [number]>("SELECT project_id FROM agent WHERE id = ?").get(agentId)
        ?.project_id ?? null);

/**
 * A note of which a project keeps exactly one: the repo map, the page index.
 *
 * Newest-wins with the old row deleted, rather than an upsert, because `note` has
 * no unique key to conflict on — kind is not unique per project for any other
 * kind, and adding one for these two would constrain the table for the sake of
 * two writers.
 *
 * Returns whether anything changed. Both callers use that: an unchanged map must
 * not bump the row's `at`, or every consumer that watches "when did this last
 * move" sees movement on every tick.
 */
/**
 * The one place a note is written.
 *
 * Ten call sites spelled this `INSERT` out by hand in six different column
 * combinations, which is the same shape the `setting` table was in before it got
 * a writer: nothing wrong with any one of them, and a change to how notes are
 * stored is a change in ten places. It also meant every reader had to know which
 * of the nine columns a given writer bothered to fill.
 *
 * `at` defaults to now. Only the report path passes one, and it passes the same
 * clock — stated as a parameter rather than left as an inconsistency between
 * `Date.now()` here and `unixepoch() * 1000` there.
 */
export interface NewNote {
  kind: string;
  body: string;
  projectId?: number | null;
  grpId?: number | null;
  sliceId?: number | null;
  lang?: string | null;
  /** Already serialised: callers build their own shape and `JSON.stringify` it. */
  frontmatterJson?: string;
  exportPath?: string | null;
  at?: number;
}

/** `note.lang`'s schema default, stated here because a bound NULL cannot use it. */
const DEFAULT_NOTE_LANG = "zh";

export function addNote(db: DB, note: NewNote): void {
  db.run(
    `INSERT INTO note (project_id, grp_id, slice_id, kind, lang, body, frontmatter_json, export_path, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      note.projectId ?? null,
      note.grpId ?? null,
      note.sliceId ?? null,
      note.kind,
      // The two columns carrying a schema default are spelled out rather than
      // bound as NULL: `lang` and `frontmatter_json` are both `NOT NULL DEFAULT`,
      // and a bound NULL overrides a default rather than falling back to it —
      // which is a constraint failure, not the empty value the caller meant.
      note.lang ?? DEFAULT_NOTE_LANG,
      note.body,
      note.frontmatterJson ?? "{}",
      note.exportPath ?? null,
      note.at ?? Date.now(),
    ],
  );
}

export function saveSingletonNote(db: DB, projectId: number, kind: string, body: string): boolean {
  const prev = db
    .query<{ id: number; body: string }, [number, string]>(
      "SELECT id, body FROM note WHERE project_id = ? AND kind = ? ORDER BY id DESC LIMIT 1",
    )
    .get(projectId, kind);
  if (prev?.body === body) return false;
  if (prev) db.run("DELETE FROM note WHERE id = ?", [prev.id]);
  addNote(db, { projectId, kind, body });
  return true;
}

/** The body of that note, or null. */
export const singletonNote = (db: DB, projectId: number | null, kind: string): string | null =>
  projectId == null
    ? null
    : (db
        .query<{ body: string }, [number, string]>(
          "SELECT body FROM note WHERE project_id = ? AND kind = ? ORDER BY id DESC LIMIT 1",
        )
        .get(projectId, kind)?.body ?? null);
