import type { DB } from "../db.ts";

/**
 * Which paths a group owns, decided before it starts.
 *
 * A merge queue answers "who lands first". It cannot answer "these two groups
 * should never have been editing the same file", which is the actual problem when
 * one project runs several groups — and by the time git says conflict, both have
 * already paid for the work. So overlap is refused at start, not at merge.
 */

export interface OwnershipConflict {
  grpId: number;
  name: string;
  /** The two globs that collide, for a message the boss can act on. */
  mine: string;
  theirs: string;
}

/** Files that belong to no group: a change here affects everyone. */
export const DEFAULT_SHARED = [
  "package.json",
  "bun.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "schema.sql",
  ".github/**",
  "config/**",
];

export function parseOwns(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function sharedFor(db: DB, projectId: number): string[] {
  const row = db
    .query<{ config_json: string }, [number]>("SELECT config_json FROM project WHERE id = ?")
    .get(projectId);
  try {
    const cfg = JSON.parse(row?.config_json ?? "{}");
    return Array.isArray(cfg.shared) ? [...DEFAULT_SHARED, ...cfg.shared] : DEFAULT_SHARED;
  } catch {
    return DEFAULT_SHARED;
  }
}

/** The fixed part of a glob, up to the first wildcard. */
export function staticPrefix(glob: string): string {
  const i = glob.search(/[*?[]/);
  // A literal path is its own prefix. Trimming it to the last `/` would turn
  // `package.json` into `""`, which then "overlaps" every glob in the repo.
  if (i === -1) return glob;
  // With a wildcard, trim back to a path boundary so `src/aut` cannot look like
  // a prefix of `src/auth/` when the globs are `src/aut*` and `src/auth/**`.
  return glob.slice(0, i).replace(/[^/]*$/, "");
}

/**
 * Do two globs describe paths that can collide?
 *
 * Deliberately conservative: when unsure, say yes. A false positive costs a
 * serialised group; a false negative costs two groups editing the same file and
 * discovering it at merge time.
 */
export function overlaps(a: string, b: string): boolean {
  if (a === b) return true;
  const pa = staticPrefix(a);
  const pb = staticPrefix(b);
  if (pa === "" || pb === "") return true; // one of them is rooted at the repo
  if (pa.startsWith(pb) || pb.startsWith(pa)) return true;
  // Same directory, and at least one side wildcards the filename.
  const dirA = a.slice(0, a.lastIndexOf("/") + 1);
  const dirB = b.slice(0, b.lastIndexOf("/") + 1);
  if (dirA === dirB && (a.includes("*") || b.includes("*"))) return true;
  return false;
}

export function claimsShared(owns: string[], shared: string[]): string[] {
  return owns.filter((o) => shared.some((s) => overlaps(o, s)));
}

export interface StartCheck {
  ok: boolean;
  conflicts: OwnershipConflict[];
  /** Shared paths this group tried to claim; those belong to nobody. */
  sharedClaimed: string[];
  reason?: string;
}

/** Groups that still hold their paths: anything not finished. */
const ACTIVE = "('RUNNING', 'PAUSING', 'PAUSED', 'PARKED', 'PR_OPEN')";

export function canStart(db: DB, grpId: number): StartCheck {
  const me = db
    .query<{ project_id: number; owns_json: string; name: string }, [number]>(
      "SELECT project_id, owns_json, name FROM grp WHERE id = ?",
    )
    .get(grpId);
  if (!me) return { ok: false, conflicts: [], sharedClaimed: [], reason: "no such group" };

  const others = db
    .query<{ id: number; name: string; owns_json: string }, [number, number]>(
      `SELECT id, name, owns_json FROM grp
       WHERE project_id = ? AND id != ? AND status IN ${ACTIVE}`,
    )
    .all(me.project_id, grpId);

  const owns = parseOwns(me.owns_json);
  if (owns.length === 0) {
    // Overlap is the real criterion, and two undeclared sets cannot be shown to
    // overlap. So this only bites when someone else HAS drawn a boundary: then
    // starting undeclared would silently claim everything, including their paths.
    const declared = others.filter((o) => parseOwns(o.owns_json).length > 0);
    if (declared.length === 0) return { ok: true, conflicts: [], sharedClaimed: [] };
    return {
      ok: false,
      conflicts: [],
      sharedClaimed: [],
      reason:
        `no owned paths declared, and ${declared.map((o) => o.name).join(", ")} ` +
        `already hold theirs — the Architect has to cut the boundary before work starts`,
    };
  }

  const shared = sharedFor(db, me.project_id);
  const sharedClaimed = claimsShared(owns, shared);
  if (sharedClaimed.length) {
    return {
      ok: false,
      conflicts: [],
      sharedClaimed,
      reason: `these belong to no group: ${sharedClaimed.join(", ")} — changes there go through the boss or the Architect`,
    };
  }

  const conflicts: OwnershipConflict[] = [];
  for (const o of others) {
    for (const mine of owns) {
      for (const theirs of parseOwns(o.owns_json)) {
        if (overlaps(mine, theirs)) conflicts.push({ grpId: o.id, name: o.name, mine, theirs });
      }
    }
  }
  if (conflicts.length) {
    const c = conflicts[0]!;
    return {
      ok: false,
      conflicts,
      sharedClaimed: [],
      reason: `${c.mine} overlaps ${c.theirs} owned by ${c.name} — wait for it, or ask the Architect for a different split`,
    };
  }
  return { ok: true, conflicts: [], sharedClaimed: [] };
}

/**
 * Extra denyWrite entries that keep a group inside its own paths.
 *
 * The sandbox is deny-only, so "only these globs are writable" cannot be
 * expressed directly. What we can do is deny the worktree's top-level entries
 * the group does not own — coarse, but it catches the common case of a group
 * wandering into a sibling module.
 *
 * ponytail: top level only. A nested stray write inside an owned directory still
 * gets through; reconcile and the diff review catch that instead.
 */
export function denyOutsideOwns(worktree: string, owns: string[], topLevelEntries: string[]): string[] {
  const ownedTops = new Set(
    owns.map((o) => {
      const first = o.split("/")[0]!;
      return first.includes("*") ? "*" : first;
    }),
  );
  if (ownedTops.has("*")) return [];
  return topLevelEntries
    .filter((e) => !ownedTops.has(e) && e !== ".git")
    .map((e) => `${worktree}/${e}/**`);
}
