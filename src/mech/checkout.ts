import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ctx } from "../api.ts";
import { execIn, getBytes, putBytes, WORK, type Scope } from "./sandbox.ts";
import { shq } from "./shq.ts";
import { detectBaseBranch, type GitRunner } from "./worktree.ts";

/**
 * A group's code, inside its sandbox.
 *
 * A clone, not a `git worktree`. A worktree's `.git` is a file pointing back
 * into the main checkout's `.git/worktrees/<name>`, so committing inside a
 * container would mean mounting the whole repository in — which reopens exactly
 * the boundary the sandbox exists to close. A clone is self-contained and needs
 * nothing from the host.
 *
 * The host keeps its own copy of the branch by fetching it from the remote, so
 * review, gates-on-merge and the PR still run against ordinary local refs.
 */

/**
 * Which branch this project's work is cut from and measured against.
 *
 * Stored, not detected every time, for two reasons. It is a decision — a project
 * that develops on `develop` says so once — and it is the diff baseline, so it has
 * to be the same value on the day a slice was cut and on the day the boss reads
 * its diff. `project.base_branch` NULL means "whatever the remote's HEAD says",
 * which is resolved once and written back.
 *
 * Re-detected when the stored name no longer exists on the remote: a default
 * branch that was renamed (master -> main) or repointed otherwise leaves every
 * clone, rebase and diff resolving against a ref that is not there, and the
 * symptom is a group that cannot start rather than anything mentioning branches.
 * Said out loud when it changes, because it changes what every later diff means.
 */
export async function baseBranch(ctx: Ctx, projectId: number): Promise<string> {
  const row = ctx.db
    .query<{ repo_path: string; base_branch: string | null }, [number]>(
      "SELECT repo_path, base_branch FROM project WHERE id = ?",
    )
    .get(projectId);
  if (!row) return "main";
  const git = ctx.git;
  if (!git) return row.base_branch ?? "main";

  if (row.base_branch) {
    const there = await git(row.repo_path, ["rev-parse", "--verify", "--quiet", `origin/${row.base_branch}`]);
    if (there.code === 0) return row.base_branch;
  }
  const found = await detectBaseBranch(git, row.repo_path);
  if (found !== row.base_branch) {
    ctx.db.run("UPDATE project SET base_branch = ? WHERE id = ?", [found, projectId]);
    if (row.base_branch) {
      ctx.bus?.emit({
        grpId: null,
        author: "orchestrator",
        kind: "state_change",
        severity: "advisory",
        body: `基线分支从 ${row.base_branch} 改成 ${found}（远端上找不到 origin/${row.base_branch} 了）。往后的 clone、rebase 和 diff 都对着它。`,
      });
    }
  }
  return found;
}

/** The same thing as a ref to hand git. */
export const baseRefFor = async (ctx: Ctx, projectId: number): Promise<string> =>
  `origin/${await baseBranch(ctx, projectId)}`;

/**
 * git, but inside the sandbox.
 *
 * Same signature as the host runner, so every helper in worktree.ts — checkpoint,
 * rollback, rebase, the diff bases — keeps working with the checkout in its new
 * home. No repo lock: each group has its own clone, so there is nothing left for
 * two groups to corrupt.
 */
export function sandboxGit(ctx: Ctx, scope: Scope): GitRunner {
  return async (_repo, argv, cwd) => {
    const r = await execIn(ctx, scope, `git ${argv.map(shq).join(" ")}`, { cwd: cwd ?? WORK });
    return { code: r.code, out: `${r.out}${r.err}`.trimEnd() };
  };
}

/**
 * `origin`, as a URL a sandbox can actually clone.
 *
 * The boss's own remote is usually SSH (`git@github.com:owner/repo.git`), and a
 * sandbox has no key — nor should it: an SSH key is not something the credential
 * vault can inject, because injection works on HTTP headers. Over HTTPS a
 * read-only token can be bound at the sidecar instead, so the sandbox clones
 * without ever holding a credential.
 *
 * Rewritten rather than refused, because the boss's remote is theirs and this is
 * only how *we* reach it.
 */
export function httpsRemote(url: string): string {
  const scp = /^(?:ssh:\/\/)?(?:[\w.-]+@)?([\w.-]+)[:/](.+?)(?:\.git)?\/?$/.exec(url);
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (!scp) return url;
  return `https://${scp[1]}/${scp[2]}.git`;
}

