import type { DB } from "../../platform/persistence/database.ts";
import { projectConfig } from "../util/rows.ts";
import { GRP_STATES } from "../../contracts/states.ts";
import { jsonOr } from "../../contracts/json.ts";
import { z } from "zod";

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
const DEFAULT_SHARED = [
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
  return jsonOr(json, z.array(z.string()), []);
}

export function sharedFor(db: DB, projectId: number): string[] {
  const shared = projectConfig(db, projectId).shared;
  return shared ? [...DEFAULT_SHARED, ...shared] : DEFAULT_SHARED;
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

/**
 * Does this glob cover this concrete path? `src/a/**`, `src/*`, `src/a/b.ts`.
 *
 * `Bun.Glob` rather than a hand-written matcher, because the hand-written one
 * was wrong in the direction that hurts. It only understood a trailing `/*` and
 * treated everything else as a prefix, so `src/a/**\/*.ts` covered `src/a/b.js`
 * and `src/*.ts` covered `src/deep/nested/x.ts` — and this function's answer is
 * what decides whether a file another group owns gets rolled back after a turn.
 * Saying yes too easily means the stray write stays.
 *
 * One rule is ours and stays: a wildcard-free entry is a directory claim.
 * Agents declare `owns: ["src/mech"]` and mean everything under it, where a
 * glob library means that one path.
 */
function covers(glob: string, path: string): boolean {
  if (glob === path) return true;
  if (!/[*?[]/.test(glob)) return path.startsWith(glob.endsWith("/") ? glob : `${glob}/`);
  return new Bun.Glob(glob).match(path);
}

export interface StartCheck {
  ok: boolean;
  conflicts: OwnershipConflict[];
  /** Shared paths this group tried to claim; those belong to nobody. */
  sharedClaimed: string[];
  reason?: string;
}

/**
 * Two questions, which four call sites had been answering with four ad-hoc
 * string lists and three different answers.
 *
 * "Who could be writing a file right now" is not "who has spoken for these
 * paths", and conflating them breaks in both directions. `canStart` wants the
 * first: a group only holds a worktree from RUNNING onward (`watchdog.ts` only
 * keeps sandboxes for RUNNING and PR_OPEN), and refusing a start because some
 * *unstarted* group claimed the same paths deadlocks both — neither can begin
 * until the other dissolves, and `sweepApproved` retries that silently forever.
 * Two groups still never run overlapping: the sweep is sequential, so whichever
 * starts second sees the first as RUNNING.
 *
 * The boundary questions want the second: "somebody already claimed this, cut a
 * boundary before planning inside it" and `orch blocked`'s "who owns this path"
 * are both about the claim, which exists from birth — `newGroup` inserts a group
 * as PLANNING with `owns_json` already populated. Those three sites had drifted
 * apart by one state each: two of them missed DRAFT, so a requirement waiting on
 * the boss's approval owned its paths as far as the panel was concerned and
 * owned nothing as far as `orch blocked` was concerned.
 *
 * Derived from `GRP_STATES` so a new state joins by existing. Interpolated into
 * SQL because these are compile-time constants from an `as const` array;
 * nothing user-supplied reaches the string.
 */
const sql = (states: readonly string[]) => `(${states.map((s) => `'${s}'`).join(", ")})`;

/** Groups whose agents can be writing files this second. */
export const WRITING = ["RUNNING", "PAUSING", "PAUSED", "PARKED", "PR_OPEN"] as const;
const WRITING_SQL = sql(WRITING);

/** Groups whose declared paths are spoken for: everything that has not dissolved. */
export const CLAIMING = GRP_STATES.filter((s) => s !== "DISSOLVED");
export const CLAIMING_SQL = sql(CLAIMING);

type OtherOwner = { id: number; name: string; owns_json: string };
const startOk = (): StartCheck => ({ ok: true, conflicts: [], sharedClaimed: [] });

function undeclaredStart(owns: string[], others: OtherOwner[]): StartCheck | null {
  if (owns.length > 0) return null;
  const declared = others.filter((owner) => parseOwns(owner.owns_json).length > 0);
  if (declared.length === 0) return startOk();
  return {
    ok: false,
    conflicts: [],
    sharedClaimed: [],
    reason:
      `no owned paths declared, and ${declared.map(({ name }) => name).join(", ")} ` +
      `already hold theirs — the Architect has to cut the boundary before work starts`,
  };
}

function sharedStart(db: DB, grpId: number, projectId: number, owns: string[]): StartCheck | null {
  const granted = parseOwns(
    db.query<{ shared_grant: string | null }, [number]>("SELECT shared_grant FROM grp WHERE id = ?").get(grpId)
      ?.shared_grant ?? null,
  );
  const shared = sharedFor(db, projectId).filter((path) => !granted.includes(path));
  const claimed = claimsShared(owns, shared).filter((path) => !granted.includes(path));
  if (claimed.length === 0) return null;
  return {
    ok: false,
    conflicts: [],
    sharedClaimed: claimed,
    reason: `these belong to no group: ${claimed.join(", ")} — changes there go through the boss or the Architect`,
  };
}

function ownerConflicts(owns: string[], others: OtherOwner[]): OwnershipConflict[] {
  return others.flatMap((owner) =>
    owns.flatMap((mine) =>
      parseOwns(owner.owns_json).flatMap((theirs) =>
        overlaps(mine, theirs) ? [{ grpId: owner.id, name: owner.name, mine, theirs }] : [],
      ),
    ),
  );
}

export function canStart(db: DB, grpId: number): StartCheck {
  const me = db
    .query<{ project_id: number; owns_json: string; name: string }, [number]>(
      "SELECT project_id, owns_json, name FROM grp WHERE id = ?",
    )
    .get(grpId);
  if (!me) return { ok: false, conflicts: [], sharedClaimed: [], reason: "no such group" };

  // fallow-ignore-next-line security-sink -- `WRITING_SQL` is the frozen state-list literal from `contracts/states.ts`; both ids are bound through the `?` placeholders.
  const others = db
    .query<OtherOwner, [number, number]>(
      `SELECT id, name, owns_json FROM grp
       WHERE project_id = ? AND id != ? AND status IN ${WRITING_SQL}`,
    )
    .all(me.project_id, grpId);

  const owns = parseOwns(me.owns_json);
  const undeclared = undeclaredStart(owns, others);
  if (undeclared) return undeclared;

  // A path this group was granted by name. Shared files belong to no group, and
  // that stays true for everyone else — but a defect in one has to be fixable by
  // somebody, and the requirement opened for exactly that was refused here forever.
  const shared = sharedStart(db, grpId, me.project_id, owns);
  if (shared) return shared;

  const conflicts = ownerConflicts(owns, others);
  if (conflicts.length) {
    const c = conflicts[0]!;
    return {
      ok: false,
      conflicts,
      sharedClaimed: [],
      reason: `${c.mine} overlaps ${c.theirs} owned by ${c.name} — wait for it, or ask the Architect for a different split`,
    };
  }
  return startOk();
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
