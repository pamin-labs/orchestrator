import type { Ctx } from "../api.ts";
import { execIn, execLines, getBytes, putBytes, UTIL, WORK, type Scope } from "./sandbox.ts";
import { sandboxLog } from "./sandboxlog.ts";
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

/**
 * Where this project's code comes from.
 *
 * The stored remote, not `git remote get-url` against a host checkout. That was
 * the last thing in the clone path that required the host to be a git
 * participant, and it was also a way for two answers to disagree: the host
 * checkout's `origin` and `project.remote` come from different places, so a
 * group could clone one repository while its PR opened on another.
 */
export function remoteFor(ctx: Ctx, projectId: number): string | null {
  const row = ctx.db
    .query<{ remote: string | null }, [number]>("SELECT remote FROM project WHERE id = ?")
    .get(projectId);
  return row?.remote ? httpsRemote(row.remote) : null;
}

export interface CheckoutSpec {
  remote: string;
  branch: string;
  /** What to branch from. `origin/main` unless a group was told otherwise. */
  base: string;
}

/**
 * Run a command in the sandbox and put every line of it on the group's log.
 *
 * The buffered `execIn` is right for the dozen small git calls around this; it is
 * wrong for the two that take minutes, because "nothing has printed yet" and "it
 * is stuck" look identical from outside.
 */
async function streamed(
  ctx: Ctx,
  scope: Scope,
  cmd: string,
  opts: { timeoutMs?: number; env?: Record<string, string> },
): Promise<{ code: number; out: string }> {
  const grpId = "grp" in scope ? scope.grp : null;
  if (grpId == null) {
    const r = await execIn(ctx, scope, cmd, { ...opts, cwd: undefined });
    return { code: r.code, out: `${r.out}${r.err}` };
  }
  sandboxLog(ctx, grpId, "cmd", cmd);
  // Stderr streams here rather than arriving in one block at the end: for
  // `git clone --progress` that block *was* the whole log.
  const stream = execLines(ctx, scope, cmd, { ...opts, onStderr: (l) => sandboxLog(ctx, grpId, "out", l) });
  const seen: string[] = [];
  for (;;) {
    const step = await stream.next();
    if (step.done) {
      sandboxLog(ctx, grpId, "end", step.value.code === 0 ? "ok" : `exit ${step.value.code}`);
      return { code: step.value.code, out: [...seen, step.value.err].filter(Boolean).join("\n") };
    }
    seen.push(step.value);
    if (seen.length > 400) seen.shift();
    sandboxLog(ctx, grpId, "out", step.value);
  }
}