export async function remoteUrl(git: GitRunner, repoPath: string): Promise<string | null> {
  const r = await git(repoPath, ["remote", "get-url", "origin"]);
  return r.code === 0 && r.out.trim() ? httpsRemote(r.out.trim()) : null;
}

export interface CheckoutSpec {
  remote: string;
  branch: string;
  /** What to branch from. `origin/main` unless a group was told otherwise. */
  base: string;
  /** Host git and repo, so a branch only the host has can be seeded in. */
  git?: GitRunner;
  repoPath?: string;
}

/**
 * Clone and branch. Idempotent: a re-entered group keeps the work it has.
 *
 * Cloning shallow would be cheaper and is wrong here — a slice's diff is taken
 * against the merge base with main, and `rebaseOntoBase` needs real history.
 */
/**
 * Put a branch the host already has into the sandbox.
 *
 * The mirror of `publishBranch`, and the reason a sandbox is disposable: a
 * group's commits live on the host between turns, so a container that dies —
 * TTL, a crash, a restart — costs the turn in flight and nothing else. Without
 * this everything since the last PR would go with it, because a group's branch
 * does not reach the remote until then.
 */
export async function seedBranch(
  ctx: Ctx,
  scope: Scope,
  git: GitRunner,
  repoPath: string,
  branch: string,
): Promise<boolean> {
  const onHost = join(tmpdir(), `orch-seed-${branch.replaceAll("/", "-")}.bundle`);
  const made = await git(repoPath, ["bundle", "create", onHost, branch]);
  if (made.code !== 0) return false;
  try {
    const bytes = await Bun.file(onHost).arrayBuffer();
    const inSandbox = `/tmp/seed-${branch.replaceAll("/", "-")}.bundle`;
    await putBytes(ctx, scope, inSandbox, new Uint8Array(bytes));
    const fetched = await execIn(ctx, scope, `git fetch ${shq(inSandbox)} ${shq(`+${branch}:${branch}`)}`, { cwd: WORK });
    if (fetched.code !== 0) return false;
    return (await execIn(ctx, scope, `git checkout ${shq(branch)}`, { cwd: WORK })).code === 0;
  } finally {
    rmSync(onHost, { force: true });
  }
}

export async function createCheckout(ctx: Ctx, scope: Scope, spec: CheckoutSpec): Promise<void> {
  const already = await execIn(ctx, scope, `test -d ${WORK}/.git && echo yes`);
  if (already.out.trim() === "yes") return;

  // `GIT_TERMINAL_PROMPT=0`: without it a repository the sandbox cannot read
  // stops on "could not read Username" and the group waits on a prompt nobody
  // will ever answer. Failing is the useful answer — it means the read
  // credential is missing, which preflight and the settings page can say.
  const clone = await execIn(ctx, scope, `git clone ${JSON.stringify(spec.remote)} ${WORK}`, {
    timeoutMs: 600_000,
    env: { GIT_TERMINAL_PROMPT: "0" },
  });
  if (clone.code !== 0) throw new Error(`git clone failed: ${(clone.err || clone.out).slice(-400)}`);

  // Three places the branch can be, in the order that loses nothing:
  //   1. on the host — a group mid-flight whose sandbox was replaced, and every
  //      group that predates this design. Its commits exist nowhere else.
  //   2. on the remote — it has been through a PR already.
  //   3. nowhere — a new group, so cut it from the base.
  if (spec.git && spec.repoPath && (await seedBranch(ctx, scope, spec.git, spec.repoPath, spec.branch))) {
    // Seeded and checked out.
  } else {
    const onRemote = await execIn(ctx, scope, `git ls-remote --exit-code --heads origin ${shq(spec.branch)}`, {
      cwd: WORK,
    });
    const co = await execIn(
      ctx,
      scope,
      onRemote.code === 0 ? `git checkout ${shq(spec.branch)}` : `git checkout -b ${shq(spec.branch)} ${shq(spec.base)}`,
      { cwd: WORK },
    );
    if (co.code !== 0) throw new Error(`git checkout failed: ${(co.err || co.out).slice(-400)}`);
  }

  // An agent commits as itself, not as whoever last configured this machine.
  await execIn(
    ctx,
    scope,
    `git config user.name "orch agent" && git config user.email "agent@orch.local"`,
    { cwd: WORK },
  );

  // codex reads AGENTS.md where claude reads CLAUDE.md: same instructions, two
  // names. Linked rather than copied so editing one cannot leave a stale twin,
  // and both ways because both kinds of repo exist — a codex-native repo ships
  // only AGENTS.md, and a claude turn in it otherwise runs with no project
  // instructions at all, silently. A repo that ships both is left alone.
  //
  // Here, not per turn on the host: this used to be a host `symlinkSync` against
  // `/work`, a path that only exists inside the container, guarded by an
  // `existsSync` that made it a permanent no-op.
  await execIn(ctx, scope, LINK_AGENTS_MD, { cwd: WORK });
}

