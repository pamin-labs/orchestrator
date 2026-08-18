import type { Skill } from "../composer/model";

/** Rough, and said as rough. ~4 characters a token is close enough to steer by. */
const cost = (rows: Skill[]) => rows.reduce((n, r) => n + r.name.length + r.description.length + 20, 0) / 4;

/**
 * Two different things, counted separately.
 *
 * `restageSkills` builds the mount from user-scope skills only, so a project
 * skill was inflating a fraction that claims to say how many got staged. Both
 * kinds do land in the cached prefix — the ticked ones through the mount, the
 * repository's own through the checkout the CLI already runs in — so the token
 * estimate counts both.
 */
export function skillTally(rows: Skill[]) {
  const user = rows.filter((r) => r.scope === "user");
  return {
    staged: user.filter((r) => r.on).length,
    user: user.length,
    repo: rows.length - user.length,
    k: Math.round(cost(rows.filter((r) => r.on)) / 100) / 10,
  };
}

/** Name or description: what a skill is for is how it is looked for. */
export function searchSkills(rows: Skill[], q: string): Skill[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((r) => r.name.toLowerCase().includes(needle) || r.description.toLowerCase().includes(needle));
}