export async function createCheckout(ctx: Ctx, scope: Scope, spec: CheckoutSpec): Promise<void> {
  const already = await execIn(ctx, scope, `test -d ${WORK}/.git && echo yes`);
  if (already.out.trim() === "yes") return;

  // `GIT_TERMINAL_PROMPT=0`: without it a repository the sandbox cannot read
  // stops on "could not read Username" and the group waits on a prompt nobody
  // will ever answer. Failing is the useful answer — it means the read
  // credential is missing, which preflight and the settings page can say.
  //
  // `--progress` and streamed, not awaited in silence: a clone of a real
  // repository is the longest minute of a group's life and the panel showed a
  // grey dash for all of it. git writes its progress to stderr, which `--progress`
  // is what keeps on when stdout is not a terminal.
  // `shq`, like every other command in this file. `JSON.stringify` was the one
  // exception and it is not a quoter: it emits *double* quotes, under which `sh`
  // still expands `$(…)`, backticks and `${…}` — and the remote can come from
  // `postProject`'s request body, not only from `git remote get-url`.
  //
  // `--filter=blob:none`, and never `--depth=1`. Shallow is faster still and
  // truncates history — `rebaseOntoBase` and `merge-base --is-ancestor` both
  // need the real thing, and they are what every slice diff and every rebase go
  // through. Blobless keeps every commit and fetches file contents on demand:
  // GitHub measures an ~88.6% average reduction in clone time across
  // repositories using partial clone.
  const cloneCmd = `git clone --progress --filter=blob:none ${shq(spec.remote)} ${WORK}`;
  const clone = await streamed(ctx, scope, cloneCmd, { timeoutMs: 600_000, env: { GIT_TERMINAL_PROMPT: "0" } });
  if (clone.code !== 0) throw new Error(`git clone failed: ${clone.out.slice(-400)}`);

  // Two places the branch can be, and there used to be three. The first was "on
  // the host", because a group's commits lived there between turns — which was
  // the entire reason the host held a checkout. They live on the remote now
  // (`pushBranch`), so:
  //   1. on the remote — this group has reached a slice boundary before, or a PR.
  //   2. nowhere — a new group, so cut it from the base.
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

  await initSubmodules(ctx, scope);

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

/**
 * Submodules, in two steps, in the container that is allowed to have them.
 *
 * `git clone --recursive` is CVE-2024-32002 and CVE-2025-48384: a repository can
 * arrange for a submodule's checkout to land a `post-checkout` script where git
 * then looks for hooks, and cloning it is remote code execution. GitHub's own
 * mitigation leads with *run git against untrusted sources inside ephemeral,
 * network-restricted containers*, which is what a group container already is —
 * so this is supported here, and never in the utility container, which holds the
 * real login and checks out nothing.
 *
 * The two steps **are** the mitigation, not caution about it: clone without
 * `--recursive`, then init only after the working tree exists and `.gitmodules`
 * can be read. Collapsing them back into one flag puts the exposure back.
 *
 * `protocol.file.allow=user` because a submodule with a relative URL resolves to
 * a local path and git refuses those by default since the CVE. A repository with
 * no `.gitmodules` pays one `test -f` and nothing else.
 */
async function initSubmodules(ctx: Ctx, scope: Scope): Promise<void> {
  const has = await execIn(ctx, scope, `test -f ${WORK}/.gitmodules && echo yes`);
  if (has.out.trim() !== "yes") return;
  const r = await execIn(ctx, scope, `git -c protocol.file.allow=user submodule update --init`, {
    cwd: WORK,
    timeoutMs: 600_000,
  });
  if (r.code !== 0 && "grp" in scope) {
    // Not fatal: a repository whose submodules will not init is still a
    // repository the group can work in, and the agent bucket (007 §6) is where a
    // failed init belongs — it is something a turn can be given and act on.
    ctx.bus.emit({
      grpId: scope.grp,
      author: "orchestrator",
      kind: "state_change",
      severity: "warn",
      body: `子模块没拉起来，代码可能不全：${(r.err || r.out).slice(-300)}`,
    });
  }
}

/** Exported so the check can run it in a temp directory, verbatim. */
export const LINK_AGENTS_MD =
  "[ -f CLAUDE.md ] && [ ! -e AGENTS.md ] && ln -s CLAUDE.md AGENTS.md;" +
  " [ -f AGENTS.md ] && [ ! -e CLAUDE.md ] && ln -s AGENTS.md CLAUDE.md; true";

/**
 * git in the utility container, and the whole of what it is allowed to be.
 *
 * Two rules, as `if`s rather than as a paragraph somebody has to remember:
 *
 * - **`core.hooksPath=/dev/null` on every single invocation.** Not set once in a
 *   config file, because the thing it defends against is a repository that
 *   arranges for a hook to appear, and a config written before that happens is a
 *   config the repository can outlive. `/dev/null/post-receive` cannot exist.
 * - **These four verbs and no others.** This container holds the real GitHub
 *   token; RCE in a group container buys the attacker what that agent already
 *   had, and RCE here buys the whole system. `checkout`, `submodule` and
 *   anything else that writes a working tree are not on the list, so no
 *   repository content is ever executed. It throws rather than returning an
 *   error code: reaching this line at all is a bug in us, not a condition.
 */
const UTIL_VERBS = new Set(["clone", "fetch", "push", "bundle"]);

export async function utilGit(ctx: Ctx, argv: string[], cwd?: string): Promise<{ code: number; out: string }> {
  const verb = argv[0] ?? "";
  if (!UTIL_VERBS.has(verb)) {
    throw new Error(`utility container may not run 'git ${verb}': it does fetch/push/bundle and nothing else`);
  }
  // The verb goes in unquoted because it has just been checked against a literal
  // set, so it is one of four words and cannot carry a metacharacter. Everything
  // after it is a branch name, a path or a URL and is quoted like everywhere else.
  const cmd = `git -c core.hooksPath=/dev/null ${verb} ${argv.slice(1).map(shq).join(" ")}`;
  const r = await execIn(ctx, UTIL, cmd, {
    cwd,
    timeoutMs: 600_000,
    env: { GIT_TERMINAL_PROMPT: "0" },
  });
  return { code: r.code, out: `${r.out}${r.err}`.trimEnd() };
}

/** Where this project's bare mirror lives inside the utility container. */
const mirrorPath = (remote: string): string => `/repos/${remote.replace(/[^\w.-]+/g, "-")}`;

/**
 * The project's mirror, made once.
 *
 * `--bare`: no working tree, so nothing in the repository is ever written to
 * disk in a form anything would execute, and `--filter=blob:none` for the same
 * reason it is on the group's clone — this one never needs file contents at all,
 * only refs and the objects a bundle brings.
 */
async function ensureMirror(ctx: Ctx, remote: string): Promise<string> {
  const path = mirrorPath(remote);
  const there = await execIn(ctx, UTIL, `test -d ${shq(path)} && echo yes`);
  if (there.out.trim() === "yes") return path;
  const made = await utilGit(ctx, ["clone", "--bare", "--filter=blob:none", remote, path]);
  if (made.code !== 0) throw new Error(`utility container could not mirror ${remote}: ${made.out.slice(-300)}`);
  return path;
}

/**
 * A group's commits, out of its container and into the mirror. No network.
 *
 * Called every turn, and that is deliberate: a sandbox is disposable, and this
 * is what makes that true rather than expensive. A container that dies — TTL, a
 * crash, a restart — costs the turn in flight and nothing else. What used to
 * receive this was a checkout on the host, which is the thing 007 is removing;
 * the receiver is now the one container that is allowed to hold a git
 * repository nobody works in.
 *
 * A bundle carries objects and never a credential, which is why the direction is
 * one-way: out of the agent's container, never in. That has not changed and is
 * not negotiable — see `readOnlyGitPaths` for the other half of it.
 */
export async function keepBranch(ctx: Ctx, grpId: number): Promise<{ ok: boolean; reason?: string }> {
  // Every way out of here is a returned reason, never a throw. Two callers are a
  // turn that has already finished its work and a slice acceptance that is not
  // awaited — for both, a container that cannot be opened has to be a reported
  // failure rather than an exception that takes the turn or the process with it.
  try {
    return await keep(ctx, grpId);
  } catch (e) {
    return { ok: false, reason: `${(e as Error)?.message ?? e}`.slice(-300) };
  }
}

async function keep(ctx: Ctx, grpId: number): Promise<{ ok: boolean; reason?: string }> {
  const grp = ctx.db
    .query<{ branch: string | null; project_id: number }, [number]>("SELECT branch, project_id FROM grp WHERE id = ?")
    .get(grpId);
  if (!grp?.branch) return { ok: false, reason: "group has no branch" };
  const remote = remoteFor(ctx, grp.project_id);
  if (!remote) return { ok: false, reason: "project has no remote" };
  const branch = grp.branch;
  const base = await baseRefFor(ctx, grp.project_id);

  const scope = { grp: grpId } as const;
  const name = `${branch.replaceAll("/", "-")}.bundle`;
  const made = await execIn(ctx, scope, `git bundle create ${shq(`/tmp/${name}`)} ${shq(branch)} --not ${shq(base)}`, {
    cwd: WORK,
  });
  // "Refusing to create empty bundle" is the ordinary answer for a group that
  // has committed nothing yet, not a failure worth escalating.
  if (made.code !== 0) return { ok: false, reason: (made.err || made.out).slice(-300) };

  const bytes = await getBytes(ctx, scope, `/tmp/${name}`);
  if (!bytes) return { ok: false, reason: "bundle vanished between writing and reading it" };

  const mirror = await ensureMirror(ctx, remote);
  const inUtil = `/tmp/${name}`;
  await putBytes(ctx, UTIL, inUtil, bytes);
  const ref = `+refs/heads/${branch}:refs/heads/${branch}`;
  const fetched = await utilGit(ctx, ["fetch", inUtil, ref], mirror);
  if (fetched.code === 0) return { ok: true };

  // "Repository lacks these prerequisite commits", and it is not a corrupt
  // bundle. The bundle is cut `--not <base>`, so its prerequisites are commits
  // on the base — and the group rebases onto a base it fetched itself, which
  // this mirror has not seen since it was cloned. One `fetch origin` and a
  // retry, only on this failure, so the ordinary turn still costs no network.
  if (!/prerequisite/i.test(fetched.out)) return { ok: false, reason: fetched.out.slice(-300) };
  await utilGit(ctx, ["fetch", "origin"], mirror);
  const again = await utilGit(ctx, ["fetch", inUtil, ref], mirror);
  return again.code === 0 ? { ok: true } : { ok: false, reason: again.out.slice(-300) };
}

/**
 * The branch, on the remote. Slice boundaries and PR time, never every turn.
 *
 * This is what makes a container disposable without the host holding anything:
 * a replaced container is `clone` plus `git checkout <branch>`, because the
 * branch is where every other feature branch lives. The stated cost is that
 * work-in-progress commits are visible on the remote before the PR opens, which
 * is how every feature branch already works.
 *
 * `--force-with-lease` rather than `--force`: the group rebases onto the base
 * routinely, so its branch legitimately diverges from what was pushed last time
 * and a plain push would be refused forever. The lease is what keeps that from
 * becoming "overwrite whatever is there" — and it needs the remote-tracking ref
 * to be current, which is what the fetch above it is for. A lease that fails is
 * somebody else writing this branch, which is worth stopping on.
 */
export async function pushBranch(ctx: Ctx, grpId: number): Promise<{ ok: boolean; reason?: string }> {
  try {
    return await push(ctx, grpId);
  } catch (e) {
    return { ok: false, reason: `${(e as Error)?.message ?? e}`.slice(-300) };
  }
}

async function push(ctx: Ctx, grpId: number): Promise<{ ok: boolean; reason?: string }> {
  const kept = await keepBranch(ctx, grpId);
  // An empty bundle means nothing new to push, not a failure — but the branch
  // may still be unpushed from an earlier turn, so this carries on.
  if (!kept.ok && !/empty bundle/i.test(kept.reason ?? "")) return kept;

  const grp = ctx.db
    .query<{ branch: string | null; project_id: number }, [number]>("SELECT branch, project_id FROM grp WHERE id = ?")
    .get(grpId);
  if (!grp?.branch) return { ok: false, reason: "group has no branch" };
  const remote = remoteFor(ctx, grp.project_id);
  if (!remote) return { ok: false, reason: "project has no remote" };
  const mirror = await ensureMirror(ctx, remote);

  // Not checked: the branch may not be on the remote at all yet, which is the
  // ordinary first push and not a failure.
  await utilGit(ctx, ["fetch", "origin", grp.branch], mirror);
  const pushed = await utilGit(ctx, ["push", "--force-with-lease", "origin", `refs/heads/${grp.branch}`], mirror);
  return pushed.code === 0 ? { ok: true } : { ok: false, reason: pushed.out.slice(-300) };
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
 *
 * Every way out of here that is not a clone says so. All of them used to
 * `return` silently, and the group then ran a whole turn against an empty
 * `/work` — RUNNING, an agent on the roster, nothing anywhere reporting a
 * problem. Same family as `reconcileOwnership`'s silent skip. They stay early
 * returns rather than throws: a clone that actually fails is `createCheckout`'s
 * to throw, and `executor.ts` already turns that into a failed turn.
 *
 * There were four; there are three. The fourth was "the host has no git", which
 * stopped being a way this can fail when the remote stopped being read out of a
 * host checkout.
 */
export async function ensureCheckout(ctx: Ctx, grpId: number): Promise<void> {
  // `on`, not `grpId`, for exactly one of them: `event.grp_id` is a foreign key
  // to `grp`, so an event about a group that is not in the table cannot be
  // written against it. That one goes out unscoped and names the id in its body.
  const report = (why: string, on: number | null = grpId): void => {
    ctx.bus.emit({
      grpId: on,
      author: "orchestrator",
      kind: "state_change",
      severity: "blocker",
      body: `${why}，/work 还是空的 —— 这一轮没有代码可跑`,
    });
  };

  const grp = ctx.db
    .query<{ name: string; project_id: number; branch: string | null }, [number]>(
      "SELECT name, project_id, branch FROM grp WHERE id = ?",
    )
    .get(grpId);
  if (!grp) return report(`grp 表里找不到组 ${grpId}`, null);
  // Still two questions, not one: a project that is gone and a project with no
  // remote recorded send the reader to different places.
  const project = ctx.db
    .query<{ remote: string | null }, [number]>("SELECT remote FROM project WHERE id = ?")
    .get(grp.project_id);
  if (!project) return report(`项目不在了（project ${grp.project_id} 查不到）`);
  const remote = remoteFor(ctx, grp.project_id);
  if (!remote) return report(`project ${grp.project_id} 没记下 remote，无从 clone`);
  await createCheckout(ctx, { grp: grpId }, {
    remote,
    branch: grp.branch ?? `orch/${grp.name}`,
    base: await baseRefFor(ctx, grp.project_id),
  });
}
