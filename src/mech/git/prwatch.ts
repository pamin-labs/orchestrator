import type { SQLQueryBindings } from "bun:sqlite";
import { activeTracer } from "../../platform/observability/traces.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, ROOT } from "../../platform/config/load.ts";
import { gitTrailers } from "./ghlogin.ts";
import { roleFor, type Ctx } from "../../mech/ctx.ts";
import type { DB } from "../../platform/persistence/database.ts";
import { say } from "../../platform/text/lang.ts";
import { squashWip } from "./gitops.ts";
import { baseBranch, pushBranch, sandboxGit } from "./checkout.ts";
import type { Github } from "./github.ts";
import { pages } from "./paging.ts";
import { parseRepo } from "../../contracts/repository.ts";
import { WORK } from "../sandbox/sandbox.ts";
import { jsonOr } from "../../contracts/json.ts";
import pMap from "p-map";
import { z } from "zod";
import type { GrpState } from "../../contracts/states.ts";
import { baseBranchOf } from "../util/rows.ts";

const GateResults = z.record(z.string(), z.string());
const PullNumber = z.object({ number: z.number().int().positive() });
const PackageVersion = z.object({ version: z.string() });

/**
 * The PR as a feedback channel.
 *
 * Deliberately not an agent: "has anything been said since we last looked" is a
 * comparison of timestamps, and paying a model for arithmetic. What needs judgement
 * is the reply, and that goes to the PM.
 *
 * REST rather than shelling out to `gh`: one fewer host binary, one fewer login, and
 * the failure buckets in `github.ts` instead of an exit code.
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
  const sq = await squashWip(
    sandbox,
    WORK,
    commitMessage(ctx.db, grpId, input.title),
    ctx.config.baseBranchFallbacks,
    gitTrailers(ctx.db),
  );
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
 * It used to be one hardcoded sentence, which reads as an agent that could not be
 * bothered and throws away what the reviewer needs: what was asked for, what each
 * slice promised, which gates ran. All of it is already in the database by the time
 * a PR opens, so asking a model would be paying for a SELECT.
 *
 * Labels are English; quoted material stays in its own language.
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
  /**
   * Unresolved line-level review threads: which file, which line, what was said.
   *
   * The thread is the unit because resolution is a property of the thread, not of
   * any one comment in it. Optional because only GraphQL can answer it — see
   * `loadPollDetails`.
   */
  /**
   * `id` is GitHub's node id, and it is here so it can be quoted back: `orch pr
   * resolve` names a thread by it. Without it an agent that fixed what a reviewer
   * asked for had no way to say which thread it fixed, so every one stayed open.
   */
  threads?: Array<{ id: string; path: string; line: number | null; comments: Feedback["comments"] }>;
  /**
   * Which checks are failing, and enough of what they said to act on.
   *
   * The name alone was all the PM got — "failing checks: build" is a fact with no
   * next step in it. `summary` is the check's own `output`, truncated; `url` is
   * where the rest of it is. Neither is in the change signature: a summary that
   * carries a duration or a timestamp would otherwise be news on every tick.
   */
  failingChecks: Array<{ name: string; summary?: string | undefined; url?: string | undefined }>;
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
  /** APPROVED / CHANGES_REQUESTED / COMMENTED / DISMISSED. Both transports carry it or they drift. */
  state: z.string().optional(),
  submitted_at: z.string().optional(),
});
const CheckRest = z.object({
  name: z.string().optional(),
  conclusion: z.string().nullable().optional(),
  details_url: z.string().optional(),
  /** What the gate itself wrote. Both transports carry it or REST and GraphQL drift. */
  output: z
    .object({ title: z.string().nullable().optional(), summary: z.string().nullable().optional() })
    .nullable()
    .optional(),
});
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

/**
 * A verdict is not a comment.
 *
 * `state` was never read, so an approval and a request for changes were the same
 * string to everything downstream. And an approval usually carries no body at all,
 * so the `body` filter below dropped it: the one event a PM waits for was the one
 * event that never arrived.
 */
const VERDICTS: Record<string, string> = {
  APPROVED: "approved this pull request",
  CHANGES_REQUESTED: "requested changes",
  DISMISSED: "had a review dismissed",
};

/** The verdict, then whatever was written under it. A `COMMENTED` review is only the body. */
function reviewBody(review: Review): string {
  return [VERDICTS[String(review.state ?? "").toUpperCase()] ?? "", review.body].filter(Boolean).join(": ");
}

