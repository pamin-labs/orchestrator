import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { roleFor, type Ctx } from "../ctx.ts";
import { grp, job } from "../../platform/persistence/schema.ts";
import { WORK } from "../sandbox/sandbox.ts";
import { baseRefFor, sandboxGit } from "../git/checkout.ts";

/**
 * Where the base branch is, and how far a group's branch is from it.
 *
 * Two callers: watchdog rule 15 measures every running group each tick and
 * nudges the one whose base moved; the panel's `sync` button asks for the same
 * nudge again when the boss can see the branch is still behind. One
 * implementation, so the two cannot disagree about what "behind" means.
 */

export interface BaseHead {
  baseRef: string;
  sha: string;
}

type GitIn = ReturnType<typeof sandboxGit>;

/** Where a project's base branch points now. Nothing group-specific in it. */
export async function remoteBaseHead(ctx: Ctx, repo: string, projectId: number): Promise<BaseHead | null> {
  const baseRef = await baseRefFor(ctx, projectId);
  const branch = baseRef.startsWith("origin/") ? baseRef.slice("origin/".length) : baseRef;
  const head = await ctx.gh?.request(
    "GET",
    `/repos/${repo}/branches/${branch}`,
    z.object({ commit: z.object({ sha: z.string().optional() }).optional() }),
  );
  const sha = head?.ok ? (head.data?.commit?.sha ?? "") : "";
  return sha ? { baseRef, sha } : null;
}

async function knowsCommit(git: GitIn, sha: string): Promise<boolean> {
  if ((await git(["cat-file", "-e", `${sha}^{commit}`], WORK)).code === 0) return true;
  if ((await git(["fetch", "--quiet", "origin"], WORK)).code !== 0) return false;
  return (await git(["cat-file", "-e", `${sha}^{commit}`], WORK)).code === 0;
}

/**
 * Commits on the base this branch lacks, and commits here the base lacks.
 *
 * `behind === 0` is what `merge-base --is-ancestor` used to answer, and this
 * costs the same one exec — so it replaces that check rather than sitting next
 * to it. Null when git could not answer: an unknown sha, a clone mid-rebase.
 */
async function baseDistance(git: GitIn, sha: string): Promise<{ ahead: number; behind: number } | null> {
  const r = await git(["rev-list", "--left-right", "--count", `${sha}...HEAD`], WORK);
  const m = /^(\d+)\s+(\d+)/.exec(r.out.trim());
  if (r.code !== 0 || !m) return null;
  return { behind: Number(m[1]), ahead: Number(m[2]) };
}

/** A rebase nudge already queued and not yet taken. */
export async function conflictPending(ctx: Ctx, grpId: number): Promise<boolean> {
  const [row] = await ctx.db
    .select({ id: job.id })
    .from(job)
    .where(
      and(
        eq(job.grp_id, grpId),
        eq(job.state, "pending"),
        eq(job.kind, "agent_turn"),
        // Containment rather than a LIKE over the serialisation: the column is jsonb.
        sql`${job.payload_json} @> '{"conflict":true}'::jsonb`,
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Tell the Engineer to rebase before anything else.
 *
 * One sentence for the three places that say it — the base moved under a
 * running group, another group merged ahead of a queued one, GitHub called
 * the PR conflicting — so the watchdog's `conflictPending` sees one queued turn.
 * Enqueue first, record after: `rebase_seen` is the claim that this movement
 * was handled, and a throw between the two left the claim with no nudge sent.
 * No sha, no claim: the next tick measures it.
 */
export async function queueRebase(
  ctx: Ctx,
  grpId: number,
  { baseRef, sha }: { baseRef: string; sha?: string },
  { rotate, why, tail, now = Date.now }: { rotate?: boolean; why?: string; tail?: string; now?: () => number } = {},
): Promise<void> {
  const remoteBranch = baseRef.startsWith("origin/") ? baseRef.slice("origin/".length) : null;
  const fetchStep = remoteBranch ? `\`git fetch origin ${remoteBranch}\` then ` : "";
  const cause = why ?? `${baseRef} moved to ${(sha ?? "").slice(0, 8)} and this branch is behind it`;
  await ctx.sched.enqueue("agent_turn", {
    grp_id: grpId,
    priority: 4,
    payload: {
      role: roleFor(ctx, "write_code"),
      conflict: true,
      ...(rotate ? { rotate: true } : {}),
      rejection:
        `${cause}. Rebase before anything else — ${fetchStep}\`git rebase ${baseRef}\`, then carry on. ` +
        `If ${baseRef} removed or reshaped something this slice was built on, STOP and say which premise is gone ` +
        `with \`orch ask-boss\`; that reaches the Architect.` +
        (tail ? `\n${tail}` : ""),
    },
  });
  if (sha) await ctx.db.update(grp).set({ rebase_seen: sha, rebase_seen_at: now() }).where(eq(grp.id, grpId));
}

/** Measure and record; null when the clone could not answer. */
export async function recordDistance(
  ctx: Ctx,
  grpId: number,
  head: BaseHead,
): Promise<{ ahead: number; behind: number } | null> {
  const git = sandboxGit(ctx, { grp: grpId });
  if (!(await knowsCommit(git, head.sha))) return null;
  const d = await baseDistance(git, head.sha);
  if (d) await ctx.db.update(grp).set({ base_ahead: d.ahead, base_behind: d.behind }).where(eq(grp.id, grpId));
  return d;
}
