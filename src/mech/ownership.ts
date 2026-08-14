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

/**
 * Which of these repo-relative paths the group had no business writing.
 *
 * Checked after the turn, against `git status`, and the offending files are
 * rolled back. There is no earlier clock left: a deny-list used to stop the write
 * before it happened, but the container knows nothing about which group owns
 * which file, so this is the only mechanism (decision 005, §Ceiling).
 *
 * A group that declared nothing owns nothing in particular and is not policed
 * here. Build outputs are exempt: the gate writes them on every run, for every
 * group, and it has to be able to produce the thing it then checks. So are the
 * files the orchestrator itself puts in the worktree.
 */
export function outsideOwns(changed: string[], owns: string[]): string[] {
  if (!owns.length) return [];
  const allowed = [...owns, ...BUILD_OUTPUTS, ...HARNESS_FILES];
  return changed.filter((p) => !allowed.some((glob) => covers(glob, p)));
}

/** Does this glob cover this concrete path? `src/a/**`, `src/*`, `src/a/b.ts`. */
function covers(glob: string, path: string): boolean {
  if (glob === path) return true;
  const prefix = staticPrefix(glob);
  // No wildcard: a plain directory entry covers everything under it.
  if (prefix === glob) return path.startsWith(glob.endsWith("/") ? glob : `${glob}/`);
  if (!path.startsWith(prefix)) return false;
  // `src/*` is one segment, `src/**` is any depth. Everything else is a prefix.
  if (glob.endsWith("/*")) return !path.slice(prefix.length).includes("/");
  return true;
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

  // A path this group was granted by name. Shared files belong to no group, and
  // that stays true for everyone else — but a defect in one has to be fixable by
  // somebody, and the requirement opened for exactly that was refused here forever.
  const granted = parseOwns(
    db.query<{ shared_grant: string | null }, [number]>("SELECT shared_grant FROM grp WHERE id = ?").get(grpId)
      ?.shared_grant ?? null,
  );
  const shared = sharedFor(db, me.project_id).filter((s) => !granted.includes(s));
  const sharedClaimed = claimsShared(owns, shared).filter((o) => !granted.includes(o));
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
 * Never counted as a stray write, whatever the group owns.
 *
 * The build gate writes here on every run, and it runs for every group. Reverting
 * it for everyone who does not own `web/**` meant the gate could not produce the
 * thing the gate then checks.
 */
const BUILD_OUTPUTS = ["web/dist"];

/**
 * Written by the orchestrator into every checkout, not by the agent in it.
 *
 * AGENTS.md / CLAUDE.md: whichever of the two the project does not ship is a
 * symlink we create, so a turn on either runtime reads the project's
 * instructions. Only the link is ours — an agent editing the real file is a
 * normal change and reconcile still sees it, because the link is what gets
 * skipped, not the target.
 * The reconcile exists to catch what an agent wrote outside its boundary, and this
 * is ours — without the exemption it was reverted after every turn, recreated
 * before the next one, and escalated to the boss each time. Observed live, once
 * per turn, forever.
 */
const HARNESS_FILES = ["AGENTS.md", "CLAUDE.md"];