/** Normalised, truncated, and only what was said after the cursor. Both readers below. */
function saidSince(said: Thread["comments"], seenAt: number): Feedback["comments"] {
  return said
    .map((comment) => ({
      author: comment.author ?? "?",
      body: String(comment.body ?? "").slice(0, 1000),
      at: Date.parse(comment.at ?? "") || 0,
    }))
    .filter((comment) => comment.body && comment.at > seenAt);
}

function newComments(issue: IssueComment[], reviews: Review[], seenAt: number): Feedback["comments"] {
  return saidSince(
    [
      ...issue.map((comment) => ({ author: comment.user?.login, body: comment.body, at: comment.created_at })),
      ...reviews.map((review) => ({ author: review.user?.login, body: reviewBody(review), at: review.submitted_at })),
    ],
    seenAt,
  );
}

/**
 * Threads still open, carrying only what was said since the cursor.
 *
 * A resolved or outdated thread is dropped rather than re-raised: it was already
 * dealt with, and waking a group with it is how a PR that is finished keeps
 * costing turns.
 */
function newThreads(threads: Thread[], seenAt: number): NonNullable<Feedback["threads"]> {
  return threads
    .filter((thread) => !thread.resolved)
    .map((thread) => ({
      id: thread.id,
      path: thread.path,
      line: thread.line,
      comments: saidSince(thread.comments, seenAt),
    }))
    .filter((thread) => thread.comments.length > 0);
}

/** The check's own words: its title, its summary, or nothing if it wrote neither. */
function evidence(check: Check): string | undefined {
  return [check.output?.title, check.output?.summary].filter(Boolean).join(": ").slice(0, 300) || undefined;
}

function failedChecks(checks: Check[], statuses: Status[]): Feedback["failingChecks"] {
  return [
    ...checks.map((check) => ({
      name: check.name,
      result: check.conclusion,
      summary: evidence(check),
      url: check.details_url,
    })),
    // The older Status API has no `output`; it carries a one-line `description`,
    // and reading that would be a second shape for the same idea. Names only here.
    ...statuses.map((status) => ({
      name: status.context,
      result: status.state,
      summary: undefined,
      url: undefined,
    })),
  ]
    .filter((check) => ["FAILURE", "ERROR", "TIMED_OUT"].includes(String(check.result ?? "").toUpperCase()))
    .map((check) => ({ name: String(check.name ?? "check"), summary: check.summary, url: check.url }));
}

/** One line-level thread as the poll reads it, before the cursor is applied. */
interface Thread {
  /** GitHub's node id: what `resolveReviewThread` takes, and what the agent quotes. */
  id: string;
  path: string;
  line: number | null;
  /** Outdated counts as resolved: the lines it was filed against are no longer there. */
  resolved: boolean;
  comments: Array<{ author?: string | undefined; body?: string | undefined; at?: string | undefined }>;
}

interface PollDetails {
  issue: IssueComment[];
  reviews: Review[];
  threads: Thread[];
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
  // No threads on this path, deliberately. `/pulls/{n}/comments` carries the
  // review comments but nothing about resolution — REST has no thread at all —
  // and an unresolved-only rule cannot be built out of an answer that never says
  // which ones are resolved. Re-raising settled threads every tick is worse than
  // the fallback being quieter than GraphQL, which is what an empty list is.
  return { issue: issue.data, reviews: reviews.data, threads: [], checks: runs.data, statuses: statuses.data };
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
  const threads = newThreads(details.threads, group.pr_seen_at);
  const failingChecks = failedChecks(details.checks, details.statuses);
  const conflicting = mergeable === false || mergeableState === "dirty";
  const names = failingChecks.map((check) => check.name);
  const signature = [...names, ...(conflicting ? ["merge conflict"] : [])].sort().join(",");
  const checksChanged = signature !== (group.pr_checks_sig ?? "");
  if (comments.length === 0 && threads.length === 0 && !checksChanged) return null;

