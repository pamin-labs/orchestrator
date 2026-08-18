import type { SQLQueryBindings } from "bun:sqlite";
import { activeTracer } from "../../platform/observability/traces.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../platform/config/load.ts";
import { gitTrailers } from "./ghlogin.ts";
import type { Ctx } from "../../mech/ctx.ts";
import type { DB } from "../../platform/persistence/database.ts";
import { say } from "../../platform/text/lang.ts";
import { squashWip } from "./worktree.ts";
import { baseBranch, pushBranch, sandboxGit } from "./checkout.ts";
import type { Github } from "./github.ts";
import { pages } from "./paging.ts";
import { parseRepo } from "../../contracts/repository.ts";
import { WORK } from "../sandbox/sandbox.ts";
import { jsonOr } from "../../contracts/json.ts";
import pMap from "p-map";
import { z } from "zod";
import type { GrpState } from "../../contracts/states.ts";

const GateResults = z.record(z.string(), z.string());
const PullNumber = z.object({ number: z.number().int().positive() });
const PackageVersion = z.object({ version: z.string() });

/**
 * The PR as a feedback channel.
 *
 * Deliberately not an agent: "has anything been said since we last looked" is a
 * comparison of timestamps, and paying a model to make it would be paying for
 * arithmetic. What needs judgement is the reply, and that goes to the PM.
 *
 * GitHub is reached over REST rather than by shelling out to `gh` (007): one
 * fewer host binary, one fewer separate login, and the failure buckets in
 * `github.ts` instead of an exit code.
 */

/**
 * `owner/repo`, from the remote stored at registration.
 *
 * SEAM (007 step 2): `project.repo_path` is still a host filesystem path and
 * `project.remote` is still whatever `git remote get-url origin` printed. When
 * the schema changes to hold `owner/repo` directly, this function is the only
 * thing that changes — everything below already speaks `owner/repo`.
 */
function repoSlug(db: DB, projectId: number): string | null {
  const p = db.query<{ remote: string | null }, [number]>("SELECT remote FROM project WHERE id = ?").get(projectId);
  return p?.remote ? parseRepo(p.remote) : null;
}

export interface OpenPrInput {
  ctx: Ctx;
  gh: Github;
  grpId: number;
  title: string;
  body: string;
}

