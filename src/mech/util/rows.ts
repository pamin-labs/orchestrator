import { and, desc, eq } from "drizzle-orm";
import type { DB } from "../../platform/persistence/database.ts";
import { agent, grp, note as notes, project } from "../../platform/persistence/schema.ts";
import { StoredProjectConfigSchema, type StoredProjectConfig } from "../../contracts/config.ts";
import { valueOr, type Json } from "../../contracts/json.ts";

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

export async function projectConfig(db: DB, projectId: number | null | undefined): Promise<StoredProjectConfig> {
  if (projectId == null) return {};
  const [row] = await db.select({ config_json: project.config_json }).from(project).where(eq(project.id, projectId));
  return valueOr(row?.config_json, ReadProjectConfigSchema, {});
}

/** Which project an agent belongs to. A standing agent has one and no group. */
export async function projectOfAgent(db: DB, agentId: number | null | undefined): Promise<number | null> {
  if (agentId == null) return null;
  const [row] = await db.select({ project_id: agent.project_id }).from(agent).where(eq(agent.id, agentId));
  return row?.project_id ?? null;
}

/**
 * Which project a group belongs to.
 *
 * Seventeen call sites across ten files wrote this SELECT out, beside a
 * `projectOfAgent` that had been extracted for the same reason and left with the
 * duplication it was meant to replace still in place.
 */
export async function projectOfGrp(db: DB, grpId: number | null | undefined): Promise<number | null> {
  if (grpId == null) return null;
  const [row] = await db.select({ project_id: grp.project_id }).from(grp).where(eq(grp.id, grpId));
  return row?.project_id ?? null;
}

/**
 * The branch a group's work is measured against, as stored.
 *
 * For prose an agent reads, not for a git command: `baseBranch` asks GitHub and
 * `baseRefFor` verifies the ref exists, and neither belongs in a sentence. A
 * project on `develop` was being told to `git rebase origin/main` in four places
 * because the fallback was written into the string.
 */
export async function baseBranchOf(
  db: DB,
  grpId: number | null | undefined,
  fallbacks: readonly string[],
): Promise<string> {
  // `.min(1)` on the schema, so the first entry exists — but `noUncheckedIndexedAccess`
  // does not know that, and an `as string` at each of the four call sites would be
  // four assertions standing in for one check.
  const fallback = fallbacks[0] ?? "main";
  if (grpId == null) return fallback;
  const [row] = await db
    .select({ base_branch: project.base_branch })
    .from(grp)
    .innerJoin(project, eq(project.id, grp.project_id))
    .where(eq(grp.id, grpId));
  return row?.base_branch ?? fallback;
}

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
  /** The language this note is written in; `null` for machine data. */
  lang: string | null;
  /** The value itself: `frontmatter_json` is `jsonb`, so nothing here is serialised. */
  frontmatter?: Json;
  exportPath?: string | null;
  /** The note this one overturns. Retrieval stops answering with what it points at. */
  supersedes?: number | null;
  at?: number;
}

export async function addNote(db: DB, note: NewNote): Promise<void> {
  await db.insert(notes).values({
    project_id: note.projectId ?? null,
    grp_id: note.grpId ?? null,
    slice_id: note.sliceId ?? null,
    kind: note.kind,
    lang: note.lang,
    // Spelled out rather than bound as NULL: `frontmatter_json` is `NOT NULL
    // DEFAULT`, and a bound NULL overrides a default rather than falling back to
    // it — a constraint failure, not the empty value the caller meant.
    body: note.body,
    frontmatter_json: note.frontmatter ?? {},
    export_path: note.exportPath ?? null,
    supersedes: note.supersedes ?? null,
    at: note.at ?? Date.now(),
  });
}

export async function saveSingletonNote(db: DB, projectId: number, kind: string, body: string): Promise<boolean> {
  const [prev] = await db
    .select({ id: notes.id, body: notes.body })
    .from(notes)
    .where(and(eq(notes.project_id, projectId), eq(notes.kind, kind)))
    .orderBy(desc(notes.id))
    .limit(1);
  if (prev?.body === body) return false;
  if (prev) await db.delete(notes).where(eq(notes.id, prev.id));
  // JSON, not prose: `repomap` and `pageindex` are the callers.
  await addNote(db, { projectId, kind, body, lang: null });
  return true;
}

/** The body of that note, or null. */
export async function singletonNote(db: DB, projectId: number | null, kind: string): Promise<string | null> {
  if (projectId == null) return null;
  const [row] = await db
    .select({ body: notes.body })
    .from(notes)
    .where(and(eq(notes.project_id, projectId), eq(notes.kind, kind)))
    .orderBy(desc(notes.id))
    .limit(1);
  return row?.body ?? null;
}
