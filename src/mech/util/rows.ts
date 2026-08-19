import { and, desc, eq } from "drizzle-orm";
import type { DB } from "../../platform/persistence/database.ts";
import { orm } from "../../platform/persistence/orm.ts";
import { agent, note as notes, project } from "../../platform/persistence/schema.ts";
import { StoredProjectConfigSchema, type StoredProjectConfig } from "../../contracts/config.ts";
import { jsonOr } from "../../contracts/json.ts";

/**
 * The three row questions this codebase asks over and over.
 */

/**
 * A project's `config_json`, parsed, `{}` when there is none or it is broken.
 *
 * Six functions asked this and each wrote out the same four things: the SELECT, the
 * `?? "{}"`, the try, and the catch returning its own empty. One of them said so —
 * `installFor`'s docstring read "Same reader shape as `gatesFor`" — which is the
 * note you leave when copying is the only option on offer.
 */
/**
 * Broken JSON is `{}` on purpose and always was: this column is edited by the panel
 * and by agents, and a project whose config lost a brace should run with defaults
 * rather than take its gates, its excludes and its sandbox down with it.
 * `patchProjectConfig` is the one caller that must not silently discard a bad value,
 * and it is the one that does not come through here.
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
  const row = orm(db).select({ config_json: project.config_json }).from(project).where(eq(project.id, projectId)).get();
  return jsonOr(row?.config_json, ReadProjectConfigSchema, {});
}

/** Which project an agent belongs to. A standing agent has one and no group. */
export const projectOfAgent = (db: DB, agentId: number | null | undefined): number | null =>
  agentId == null
    ? null
    : (orm(db).select({ project_id: agent.project_id }).from(agent).where(eq(agent.id, agentId)).get()?.project_id ??
      null);

/**
 * A note of which a project keeps exactly one: the repo map, the page index.
 *
 * Newest-wins with the old row deleted, rather than an upsert, because `note` has no
 * unique key to conflict on — and adding one would constrain the table for the sake
 * of two writers.
 *
 * Returns whether anything changed. Both callers use that: an unchanged map must not
 * bump the row's `at`, or every consumer watching for movement sees it every tick.
 */
/**
 * The one place a note is written.
 *
 * Ten call sites spelled this `INSERT` out by hand in six column combinations — the
 * same shape the `setting` table was in before it got a writer. It also meant every
 * reader had to know which of the nine columns a given writer bothered to fill.
 *
 * `at` defaults to now; only the report path passes one, and it passes the same
 * clock.
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
  /** The note this one overturns. Retrieval stops answering with what it points at. */
  supersedes?: number | null;
  at?: number;
}

/** `note.lang`'s schema default, stated here because a bound NULL cannot use it. */
const DEFAULT_NOTE_LANG = "zh";

export function addNote(db: DB, note: NewNote): void {
  orm(db)
    .insert(notes)
    .values({
      project_id: note.projectId ?? null,
      grp_id: note.grpId ?? null,
      slice_id: note.sliceId ?? null,
      kind: note.kind,
      // The two columns carrying a schema default are spelled out rather than
      // bound as NULL: `lang` and `frontmatter_json` are both `NOT NULL DEFAULT`,
      // and a bound NULL overrides a default rather than falling back to it —
      // which is a constraint failure, not the empty value the caller meant.
      lang: note.lang ?? DEFAULT_NOTE_LANG,
      body: note.body,
      frontmatter_json: note.frontmatterJson ?? "{}",
      export_path: note.exportPath ?? null,
      supersedes: note.supersedes ?? null,
      at: note.at ?? Date.now(),
    })
    .run();
}

export function saveSingletonNote(db: DB, projectId: number, kind: string, body: string): boolean {
  const prev = orm(db)
    .select({ id: notes.id, body: notes.body })
    .from(notes)
    .where(and(eq(notes.project_id, projectId), eq(notes.kind, kind)))
    .orderBy(desc(notes.id))
    .limit(1)
    .get();
  if (prev?.body === body) return false;
  if (prev) orm(db).delete(notes).where(eq(notes.id, prev.id)).run();
  addNote(db, { projectId, kind, body });
  return true;
}

/** The body of that note, or null. */
export const singletonNote = (db: DB, projectId: number | null, kind: string): string | null =>
  projectId == null
    ? null
    : (orm(db)
        .select({ body: notes.body })
        .from(notes)
        .where(and(eq(notes.project_id, projectId), eq(notes.kind, kind)))
        .orderBy(desc(notes.id))
        .limit(1)
        .get()?.body ?? null);