/** Exported so the check can run it in a temp directory, verbatim. */
export const LINK_AGENTS_MD =
  "[ -f CLAUDE.md ] && [ ! -e AGENTS.md ] && ln -s CLAUDE.md AGENTS.md;" +
  " [ -f AGENTS.md ] && [ ! -e CLAUDE.md ] && ln -s AGENTS.md CLAUDE.md; true";

/**
 * Move a group's commits from its sandbox onto the host, as a bundle.
 *
 * The sandbox is never given a credential that can write to the remote. It
 * could have been — the clone comes from there — but then "no direct push to
 * main" would be a sentence in a prompt rather than something the code can
 * stop, and hard constraint 3 says anything an `if` can catch must not be left
 * to the agent's good behaviour. A read-only clone in, a bundle out, and the
 * host stays the only thing that can push.
 *
 * A bundle carries objects, not credentials, and only the commits the host does
 * not already have.
 */
export async function publishBranch(
  ctx: Ctx,
  scope: Scope,
  git: GitRunner,
  repoPath: string,
  branch: string,
  base: string,
): Promise<{ ok: boolean; reason?: string }> {
  const inSandbox = `/tmp/${branch.replaceAll("/", "-")}.bundle`;
  const made = await execIn(ctx, scope, `git bundle create ${shq(inSandbox)} ${shq(branch)} --not ${shq(base)}`, {
    cwd: WORK,
  });
  // "Refusing to create empty bundle" is the ordinary answer for a group that
  // has committed nothing yet, not a failure worth escalating.
  if (made.code !== 0) return { ok: false, reason: (made.err || made.out).slice(-300) };

  const bytes = await getBytes(ctx, scope, inSandbox);
  if (!bytes) return { ok: false, reason: "bundle vanished between writing and reading it" };

  const onHost = join(tmpdir(), `orch-${branch.replaceAll("/", "-")}.bundle`);
  await Bun.write(onHost, bytes);
  const fetched = await git(repoPath, ["fetch", onHost, `+refs/heads/${branch}:refs/heads/${branch}`]);
  rmSync(onHost, { force: true });
  return fetched.code === 0 ? { ok: true } : { ok: false, reason: fetched.out.slice(-300) };
}

/**
 * The group's checkout, wherever the group is in its life.
 *
 * `startGroup` is not the only way a turn happens: a group can outlive its
 * sandbox (TTL, a killed container, a restarted orchestrator), and a group that
 * predates this design has a branch but has never had a clone. Both look the
 * same from here — an empty `/work` — and both are fixed the same way.
 *
 * `createCheckout` returns early when `.git` is already there, so this is one
 * cheap exec on the ordinary path.
 */
export async function ensureCheckout(ctx: Ctx, grpId: number): Promise<void> {
  const grp = ctx.db
    .query<{ name: string; project_id: number; branch: string | null }, [number]>(
      "SELECT name, project_id, branch FROM grp WHERE id = ?",
    )
    .get(grpId);
  if (!grp || !ctx.git) return;
  const repo = ctx.db
    .query<{ repo_path: string }, [number]>("SELECT repo_path FROM project WHERE id = ?")
    .get(grp.project_id);
  if (!repo) return;
  const remote = await remoteUrl(ctx.git, repo.repo_path);
  if (!remote) return;
  await createCheckout(ctx, { grp: grpId }, {
    remote,
    branch: grp.branch ?? `orch/${grp.name}`,
    base: await baseRefFor(ctx, grp.project_id),
    git: ctx.git,
    repoPath: repo.repo_path,
  });
}
