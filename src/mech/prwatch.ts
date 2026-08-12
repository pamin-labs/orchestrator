import type { Ctx } from "../api.ts";

/**
 * The PR as a feedback channel.
 *
 * Deliberately not an agent: "has anything been said since we last looked" is a
 * comparison of timestamps, and paying a model to make it would be paying for
 * arithmetic. What needs judgement is the reply, and that goes to the PM.
 */

export interface GhRun {
  code: number;
  out: string;
}
export type GhRunner = (argv: string[], cwd: string) => Promise<GhRun>;

export function makeGhRunner(): GhRunner {
  return async (argv, cwd) => {
    const p = Bun.spawn(["gh", ...argv], { cwd, stdout: "pipe", stderr: "pipe" });
    const [so, se] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    return { code: await p.exited, out: (so + se).trim() };
  };
}

export interface OpenPrInput {
  ctx: Ctx;
  gh: GhRunner;
  grpId: number;
  title: string;
  body: string;
}

/** Open the PR once the audit passes. Returns its number, or null with a reason. */
export async function openPr(input: OpenPrInput): Promise<{ number: number } | { error: string }> {
  const { ctx, gh, grpId } = input;
  const grp = ctx.db
    .query<{ worktree: string | null; branch: string | null; pr_number: number | null }, [number]>(
      "SELECT worktree, branch, pr_number FROM grp WHERE id = ?",
    )
    .get(grpId);
  if (!grp?.worktree || !grp.branch) return { error: "group has no worktree or branch" };
  if (grp.pr_number) return { number: grp.pr_number };

  const push = await gh(["pr", "create", "--fill-first", "--title", input.title, "--body", input.body], grp.worktree);
  if (push.code !== 0) return { error: push.out.split("\n").slice(-3).join("\n") };

  const view = await gh(["pr", "view", "--json", "number"], grp.worktree);
  let number = 0;
  try {
    number = JSON.parse(view.out).number ?? 0;
  } catch {}
  if (!number) return { error: `opened, but could not read its number: ${view.out.slice(0, 200)}` };

  ctx.db.run("UPDATE grp SET pr_number = ? WHERE id = ?", [number, grpId]);
  ctx.bus.emit({ grpId, author: "orchestrator", kind: "state_change", body: `PR #${number} opened` });
  return { number };
}

export interface Feedback {
  grpId: number;
  prNumber: number;
  comments: Array<{ author: string; body: string; at: number }>;
  failingChecks: string[];
}

/**
 * Poll every open PR for things said or broken since we last looked.
 *
 * Only a change wakes the PM. Re-reading the same review comment every 30
 * seconds would be a turn each time, which is how a quiet PR becomes expensive.
 */
export async function pollPrs(ctx: Ctx, gh: GhRunner): Promise<Feedback[]> {
  const groups = ctx.db
    .query<
      {
        id: number;
        worktree: string | null;
        pr_number: number | null;
        pr_seen_at: number;
        pr_checks_sig: string | null;
      },
      []
    >(
      `SELECT id, worktree, pr_number, pr_seen_at, pr_checks_sig FROM grp
       WHERE status = 'PR_OPEN' AND pr_number IS NOT NULL`,
    )
    .all();

  const out: Feedback[] = [];
  for (const g of groups) {
    if (!g.worktree) continue;
    const r = await gh(
      ["pr", "view", String(g.pr_number), "--json", "comments,reviews,statusCheckRollup"],
      g.worktree,
    );
    if (r.code !== 0) continue;

    let parsed: any = {};
    try {
      parsed = JSON.parse(r.out);
    } catch {
      continue;
    }

    const raw = [...(parsed.comments ?? []), ...(parsed.reviews ?? [])];
    const comments = raw
      .map((c: any) => ({
        author: c.author?.login ?? c.user?.login ?? "?",
        body: String(c.body ?? "").slice(0, 1000),
        at: Date.parse(c.createdAt ?? c.submittedAt ?? "") || 0,
      }))
      .filter((c) => c.body && c.at > g.pr_seen_at);

    const failingChecks = (parsed.statusCheckRollup ?? [])
      .filter((c: any) => ["FAILURE", "ERROR", "TIMED_OUT"].includes(c.conclusion ?? c.state))
      .map((c: any) => String(c.name ?? c.context ?? "check"));

    // A check that stays red is one piece of news, not one per poll.
    const sig = failingChecks.slice().sort().join(",");
    const checksChanged = sig !== (g.pr_checks_sig ?? "");
    if (comments.length === 0 && !checksChanged) continue;

    const newest = comments.reduce((n, c) => Math.max(n, c.at), g.pr_seen_at);
    ctx.db.run("UPDATE grp SET pr_seen_at = ?, pr_checks_sig = ? WHERE id = ?", [newest, sig, g.id]);
    out.push({
      grpId: g.id,
      prNumber: g.pr_number!,
      comments,
      failingChecks: checksChanged ? failingChecks : [],
    });
  }
  return out;
}

/** Hand PR feedback to the PM: replying to a review needs judgement, polling does not. */
export function dispatchFeedback(ctx: Ctx, f: Feedback): void {
  const lines = [
    ...f.comments.map((c) => `${c.author}: ${c.body}`),
    ...(f.failingChecks.length ? [`failing checks: ${f.failingChecks.join(", ")}`] : []),
  ].join("\n");

  ctx.bus.emit({
    grpId: f.grpId,
    author: "pr-watcher",
    kind: "say",
    intent: "request",
    body: `PR #${f.prNumber} has feedback:\n${lines}`.slice(0, 2000),
    meta: { pr: f.prNumber, comments: f.comments.length, failingChecks: f.failingChecks },
  });
  ctx.db.run("UPDATE grp SET status = 'RUNNING' WHERE id = ? AND status = 'PR_OPEN'", [f.grpId]);
  ctx.sched.enqueue("agent_turn", {
    grp_id: f.grpId,
    payload: { role: "pm", rejection: `PR #${f.prNumber} feedback:\n${lines}` },
  });
  ctx.sched.tick();
}