  // Thread comments move the cursor too, or the same open thread is news on every
  // tick for as long as it stays open.
  const said = [...comments, ...threads.flatMap((thread) => thread.comments)];
  const newest = said.reduce((value, comment) => Math.max(value, comment.at), group.pr_seen_at);
  db.run("UPDATE grp SET pr_seen_at = ?, pr_checks_sig = ? WHERE id = ?", [newest, signature, group.id]);
  return {
    grpId: group.id,
    prNumber,
    comments,
    threads,
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

async function pollPr(db: DB, gh: Github, group: WatchedGroup): Promise<Feedback | null> {
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
  return changedFeedback(db, group, prNumber, details, parsed.mergeable, parsed.mergeable_state);
}

export async function pollPrs(ctx: Ctx, gh: Github): Promise<Feedback[]> {
  // Every heartbeat, serially over every group with an open pull request, and
  // five GitHub requests per group. `github.request` times the leaves; this says
  // whether the cost is one slow route or the number of groups.
  return activeTracer().startActiveSpan("pr.poll", async (span) => {
    try {
      return await pollPrsInner(ctx.db, gh, ctx.config.prPoll);
    } finally {
      span.end();
    }
  });
}

/**
 * One request for every open pull request in a repository, instead of five each.
 * The measured point cost and the REST comparison are in the commit that added it.
 *
 * Through `gh.request`, not a second client: `plugin-throttling` already treats
 * `/graphql` as its own limiter — GraphQL reports a rate limit inside a 200 body
 * rather than as a status — so `plugin-retry` and the Zod seam come along
 * unchanged. A dependency would have bought a `.graphql` method and lost all three.
 */
/**
 * `reviews` and `comments` take `last:`, so they arrive newest-last and are
 * filtered against `pr_seen_at` here. That is what fixes the REST reviews
 * endpoint having no `since` and returning oldest-first, which stopped waking the
 * PM once a PR passed a hundred reviews.
 */
const GRAPH_QUERY = `query($owner:String!,$name:String!,$prs:Int!,$messages:Int!,$checks:Int!,$threads:Int!,$threadComments:Int!){
  repository(owner:$owner,name:$name){
    pullRequests(states:[OPEN,MERGED,CLOSED],first:$prs,orderBy:{field:UPDATED_AT,direction:DESC}){
      nodes{
        number state merged mergeable headRefOid
        comments(last:$messages){ nodes{ author{login} body createdAt } }
        reviews(last:$messages){ nodes{ author{login} body state submittedAt } }
        reviewThreads(last:$threads){ nodes{
          id isResolved isOutdated path line
          comments(first:$threadComments){ nodes{ author{login} body createdAt } }
        } }
        commits(last:1){ nodes{ commit{ statusCheckRollup{
          contexts(last:$checks){ nodes{
            __typename
            ... on CheckRun { name conclusion detailsUrl output{ title summary } }
            ... on StatusContext { context state }
          } }
        } } } }
      }
    }
  }
}`;

/**
 * Where GraphQL puts a failure: inside a 200, beside whatever data it did produce.
 *
 * Every reader below checks this instead of the status, and a partial answer must
 * not read as a complete one.
 */
const GraphErrors = z
  .array(z.object({ message: z.string().optional() }))
  .nullable()
  .optional();

const GraphActor = z.object({ login: z.string().optional() }).nullable().optional();
const GraphContext = z.object({
  __typename: z.string().optional(),
  name: z.string().optional(),
  conclusion: z.string().nullable().optional(),
  detailsUrl: z.string().optional(),
  output: z
    .object({ title: z.string().nullable().optional(), summary: z.string().nullable().optional() })
    .nullable()
    .optional(),
  context: z.string().optional(),
  state: z.string().optional(),
});
const GraphThread = z.object({
  id: z.string().optional(),
  isResolved: z.boolean().optional(),
  isOutdated: z.boolean().optional(),
  path: z.string().optional(),
  /** Null once the diff has moved under the thread, which GitHub reports separately as outdated. */
  line: z.number().nullable().optional(),
  comments: z
    .object({
      nodes: z
        .array(z.object({ author: GraphActor, body: z.string().optional(), createdAt: z.string().optional() }))
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});
const GraphPrNode = z.object({
  number: z.number().int().positive(),
  state: z.string().optional(),
  merged: z.boolean().optional(),
  mergeable: z.string().optional(),
  headRefOid: z.string().optional(),
  comments: z
    .object({
      nodes: z
        .array(z.object({ author: GraphActor, body: z.string().optional(), createdAt: z.string().optional() }))
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  reviews: z
    .object({
      nodes: z
        .array(
          z.object({
            author: GraphActor,
            body: z.string().optional(),
            state: z.string().optional(),
            submittedAt: z.string().optional(),
          }),
        )
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  reviewThreads: z
    .object({ nodes: z.array(GraphThread).nullable().optional() })
    .nullable()
    .optional(),
  commits: z
    .object({
      nodes: z
        .array(
          z
            .object({
              commit: z.object({
                statusCheckRollup: z
                  .object({
                    contexts: z
                      .object({ nodes: z.array(GraphContext).nullable().optional() })
                      .nullable()
                      .optional(),
                  })
                  .nullable()
                  .optional(),
              }),
            })
            .nullable(),
        )
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});
const GraphReply = z.object({
  data: z
    .object({
      repository: z
        .object({
          pullRequests: z
            .object({ nodes: z.array(GraphPrNode.nullable()).nullable().optional() })
            .nullable()
            .optional(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  // A GraphQL failure is a 200 with this filled in, so the caller checks it rather
  // than the status. Any error at all sends the repository back to REST.
  errors: GraphErrors,
});

/** What one PR looks like once the query's shape is flattened. */
interface Polled {
  /** The same string `pullState` produces from REST, so one reader serves both. */
  state: string;
  mergeable: boolean | null;
  details: PollDetails;
}

/** How many of each the query asks for; the numbers are `prPoll` in the settings. */
type PollCounts = Config["prPoll"];

/** The threads a PR node carries, in the shape `newThreads` filters. */
function graphThreads(pr: z.infer<typeof GraphPrNode>): Thread[] {
  return (pr.reviewThreads?.nodes ?? []).map((thread) => ({
    id: thread.id ?? "",
    path: thread.path ?? "",
    line: thread.line ?? null,
    resolved: !!(thread.isResolved || thread.isOutdated),
    comments: (thread.comments?.nodes ?? []).map((c) => ({
      author: c.author?.login,
      body: c.body,
      at: c.createdAt,
    })),
  }));
}

/** One node of the query, flattened into the shape the REST readers already take. */
function flattenGraphPr(pr: z.infer<typeof GraphPrNode>): Polled {
  const contexts = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  return {
    state: pr.merged ? "MERGED" : String(pr.state ?? "").toUpperCase(),
    // `MERGEABLE` / `CONFLICTING` / `UNKNOWN`, where REST had a boolean and a
    // second `mergeable_state` string. Unknown stays null, which is what a REST
    // null meant: GitHub has not finished working it out.
    mergeable: pr.mergeable === "MERGEABLE" ? true : pr.mergeable === "CONFLICTING" ? false : null,
    details: {
      issue: (pr.comments?.nodes ?? []).map((c) => ({
        user: { login: c.author?.login },
        body: c.body,
        created_at: c.createdAt,
      })),
      reviews: (pr.reviews?.nodes ?? []).map((r) => ({
        user: { login: r.author?.login },
        body: r.body,
        state: r.state,
        submitted_at: r.submittedAt,
      })),
      threads: graphThreads(pr),
      // One rollup, two REST endpoints. A `CheckRun` carries `name`/`conclusion`
      // and a `StatusContext` carries `context`/`state`, which are the two shapes
      // `failedChecks` already reads — and it uppercases, so GraphQL's `FAILURE`
      // needs no translation.
      checks: contexts
        .filter((c) => c.__typename === "CheckRun")
        .map((c) => ({ name: c.name, conclusion: c.conclusion, details_url: c.detailsUrl, output: c.output })),
      statuses: contexts
        .filter((c) => c.__typename === "StatusContext")
        .map((c) => ({ context: c.context, state: c.state })),
    },
  };
}

async function pollViaGraph(
  gh: Github,
  repo: string,
  counts: PollCounts,
  signal?: AbortSignal,
): Promise<Map<number, Polled> | null> {
  const [owner, name] = repo.split("/");
  if (!owner || !name) return null;
  const reply = await gh.request(
    "POST",
    "/graphql",
    GraphReply,
    {
      query: GRAPH_QUERY,
      variables: {
        owner,
        name,
        prs: counts.prs,
        messages: counts.messages,
        checks: counts.checks,
        threads: counts.threads,
        threadComments: counts.threadComments,
      },
    },
    signal,
  );
  // `errors` beside a partial `data` is GraphQL's own shape for "some of this
  // failed", answered as 200 — so the status cannot be the check, and partial data
  // must not read as a complete answer.
  if (!reply.ok || reply.data.errors?.length) return null;
  const nodes = reply.data.data?.repository?.pullRequests?.nodes;
  if (!nodes) return null;
  return new Map(nodes.filter((pr): pr is NonNullable<typeof pr> => !!pr).map((pr) => [pr.number, flattenGraphPr(pr)]));
}

/**
 * Where one review thread lives, asked of GitHub rather than taken from the caller.
 *
 * `orch pr resolve` refuses a thread on another PR and a thread outside the
 * group's boundary, and the id an agent quotes cannot answer either question. Both
 * answers come from here, so neither is something the agent gets to assert.
 */
const THREAD_QUERY = `query($id:ID!){ node(id:$id){ ... on PullRequestReviewThread {
  path pullRequest{ number repository{ nameWithOwner } }
} } }`;

const ThreadReply = z.object({
  data: z
    .object({
      node: z
        .object({
          path: z.string().optional(),
          pullRequest: z
            .object({
              number: z.number().int().positive(),
              repository: z.object({ nameWithOwner: z.string().optional() }).nullable().optional(),
            })
            .nullable()
            .optional(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  errors: GraphErrors,
});

/** A thread's own account of where it is: `owner/repo`, PR number, file. */
export interface ReviewThreadAt {
  repo: string;
  prNumber: number;
  path: string;
}

/** Null for every reason there is — unknown id, wrong node type, a GraphQL error. */
export async function reviewThreadAt(
  gh: Github,
  threadId: string,
  signal?: AbortSignal,
): Promise<ReviewThreadAt | null> {
  const reply = await gh.request(
    "POST",
    "/graphql",
    ThreadReply,
    { query: THREAD_QUERY, variables: { id: threadId } },
    signal,
  );
  if (!reply.ok || reply.data.errors?.length) return null;
  const node = reply.data.data?.node;
  const pr = node?.pullRequest;
  // `node(id:)` answers null for an id of any other type, and the inline fragment
  // leaves an empty object for one that is not a review thread. Both land here.
  return node?.path && pr?.number && pr.repository?.nameWithOwner
    ? { repo: pr.repository.nameWithOwner, prNumber: pr.number, path: node.path }
    : null;
}

const RESOLVE_MUTATION = `mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ id isResolved } } }`;

const ResolveReply = z.object({
  data: z
    .object({
      resolveReviewThread: z
        .object({ thread: z.object({ isResolved: z.boolean().optional() }).nullable().optional() })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  errors: GraphErrors,
});

/**
 * Close the thread. Returns why it did not, or null when it did.
 *
 * `github.ts` gives every non-GET `retries: 0`, which is what a mutation wants:
 * this one is idempotent, but the transport cannot know that and the next
 * mutation written here will not be.
 */
export async function resolveReviewThread(gh: Github, threadId: string, signal?: AbortSignal): Promise<string | null> {
  const reply = await gh.request(
    "POST",
    "/graphql",
    ResolveReply,
    { query: RESOLVE_MUTATION, variables: { id: threadId } },
    signal,
  );
  if (!reply.ok) return reply.message;
  const said = (reply.data.errors ?? []).map((e) => e.message).filter(Boolean);
  if (said.length) return said.join("; ");
  // A 200 with neither an error nor a thread is GitHub declining without saying
  // so; reporting it as success leaves the agent believing a thread it can still
  // see open was closed.
  return reply.data.data?.resolveReviewThread?.thread ? null : "GitHub answered the resolve with no thread in it";
}

async function pollPrsInner(db: DB, gh: Github, counts: PollCounts): Promise<Feedback[]> {
  const groups = db
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
  // One GraphQL request per repository first. A repository whose query fails for
  // any reason — an error in the body, a shape that does not parse, a PR outside
  // the window the query asks for — falls through to the REST path below, which is
  // what every poll did until now. The fallback is the point: this is the busiest
  // GitHub path there is, and a new query shape is not a thing to bet a fleet on.
  const repos = [...new Set(groups.map((g) => g.remote).filter((r): r is string => !!r))].map(parseRepo);
  const graphed = new Map<string, Map<number, Polled>>();
  await pMap(
    repos.filter((r): r is string => !!r),
    async (repo) => {
      const one = await pollViaGraph(gh, repo, counts).catch(() => null);
      if (one) graphed.set(repo, one);
    },
    { concurrency: PR_FANOUT },
  );

  const results = await pMap(groups, (group) => pollOne(db, gh, group, graphed), { concurrency: PR_FANOUT });
  return results.filter((result): result is Feedback => result !== null);
}

/**
 * The pre-fetched answer when there is one, and the five REST calls when there is
 * not.
 */
async function pollOne(
  db: DB,
  gh: Github,
  group: WatchedGroup,
  graphed: Map<string, Map<number, Polled>>,
): Promise<Feedback | null> {
  const target = pollTarget(group);
  if (!target) return null;
  const have = graphed.get(target.repo)?.get(target.prNumber);
  if (!have) return pollPr(db, gh, group);
  const transition = transitionFeedback(group, target.prNumber, have.state);
  if (transition) return transition;
  if (group.status !== "PR_OPEN") return null;
  return changedFeedback(db, group, target.prNumber, have.details, have.mergeable, undefined);
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
  // Named from the project. `main` was written into the rebase instruction below,
  // so a group on `develop` was told to fetch a branch its repository has not got.
  const base = baseBranchOf(ctx.db, f.grpId, ctx.config.baseBranchFallbacks);
  const lines = [
    ...f.comments.map((c) => `${c.author}: ${c.body}`),
    // The file and the line first: a review thread is an instruction about one
    // place in the diff, and without them the PM is told to fix something it
    // cannot find.
    ...(f.threads ?? []).map(
      (t) => `[${t.id}] ${t.path}:${t.line ?? "?"} — ${t.comments.map((c) => `${c.author}: ${c.body}`).join(" / ")}`,
    ),
    // The id is quoted back, so it leads the line: the event body is truncated at
    // 2000 characters and a review comment is up to 1000 of them.
    ...(f.threads?.length
      ? [
          "Fixed one? `orch pr resolve --thread <id>` closes it. A thread about design, another " +
            "group's files, or a premise that changed goes to `orch ask-boss` and stays open — " +
            "the boss decides it. Unsure: leave it open.",
        ]
      : []),
    ...(f.failingChecks.length ? [`failing checks: ${f.failingChecks.map((c) => c.name).join(", ")}`] : []),
    // What the gate said, under the list of names. "failing checks: build" told
    // the PM a fact with no next step in it, and the summary is the step.
    ...f.failingChecks
      .filter((c) => c.summary || c.url)
      .map((c) => `${c.name}: ${[c.summary, c.url].filter(Boolean).join(" — ")}`),
    ...(f.conflicting ? ["the branch no longer merges cleanly into main"] : []),
  ].join("\n");

  ctx.bus.emit({
    grpId: f.grpId,
    author: "pr-watcher",
    kind: "say",
    intent: "request",
    body: `PR #${f.prNumber} has feedback:\n${lines}`.slice(0, 2000),
    meta: { pr: f.prNumber, comments: f.comments.length, failingChecks: f.failingChecks.map((c) => c.name) },
  });
  // Deliberately not moved out of PR_OPEN. That flip made the group deaf to
  // everything said next: `pollPr` returns null for any other status, and nothing
  // moved it back — PR_OPEN is written by a fresh branch gate, a reopen from
  // PAUSED, or the boss, and the `reconcile` repair in `invariants.ts` skips any
  // group that has a PR. So the second review comment was never read, while the
  // group still held `merge_seq` at the head of a strictly serial queue.
  //
  // The flip was never needed either: PR_OPEN is in `DISPATCHABLE_GRP_STATES`, so
  // the turn below runs from it unchanged.
  // A conflict is work, not a judgement call: the PM would only forward it. Reading
  // a review and deciding what to concede is the PM's; `git rebase` is not.
  ctx.sched.enqueue("agent_turn", {
    grp_id: f.grpId,
    payload: f.conflicting
      ? {
          role: roleFor(ctx, "write_code"),
          rotate: true,
          // The fork in the road, stated, because no check here can tell the two
          // apart: a textual clash is this turn's work, and a premise that no
          // longer holds is a design question the Architect owns.
          conflict: true,
          rejection:
            `PR #${f.prNumber} no longer merges into ${base}. Rebase onto it before anything else:\n` +
            `\`git fetch origin ${base}\` then \`git rebase origin/${base}\`, resolve every conflict, re-run the ` +
            `gates, and stop there — the orchestrator takes the branch from your checkout and pushes it, ` +
            `so do not look for a way to push. Keep both sides' intent — ${base} moved for a reason and so ` +
            `did this branch.\n\n` +
            `If ${base} removed or reshaped something this slice was built on, STOP — do not invent a way to ` +
            `keep compiling. Say which premise is gone with \`orch ask-boss\`; that reaches the Architect, ` +
            `who decides whether this slice still makes sense. Guessing produces code that builds and is ` +
            `pointed the wrong way, which nothing downstream can catch.\n${lines}`,
        }
      : { role: roleFor(ctx, "lead_group"), rejection: `PR #${f.prNumber} feedback:\n${lines}` },
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
