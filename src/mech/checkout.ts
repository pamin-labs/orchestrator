import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ctx } from "../api.ts";
import { execIn, getBytes, WORK, type Scope } from "./sandbox.ts";
import { shq } from "./shq.ts";
import type { GitRunner } from "./worktree.ts";

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

/** `git remote get-url origin`, which is what the sandbox will clone. */
export async function remoteUrl(git: GitRunner, repoPath: string): Promise<string | null> {
  const r = await git(repoPath, ["remote", "get-url", "origin"]);
  return r.code === 0 && r.out.trim() ? r.out.trim() : null;
}

export interface CheckoutSpec {
  remote: string;
  branch: string;
  /** What to branch from. `origin/main` unless a group was told otherwise. */
  base: string;
}

/**
 * Clone and branch. Idempotent: a re-entered group keeps the work it has.
 *
 * Cloning shallow would be cheaper and is wrong here — a slice's diff is taken
 * against the merge base with main, and `rebaseOntoBase` needs real history.
 */
export async function createCheckout(ctx: Ctx, scope: Scope, spec: CheckoutSpec): Promise<void> {
  const already = await execIn(ctx, scope, `test -d ${WORK}/.git && echo yes`);
  if (already.out.trim() === "yes") return;

  const clone = await execIn(ctx, scope, `git clone ${JSON.stringify(spec.remote)} ${WORK}`, {
    timeoutMs: 600_000,
  });
  if (clone.code !== 0) throw new Error(`git clone failed: ${(clone.err || clone.out).slice(-400)}`);

  // Attach to the branch if the remote already has it — that is the unpark path,
  // and also what happens when a previous attempt died after its first push.
  const exists = await execIn(ctx, scope, `git ls-remote --exit-code --heads origin ${spec.branch}`, {
    cwd: WORK,
  });
  const checkout =
    exists.code === 0
      ? `git checkout ${spec.branch}`
      : `git checkout -b ${spec.branch} ${spec.base}`;
  const co = await execIn(ctx, scope, checkout, { cwd: WORK });
  if (co.code !== 0) throw new Error(`git checkout failed: ${(co.err || co.out).slice(-400)}`);

  // An agent commits as itself, not as whoever last configured this machine.
  await execIn(
    ctx,
    scope,
    `git config user.name "orch agent" && git config user.email "agent@orch.local"`,
    { cwd: WORK },
  );
}

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
