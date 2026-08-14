import type { Ctx } from "../api.ts";
import { say } from "../lang.ts";
import { squashWip } from "./worktree.ts";
import { baseRefFor, publishBranch, sandboxGit } from "./checkout.ts";
import { WORK } from "./sandbox.ts";

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

/** `gh` is missing, as an exit code rather than an exception. 127 is the shell's. */
export const GH_MISSING = 127;

export function makeGhRunner(): GhRunner {
  return async (argv, cwd) => {
    let p;
    try {
      p = Bun.spawn(["gh", ...argv], { cwd, stdout: "pipe", stderr: "pipe" });
    } catch {
      // Bun.spawn throws on a missing binary, so without this a machine without
      // `gh` crashes project registration instead of being told to install it.
      return { code: GH_MISSING, out: "gh is not installed: `brew install gh`, then `gh auth login`" };
    }
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
  /** Under the repo write lock: a push writes refs. */
  git: (repo: string, argv: string[], cwd?: string) => Promise<{ code: number; out: string }>;
  repo: string;
  grpId: number;
  title: string;
  body: string;
}

/** Open the PR once the audit passes. Returns its number, or null with a reason. */
export async function openPr(input: OpenPrInput): Promise<{ number: number } | { error: string }> {
  const { ctx, gh, git, grpId } = input;
  const grp = ctx.db
    .query<{ branch: string | null; pr_number: number | null; project_id: number }, [number]>(
      "SELECT branch, pr_number, project_id FROM grp WHERE id = ?",
    )
    .get(grpId);
  if (!grp?.branch) return { error: "group has no branch" };
  if (grp.pr_number) {
    // Already open, so this is a retry after rework: refresh what the PR says
    // rather than leaving a description written before the last three slices.
    await gh(["pr", "edit", String(grp.pr_number), "--title", input.title, "--body", input.body], input.repo);
    return { number: grp.pr_number };
  }

  const scope = { grp: grpId } as const;
  const sandbox = sandboxGit(ctx, scope);

  // Every turn left a `wip:` commit behind. Squash before publishing, or the PR
  // is a dozen commits all called "wip: engineer turn".
  const sq = await squashWip(sandbox, WORK, WORK, `${input.title}\n\n${input.body}`);
  ctx.bus.emit({
    grpId,
    author: "orchestrator",
    kind: "commit",
    body: sq.squashed ? `squashed ${sq.reason}` : `no squash (${sq.reason})`,
  });

  // Out of the sandbox as a bundle, then pushed from here. The sandbox has no
  // credential that can write to the remote — see publishBranch for why that is
  // deliberate rather than an oversight.
  const moved = await publishBranch(ctx, scope, git, input.repo, grp.branch, await baseRefFor(ctx, grp.project_id));
  if (!moved.ok) return { error: `could not take ${grp.branch} out of the sandbox: ${moved.reason}` };

  const pushed = await git(input.repo, ["push", "-u", "origin", grp.branch]);
  if (pushed.code !== 0) {
    return { error: `could not push ${grp.branch}: ${pushed.out.split("\n").slice(-3).join("\n")}` };
  }

  const push = await gh(
    ["pr", "create", "--head", grp.branch, "--fill-first", "--title", input.title, "--body", input.body],
    input.repo,
  );
  if (push.code !== 0) return { error: push.out.split("\n").slice(-3).join("\n") };

  const view = await gh(["pr", "view", grp.branch, "--json", "number"], input.repo);
  let number = 0;
  try {
    number = JSON.parse(view.out).number ?? 0;
  } catch {}
  if (!number) return { error: `opened, but could not read its number: ${view.out.slice(0, 200)}` };

  ctx.db.run("UPDATE grp SET pr_number = ? WHERE id = ?", [number, grpId]);
  ctx.bus.emit({
    grpId,
    author: "orchestrator",
    kind: "state_change",
    body: say(ctx.config?.language, "pr.opened", { n: number }),
  });
  return { number };
}

/**
 * The PR description, built from the record rather than asked for.
 *
 * It used to be one hardcoded sentence — "Opened by the orchestrator after the
 * audit passed" — which reads as an agent that could not be bothered, and it
 * throws away everything the reviewer needs: what was asked for, what each slice
 * promised, which gates ran, why the decisions went the way they did. All of it
 * is already in the database by the time a PR opens, so asking a model to write
 * it would be paying for a SELECT — and a prompt that can be forgotten.
 *
 * Labels are English (PR bodies always are); the quoted material stays in the
 * language it was written in.
 */
export function prBody(ctx: Ctx, grpId: number): string {
  const q = <T,>(sql: string, ...p: unknown[]): T[] => (ctx.db.query(sql) as any).all(...p) as T[];
  const out: string[] = [];

  const idea = q<{ body: string }>(
    "SELECT body FROM event WHERE grp_id = ? AND kind = 'boss_say' ORDER BY seq LIMIT 1",
    grpId,
  )[0];
  if (idea) out.push(`## Asked for\n\n${idea.body.trim().slice(0, 1000)}`);

  const slices = q<{ seq: number; title: string; accept_spec: string; gates_json: string }>(
    "SELECT seq, title, accept_spec, gates_json FROM slice WHERE grp_id = ? ORDER BY seq",
    grpId,
  );
  if (slices.length) {
    const lines = slices.map((s) => {
      let gates: Record<string, string> = {};
      try {
        gates = JSON.parse(s.gates_json);
      } catch {}
      const passed = Object.entries(gates)
        .filter(([, v]) => v === "pass")
        .map(([k]) => k);
      return (
        `- **S${s.seq} ${s.title}**\n` +
        `  - acceptance: ${s.accept_spec.replace(/\s*\n\s*/g, " / ").slice(0, 300)}\n` +
        `  - gates: ${passed.length ? passed.join(", ") + " pass" : "none recorded"}`
      );
    });
    out.push(`## Slices (${slices.length}, all accepted)\n\n${lines.join("\n")}`);
  }

  const decisions = q<{ body: string; export_path: string | null }>(
    "SELECT body, export_path FROM note WHERE grp_id = ? AND kind = 'decision' ORDER BY id",
    grpId,
  );
  if (decisions.length) {
    const lines = decisions.map((d) => {
      const first = d.body.trim().split("\n")[0]!.slice(0, 200);
      return d.export_path ? `- [${first}](${d.export_path})` : `- ${first}`;
    });
    out.push(`## Decisions\n\n${lines.join("\n")}`);
  }

  const retro = q<{ body: string }>(
    "SELECT body FROM note WHERE grp_id = ? AND kind = 'retro' ORDER BY id DESC LIMIT 1",
    grpId,
  )[0];
  if (retro) out.push(`## Retro\n\n${retro.body.trim().slice(0, 2000)}`);

  const g = q<{ name: string; branch: string | null; spent_tokens: number }>(
    "SELECT name, branch, spent_tokens FROM grp WHERE id = ?",
    grpId,
  )[0];
  if (g) {
    out.push(
      `---\n\`${g.branch ?? "?"}\` · ${slices.length} slice(s) · ${g.spent_tokens} tokens · ` +
        `journals in \`docs/journal/${g.name}/\``,
    );
  }
  return out.join("\n\n");
}

export interface Feedback {
  grpId: number;
  prNumber: number;
  comments: Array<{ author: string; body: string; at: number }>;
  failingChecks: string[];
  /** GitHub says it is in main. The group winds itself up; nobody clicks anything. */
  merged?: boolean;
  /** Closed without merging. The group stops and leaves the queue rather than block it. */
  closed?: boolean;
  /** …and open again. Same round trip, backwards. */
  reopened?: boolean;
  /**
   * The branch no longer merges cleanly.
   *
   * Nothing watched for this, so a PR that went stale just sat there: the group
   * was PR_OPEN, its queue empty, and the only way anyone found out was the boss
   * opening GitHub. Rebasing is the Engineer's job, not the PM's.
   */
  conflicting?: boolean;
}

/**
 * Poll every open PR for things said or broken since we last looked.
 *
 * Only a change wakes the PM. Re-reading the same review comment every 30
 * seconds would be a turn each time, which is how a quiet PR becomes expensive.
 */
export async function pollPrs(ctx: Ctx, gh: GhRunner): Promise<Feedback[]> {
  // `gh` needs a checkout to infer the repository from; the host's own is the
  // only one left, and every group's PR lives in it.
  const repo =
    ctx.db.query<{ repo_path: string }, []>("SELECT repo_path FROM project ORDER BY id LIMIT 1").get()
      ?.repo_path ?? process.cwd();
  const groups = ctx.db
    .query<
      {
        id: number;
        pr_number: number | null;
        status: string;
        pr_seen_at: number;
        pr_checks_sig: string | null;
      },
      []
    >(
      // Every group that has a PR, whatever state it is in now. PAUSED is here for
      // `closed` below — a group stopped on a closed PR is waiting for it to come
      // back, and nothing else looks at GitHub. RUNNING is here because a group can
      // be knocked back out of PR_OPEN (an Auditor send-back, a review comment)
      // while its PR is still live and still mergeable: grp16's PR merged in that
      // window, nobody was watching, and it stayed RUNNING for hours hiring turns
      // for a branch already byte-identical to main. A pr_number is the thing worth
      // polling on; the status is not.
      `SELECT id, status, pr_number, pr_seen_at, pr_checks_sig FROM grp
       WHERE status != 'DISSOLVED' AND pr_number IS NOT NULL`,
    )
    .all();

  const out: Feedback[] = [];
  for (const g of groups) {
    const r = await gh(
      ["pr", "view", String(g.pr_number), "--json", "state,mergeable,comments,reviews,statusCheckRollup"],
      repo,
    );
    if (r.code !== 0) continue;

    let parsed: any = {};
    try {
      parsed = JSON.parse(r.out);
    } catch {
      continue;
    }

    const state = String(parsed.state ?? "").toUpperCase();

    // Closed without merging, and reopened again: both are the boss acting on
    // GitHub, which is the only place a PR can be closed. Neither used to be
    // looked at, so a closed PR left its group at PR_OPEN holding the head of a
    // strictly serial merge queue — everything behind it stopped, permanently,
    // and the only trace was the PR page nobody was watching.
    // Merged is news that outranks every comment on the PR, and it is the one
    // thing the boss should not have to come back and confirm by hand. It also
    // outranks the group's own status: the branch landed, so the group is finished
    // whatever it was knocked back to in the meantime. Gating this on PR_OPEN, the
    // way the two cases below are, is what left grp16 running forever on work that
    // was already in main.
    if (state === "MERGED") {
      out.push({ grpId: g.id, prNumber: g.pr_number!, comments: [], failingChecks: [], merged: true });
      continue;
    }
    if (state === "CLOSED" && g.status === "PR_OPEN") {
      out.push({ grpId: g.id, prNumber: g.pr_number!, comments: [], failingChecks: [], closed: true });
      continue;
    }
    if (state === "OPEN" && g.status === "PAUSED") {
      out.push({ grpId: g.id, prNumber: g.pr_number!, comments: [], failingChecks: [], reopened: true });
      continue;
    }
    if (g.status !== "PR_OPEN") continue;

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

    // A conflict is news exactly like a red check is, and it goes through the same
    // signature so a stale branch does not wake the group every thirty seconds.
    const conflicting = String(parsed.mergeable ?? "").toUpperCase() === "CONFLICTING";
    const sig = [...failingChecks, ...(conflicting ? ["merge conflict"] : [])].sort().join(",");
    const checksChanged = sig !== (g.pr_checks_sig ?? "");
    if (comments.length === 0 && !checksChanged) continue;

    const newest = comments.reduce((n, c) => Math.max(n, c.at), g.pr_seen_at);
    ctx.db.run("UPDATE grp SET pr_seen_at = ?, pr_checks_sig = ? WHERE id = ?", [newest, sig, g.id]);
    out.push({
      grpId: g.id,
      prNumber: g.pr_number!,
      comments,
      failingChecks: checksChanged ? failingChecks : [],
      conflicting,
    });
  }
  return out;
}

/** Hand PR feedback to the PM: replying to a review needs judgement, polling does not. */
export function dispatchFeedback(ctx: Ctx, f: Feedback): void {
  const lines = [
    ...f.comments.map((c) => `${c.author}: ${c.body}`),
    ...(f.failingChecks.length ? [`failing checks: ${f.failingChecks.join(", ")}`] : []),
    ...(f.conflicting ? ["the branch no longer merges cleanly into main"] : []),
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
  // A conflict is work, not a judgement call: the PM would only forward it. Reading
  // a review and deciding what to concede is the PM's; `git rebase` is not.
  ctx.sched.enqueue("agent_turn", {
    grp_id: f.grpId,
    payload: f.conflicting
      ? {
          role: "engineer",
          rotate: true,
          // The fork in the road, stated, because no check here can tell the two
          // apart: a textual clash is this turn's work, and a premise that no
          // longer holds is a design question the Architect owns.
          conflict: true,
          rejection:
            `PR #${f.prNumber} no longer merges into main. Rebase onto it before anything else:\n` +
            `\`git fetch origin main\` then \`git rebase origin/main\`, resolve every conflict, re-run the ` +
            `gates, and stop there — the orchestrator takes the branch from your checkout and pushes it, ` +
            `so do not look for a way to push. Keep both sides' intent — main moved for a reason and so ` +
            `did this branch.\n\n` +
            `If main removed or reshaped something this slice was built on, STOP — do not invent a way to ` +
            `keep compiling. Say which premise is gone with \`orch ask-boss\`; that reaches the Architect, ` +
            `who decides whether this slice still makes sense. Guessing produces code that builds and is ` +
            `pointed the wrong way, which nothing downstream can catch.\n${lines}`,
        }
      : { role: "pm", rejection: `PR #${f.prNumber} feedback:\n${lines}` },
  });
  ctx.sched.tick();
}

export interface Preflight {
  ok: boolean;
  remote: string | null;
  reason?: string;
}

/**
 * Can this project open a PR at all?
 *
 * Checked at registration rather than discovered when a branch is finished. A
 * group that has done all its work and then has nowhere to put it is the worst
 * moment to find out, and the fix (add a remote, log in) is the boss's to make.
 */
export async function preflightPr(
  repoPath: string,
  run: (argv: string[], cwd: string) => Promise<GhRun>,
  gh: GhRunner,
): Promise<Preflight> {
  const remote = await run(["remote", "get-url", "origin"], repoPath);
  if (remote.code !== 0 || !remote.out.trim()) {
    return { ok: false, remote: null, reason: "no `origin` remote: a PR has nowhere to go" };
  }
  const url = remote.out.trim().split("\n")[0]!;
  if (!/github\.com/i.test(url)) {
    return { ok: false, remote: url, reason: `origin is not GitHub (${url}); \`gh pr create\` will not work` };
  }
  const auth = await gh(["auth", "status"], repoPath);
  if (auth.code === GH_MISSING) return { ok: false, remote: url, reason: auth.out };
  if (auth.code !== 0) {
    return { ok: false, remote: url, reason: "gh is not logged in: run `gh auth login`" };
  }

  // Auth is not permission. A read-only token, or a repo you can only fork, gets
  // past `auth status` and then fails at `git push` — after a group has done all
  // its work. This is the last thing checkable without writing anything.
  const perm = await gh(["repo", "view", "--json", "viewerPermission"], repoPath);
  if (perm.code === 0) {
    let level = "";
    try {
      level = String(JSON.parse(perm.out).viewerPermission ?? "");
    } catch {}
    if (level && !["ADMIN", "MAINTAIN", "WRITE"].includes(level)) {
      return {
        ok: false,
        remote: url,
        reason: `no push access to ${url} (your permission is ${level}); the branch could not be pushed`,
      };
    }
  }
  return { ok: true, remote: url };
}