/** Open the PR once the audit passes. Returns its number, or null with a reason. */
export async function openPr(input: OpenPrInput): Promise<{ number: number } | { error: string }> {
  const { ctx, gh, grpId } = input;
  const grp = ctx.db
    .query<{ branch: string | null; pr_number: number | null; project_id: number }, [number]>(
      "SELECT branch, pr_number, project_id FROM grp WHERE id = ?",
    )
    .get(grpId);
  if (!grp?.branch) return { error: "group has no branch" };
  const slug = repoSlug(ctx.db, grp.project_id);
  if (!slug) return { error: "project has no GitHub remote: a PR has nowhere to go" };

  if (grp.pr_number) {
    // Already open, so this is a retry after rework: refresh what the PR says
    // rather than leaving a description written before the last three slices.
    const updated = await gh.request("PATCH", `/repos/${slug}/pulls/${grp.pr_number}`, PullNumber, {
      title: input.title,
      body: input.body,
    });
    return updated.ok ? { number: updated.data.number } : { error: updated.message };
  }

  const scope = { grp: grpId } as const;
  const sandbox = sandboxGit(ctx, scope);

  // Every turn left a `wip:` commit behind. Squash before publishing, or the PR
  // is a dozen commits all called "wip: engineer turn".
  //
  // The commit gets the Scribe's message, not the PR body. They were the same
  // string, so `git log` in the merged repository carried `## Slices (3, all
  // accepted)`, a gate table and `Opened by orchestrator` — a description
  // written for a review page, pasted into the one place that outlives it.
  const sq = await squashWip(sandbox, WORK, WORK, commitMessage(ctx.db, grpId, input.title), gitTrailers(ctx.db));
  ctx.bus.emit({
    grpId,
    author: "orchestrator",
    kind: "commit",
    body: sq.squashed ? `squashed ${sq.reason}` : `no squash (${sq.reason})`,
  });

  // The seam that used to be here is gone with 007 step 5. Two different things
  // were called "repo": a path on this host (git's) and `owner/repo` (GitHub's),
  // read from two columns that could disagree — so a checkout whose `origin` was
  // not the stored remote pushed the branch to one repository and opened the PR
  // on another. There is one answer now, and it is the stored remote.
  //
  // Out of the group's container as a bundle, onto the remote from the utility
  // container. The group still holds no credential that can write there; see
  // `readOnlyGitPaths` for what enforces that and what it does not.
  const pushed = await pushBranch(ctx, grpId);
  if (!pushed.ok) return { error: `could not push ${grp.branch}: ${pushed.reason}` };

  const created = await gh.request("POST", `/repos/${slug}/pulls`, PullNumber, {
    title: input.title,
    body: input.body,
    head: grp.branch,
    base: await baseBranch(ctx, grp.project_id),
  });
  // The create answer carries the number, so the second call `gh` needed is gone.
  // It comes back for one case: a 422 saying a PR for this head already exists,
  // which is what a retry after a half-finished attempt looks like.
  // The response schema owns the required number. A 200 with an empty body is a
  // handled invalid-response failure, not a route-level TypeError.
  let number = created.ok ? created.data.number : 0;
  if (!created.ok) {
    const owner = slug.split("/")[0]!;
    const found = await gh.request(
      "GET",
      `/repos/${slug}/pulls?state=open&head=${owner}:${encodeURIComponent(grp.branch)}`,
      z.array(z.object({ number: z.number().int().positive() })),
    );
    if (found.ok) number = found.data[0]?.number ?? 0;
    if (!number) return { error: created.message };
  }
  if (!number) return { error: "opened, but GitHub's answer had no PR number in it" };

  ctx.db.run("UPDATE grp SET pr_number = ? WHERE id = ?", [number, grpId]);
  ctx.bus.emit({
    grpId,
    author: "orchestrator",
    kind: "state_change",
    body: say(ctx.config.language, "pr.opened", { n: number }),
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
/** Ours, for the line every pull request carries. */
const PROJECT_URL = "https://github.com/pamin-labs/orchestrator";

/**
 * Which version opened it.
 *
 * Read from package.json rather than kept as a constant, because a constant is a
 * second place to remember on release day and the one that gets forgotten. A
 * reviewer looking at a diff this produced, or at a bug report about one, needs
 * to know which build it came from — "opened by orchestrator" alone dates
 * nothing.
 */
function version(): string {
  try {
    return jsonOr(readFileSync(join(ROOT, "package.json"), "utf8"), PackageVersion.nullable(), null)?.version ?? "";
  } catch {
    return "";
  }
}

/**
 * The commit convention, as an `if`.
 *
 * Every rule here is one the Scribe's prompt states, and the prompt lists these
 * four refusals by name. That is not decoration: a prompt that permits what the
 * validator rejects teaches the model to write something that will be thrown
 * away, and it finds out at the end of the only turn it gets.
 */
const TYPES = ["feat", "fix", "docs", "test", "refactor", "perf", "build", "chore"] as const;
// fallow-ignore-next-line security-sink -- the only interpolation is `TYPES`, a module-level `as const` tuple of eight literals; no PR title or body reaches the pattern (they are the `test` arguments below).
const SUBJECT = new RegExp(`^(${TYPES.join("|")})(\\([a-z0-9._/-]+\\))?: \\S`);
// CJK, kana and hangul. Not a general "is this English" test — it cannot be one
// — but it catches the thing that actually happens: the panel's language is
// Chinese, the journals are Chinese, and the message written next to them comes
// out Chinese too.
const NOT_ENGLISH = /[぀-ヿ㐀-鿿가-힯]/;

/** Null when the message may be published, otherwise what to fix. */
export function checkPrMessage(title: string, body: string): string | null {
  const t = title.trim();
  if (!SUBJECT.test(t)) return `title needs a type prefix: ${TYPES.join("|")}, then an optional (scope), then ": "`;
  if (t.length > 72) return `title is ${t.length} characters and 72 is the cap`;
  if (t.endsWith(".")) return "title does not end in a full stop";
  if (NOT_ENGLISH.test(t) || NOT_ENGLISH.test(body)) return "commits and pull requests are English, always";
  if (body.trim().length < 20) return "the body says what the failure looked like, and one line is not that";
  return null;
}

/**
 * The subject the commit and the pull request share.
 *
 * `orch: <group name>` was the title of every pull request this project has ever
 * opened — a slug the dispatcher invented before any code existed, identical
 * across four PRs in one release, which is why release notes filed all of them
 * under "other". It is still the fallback, because a branch that is finished
 * must be publishable whatever happened to the Scribe's turn, but it is now the
 * mark of a message nobody wrote rather than the normal case.
 */
/**
 * What the squashed commit says. Subject, blank line, the Scribe's body.
 *
 * With no body it stays one line, which is the right shape for a commit nobody
 * described — better than pasting the pull request's headings into a log.
 */
export function commitMessage(db: DB, grpId: number, title: string): string {
  const summary = db
    .query<{ pr_summary: string | null }, [number]>("SELECT pr_summary FROM grp WHERE id = ?")
    .get(grpId)?.pr_summary;
  return summary?.trim() ? `${title}\n\n${summary.trim()}` : title;
}

export function prTitle(db: DB, grpId: number): string {
  const g = db
    .query<{ name: string; pr_title: string | null }, [number]>("SELECT name, pr_title FROM grp WHERE id = ?")
    .get(grpId);
  return g?.pr_title?.trim() || `orch: ${g?.name ?? "changes"}`;
}

export function prBody(db: DB, grpId: number): string {
  // One row shape per call and always the same bindings, so only the first type
  // argument is worth writing. It used to take `unknown[]` and cast twice to get
  // there, which threw away what `db.query` already declares.
  const q = <T>(sql: string, ...p: SQLQueryBindings[]): T[] => db.query<T, SQLQueryBindings[]>(sql).all(...p);
  const out: string[] = [];

  // The Scribe's, and first, because it is the only part written by something
  // that read the diff. Everything below is the record: true, assembled from the
  // database, and unable to say what the change actually does.
  const summary = q<{ pr_summary: string | null }>("SELECT pr_summary FROM grp WHERE id = ?", grpId)[0]?.pr_summary;
  if (summary?.trim()) out.push(summary.trim());

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
      const passed = Object.entries(jsonOr(s.gates_json, GateResults, {}))
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
  // Said once, at the bottom, because a reviewer deciding whether to trust this
  // diff should know what produced it — and because a pull request that hides it
  // is the kind of thing that gets a project banned from a repository rather
  // than asked about. One line, no badge.
  const v = version();
  out.push(`Opened by [orchestrator](${PROJECT_URL})${v ? ` v${v}` : ""}.`);
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
 * What REST answers with, where it differs from what `gh` answered with.
 *
 * `gh` returns a GraphQL projection: `state: MERGED`, `mergeable: CONFLICTING`,
 * `author.login`, `createdAt`, and a `statusCheckRollup` that does not exist as
 * an endpoint. REST returns the underlying records, and the mapping between them
 * is where the bugs would be, so the shapes are written down.
 */
const PullRest = z.object({
  state: z.string().optional(),
  merged: z.boolean().optional(),
  /** true / false / **null while GitHub is still computing it**. */
  mergeable: z.boolean().nullable().optional(),
  mergeable_state: z.string().optional(),
  head: z.object({ sha: z.string() }),
});
const IssueCommentRest = z.object({
  user: z.object({ login: z.string().optional() }).nullable().optional(),
  body: z.string().optional(),
  created_at: z.string().optional(),
});
const ReviewRest = z.object({
  user: z.object({ login: z.string().optional() }).nullable().optional(),
  body: z.string().optional(),
  submitted_at: z.string().optional(),
});
const CheckRest = z.object({ name: z.string().optional(), conclusion: z.string().nullable().optional() });
const StatusRest = z.object({ context: z.string().optional(), state: z.string().optional() });

/**
 * Poll every open PR for things said or broken since we last looked.
 *
 * Only a change wakes the PM. Re-reading the same review comment every 30
 * seconds would be a turn each time, which is how a quiet PR becomes expensive.
 */
interface WatchedGroup {
  id: number;
  pr_number: number | null;
  status: GrpState;
  pr_seen_at: number;
  pr_checks_sig: string | null;
  remote: string | null;
}

type IssueComment = z.infer<typeof IssueCommentRest>;
type Review = z.infer<typeof ReviewRest>;
type Check = z.infer<typeof CheckRest>;
type Status = z.infer<typeof StatusRest>;

function transitionFeedback(group: WatchedGroup, prNumber: number, state: string): Feedback | null {
  const base = { grpId: group.id, prNumber, comments: [], failingChecks: [] };
  if (state === "MERGED") return { ...base, merged: true };
  if (state === "CLOSED" && group.status === "PR_OPEN") return { ...base, closed: true };
  if (state === "OPEN" && group.status === "PAUSED") return { ...base, reopened: true };
  return null;
}

function newComments(issue: IssueComment[], reviews: Review[], seenAt: number): Feedback["comments"] {
  return [
    ...issue.map((comment) => ({ author: comment.user?.login, body: comment.body, at: comment.created_at })),
    ...reviews.map((review) => ({ author: review.user?.login, body: review.body, at: review.submitted_at })),
  ]
    .map((comment) => ({
      author: comment.author ?? "?",
      body: String(comment.body ?? "").slice(0, 1000),
      at: Date.parse(comment.at ?? "") || 0,
    }))
    .filter((comment) => comment.body && comment.at > seenAt);
}

function failedChecks(checks: Check[], statuses: Status[]): string[] {
  return [
    ...checks.map((check) => ({ name: check.name, result: check.conclusion })),
    ...statuses.map((status) => ({ name: status.context, result: status.state })),
  ]
    .filter((check) => ["FAILURE", "ERROR", "TIMED_OUT"].includes(String(check.result ?? "").toUpperCase()))
    .map((check) => String(check.name ?? "check"));
}

interface PollDetails {
  issue: IssueComment[];
  reviews: Review[];
  checks: Check[];
  statuses: Status[];
}

async function loadPollDetails(
  gh: Github,
  repo: string,
  prNumber: number,
  sha: string,
  since: string,
): Promise<PollDetails | null> {
  // Paged, not a lone `per_page=100`. `/reviews` has no `since` and returns
  // oldest-first, so on a long-lived PR the newest were never read and the PM
  // stopped being woken; `/check-runs` truncated the failures a gate reports.
  const [issue, reviews, runs, statuses] = await Promise.all([
    pages(gh, `/repos/${repo}/issues/${prNumber}/comments?since=${since}`, z.array(IssueCommentRest), (x) => x),
    pages(gh, `/repos/${repo}/pulls/${prNumber}/reviews`, z.array(ReviewRest), (x) => x),
    pages(
      gh,
      `/repos/${repo}/commits/${sha}/check-runs`,
      z.object({ check_runs: z.array(CheckRest).optional() }),
      (x) => x.check_runs ?? [],
    ),
    pages(
      gh,
      `/repos/${repo}/commits/${sha}/status`,
      z.object({ statuses: z.array(StatusRest).optional() }),
      (x) => x.statuses ?? [],
    ),
  ]);
  if (!issue.ok || !reviews.ok || !runs.ok || !statuses.ok) return null;
  return { issue: issue.data, reviews: reviews.data, checks: runs.data, statuses: statuses.data };
}

function changedFeedback(
  db: DB,
  group: WatchedGroup,
  prNumber: number,
  details: PollDetails,
  mergeable: boolean | null | undefined,
  mergeableState: string | undefined,
): Feedback | null {
  const comments = newComments(details.issue, details.reviews, group.pr_seen_at);
  const failingChecks = failedChecks(details.checks, details.statuses);
  const conflicting = mergeable === false || mergeableState === "dirty";
  const signature = [...failingChecks, ...(conflicting ? ["merge conflict"] : [])].sort().join(",");
  const checksChanged = signature !== (group.pr_checks_sig ?? "");
  if (comments.length === 0 && !checksChanged) return null;

  const newest = comments.reduce((value, comment) => Math.max(value, comment.at), group.pr_seen_at);
  db.run("UPDATE grp SET pr_seen_at = ?, pr_checks_sig = ? WHERE id = ?", [newest, signature, group.id]);
  return {
    grpId: group.id,
    prNumber,
    comments,
    failingChecks: checksChanged ? failingChecks : [],
    conflicting,
  };
}

function pollTarget(group: WatchedGroup): { repo: string; prNumber: number } | null {
  if (!group.remote || !group.pr_number) return null;
  const repo = parseRepo(group.remote);
  return repo ? { repo, prNumber: group.pr_number } : null;
}

function pullState(pull: z.infer<typeof PullRest>): string {
  return pull.merged ? "MERGED" : String(pull.state ?? "").toUpperCase();
}

async function pollPr(ctx: Ctx, gh: Github, group: WatchedGroup): Promise<Feedback | null> {
  const target = pollTarget(group);
  if (!target) return null;
  const { repo, prNumber } = target;

  const pull = await gh.request("GET", `/repos/${repo}/pulls/${prNumber}`, PullRest);
  if (!pull.ok) return null;
  const parsed = pull.data;
  const transition = transitionFeedback(group, prNumber, pullState(parsed));
  if (transition) return transition;
  if (group.status !== "PR_OPEN") return null;

  const details = await loadPollDetails(
    gh,
    repo,
    prNumber,
    parsed.head.sha,
    new Date(Math.max(0, group.pr_seen_at)).toISOString(),
  );
  if (!details) return null;
  return changedFeedback(ctx.db, group, prNumber, details, parsed.mergeable, parsed.mergeable_state);
}

export async function pollPrs(ctx: Ctx, gh: Github): Promise<Feedback[]> {
  // Every heartbeat, serially over every group with an open pull request, and
  // five GitHub requests per group. `github.request` times the leaves; this says
  // whether the cost is one slow route or the number of groups.
  return activeTracer().startActiveSpan("pr.poll", async (span) => {
    try {
      return await pollPrsInner(ctx, gh);
    } finally {
      span.end();
    }
  });
}

async function pollPrsInner(ctx: Ctx, gh: Github): Promise<Feedback[]> {
  const groups = ctx.db
    .query<WatchedGroup, []>(
      `SELECT g.id, g.status, g.pr_number, g.pr_seen_at, g.pr_checks_sig, p.remote
       FROM grp g JOIN project p ON p.id = g.project_id
       WHERE g.status != 'DISSOLVED' AND g.pr_number IS NOT NULL`,
    )
    .all();
  // Concurrent, because these are N independent conversations with GitHub and
  // nothing here reads another group's answer. Serially, ten open PRs cost five
  // requests each inside one 30-second tick — about 7.5 seconds of it spent
  // waiting, and that holds even when every one of them is a 304.
  //
  // Capped rather than unbounded: `plugin-throttling` already paces the account's
  // own limits, and a fan-out wider than that only queues inside the library
  // while making the failure of any one of them harder to attribute. The same
  // number the container fan-out uses, for the same reason — a ceiling somebody
  // chose beats a ceiling that happens to be the row count.
  const results = await pMap(groups, (group) => pollPr(ctx, gh, group), { concurrency: PR_FANOUT });
  return results.filter((result): result is Feedback => result !== null);
}

/**
 * How many PRs are polled at once.
 *
 * Four, matching `EXEC_FANOUT`: not derived from anything about GitHub, just a
 * bound small enough that one slow PR does not stall the tick and large enough
 * that ten of them fit inside it.
 */
const PR_FANOUT = 4;

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

/** Report an authenticated token whose repository role still cannot push. */
const PERMISSION_LEVELS = [
  ["admin", "ADMIN"],
  ["maintain", "MAINTAIN"],
  ["push", "WRITE"],
  ["triage", "TRIAGE"],
  ["pull", "READ"],
] as const;
const WRITABLE_LEVELS = new Set(["ADMIN", "MAINTAIN", "WRITE"]);

export function pushBlocked(permissions: Record<string, boolean> | undefined, repo: string): string | null {
  const level = PERMISSION_LEVELS.find(([permission]) => permissions?.[permission])?.[1];
  return level && !WRITABLE_LEVELS.has(level)
    ? `no push access to ${repo} (your permission is ${level}); the branch could not be pushed`
    : null;
}
