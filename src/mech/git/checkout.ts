import { msg } from "@lingui/core/macro";
import type { Said } from "../../contracts/said.ts";
import { errText, tail } from "../../platform/process/text.ts";
import { SpanStatusCode } from "@opentelemetry/api";
import { activeTracer } from "../../platform/observability/traces.ts";
import { z } from "zod";
import type { Ctx } from "../../mech/ctx.ts";
import type { DB } from "../../platform/persistence/database.ts";
import { and, eq, isNull } from "drizzle-orm";
import { grp as grps, project } from "../../platform/persistence/schema.ts";
import { execIn, execLines, getBytes, putBytes, SKILL_SYNC, UTIL, WORK, type Scope } from "../sandbox/sandbox.ts";
import { sandboxLog } from "../sandbox/sandboxlog.ts";
import { cacheProjectSkills } from "../skills.ts";
import { shq } from "../../platform/process/shell.ts";
import type { GitRunner } from "./gitops.ts";
import { commitIdentity } from "./ghlogin.ts";

const Repo = z.object({
  default_branch: z.string().optional(),
  full_name: z.string().optional(),
  clone_url: z.string().optional(),
});
const Branches = z.array(z.object({ name: z.string() }));

/**
 * A group's code, inside its sandbox.
 *
 * A clone, not a `git worktree`: a worktree's `.git` points back into the main
 * checkout, so committing inside a container would mean mounting the whole
 * repository in. The host fetches the branch from the remote instead, so review,
 * gates-on-merge and the PR still run against ordinary local refs.
 */

/**
 * Which branch this project's work is cut from and measured against.
 *
 * Stored, not detected: it is the diff baseline, so it must read the same on the
 * day a slice was cut and the day its diff is read. NULL means "whatever the
 * remote's HEAD says", resolved once and written back; re-detected when the
 * stored name is gone from the remote, and announced when it changes.
 */
/**
 * A rename or transfer on github.com, written back rather than followed.
 *
 * GitHub redirects `GET /repos/old/name`, but a `POST` to open a pull request
 * does not survive one — and the old URL keeps working only until somebody
 * claims the freed name.
 */
async function followRename(
  ctx: Ctx,
  projectId: number,
  was: string,
  repo: z.infer<typeof Repo> | undefined,
): Promise<void> {
  if (!repo?.full_name || repo.full_name === was) return;
  await ctx.db
    .update(project)
    .set({
      repo_path: repo.full_name,
      // The clone URL only when there is one: `coalesce(?, remote)` kept the
      // stored remote when GitHub answered without one.
      ...(repo.clone_url === undefined ? {} : { remote: repo.clone_url }),
    })
    .where(eq(project.id, projectId));
  await ctx.bus?.emit({
    grpId: null,
    author: "orchestrator",
    kind: "state_change",
    severity: "advisory",
    say: msg`the repository was renamed on GitHub: ${{ was }} → ${{ now: repo.full_name }}. We have followed it, and clones and PRs point at the new one.`,
  });
}

export async function baseBranch(ctx: Ctx, projectId: number): Promise<string> {
  const [row] = await ctx.db
    .select({
      repo_path: project.repo_path,
      base_branch: project.base_branch,
      base_branch_pinned: project.base_branch_pinned,
    })
    .from(project)
    .where(eq(project.id, projectId));
  if (!row) return "main";

  // Never host git: `repo_path` is `owner/name`, not a directory, and `Bun.spawn`
  // throws rather than returning a code when the cwd does not exist. Asked every
  // time rather than only when the column is empty: the shared client sends
  // `If-None-Match`, and a 304 does not count against the rate limit.
  const r = await ctx.gh?.request("GET", `/repos/${row.repo_path}`, Repo);
  if (r?.ok) await followRename(ctx, projectId, row.repo_path, r.data);
  const found = (r?.ok && r.data?.default_branch) || null;
  // Nothing to compare against: keep what is stored rather than resetting a
  // project that develops on `develop` to `main` because the network blinked.
  if (!found) return row.base_branch ?? ctx.config.baseBranchFallbacks[0] ?? "main";
  // A branch the boss picked in settings is an answer, not a cache of GitHub's.
  // This used to overwrite it every call — and this runs on the heartbeat, so a
  // choice survived about thirty seconds.
  if (row.base_branch_pinned && row.base_branch) return row.base_branch;
  if (found !== row.base_branch) {
    // Conditional on the value that was read, so of two callers racing on the
    // same tick only one writes and only one announces it. Both used to: the
    // event feed carried the identical line twice, 29 seconds apart, because
    // each had read the old value before either wrote.
    // `IS` in SQLite compared NULL to NULL; `eq` does not, so a project that has
    // never had a base branch needs `IS NULL` to match itself.
    const wrote = await ctx.db
      .update(project)
      .set({ base_branch: found })
      .where(
        and(
          eq(project.id, projectId),
          row.base_branch === null ? isNull(project.base_branch) : eq(project.base_branch, row.base_branch),
        ),
      )
      .returning({ id: project.id });
    // Only when it *changed*, not when it was first learned: it changes what
    // every later diff means.
    if (wrote.length > 0 && row.base_branch) {
      await ctx.bus?.emit({
        grpId: null,
        author: "orchestrator",
        kind: "state_change",
        severity: "advisory",
        say: msg`the base branch moved from ${{ was: row.base_branch }} to ${{ now: found }}, because the default branch on the remote changed. Every clone, rebase and diff from here on is against it.`,
      });
    }
  }
  return found;
}

/**
 * Every branch on the remote, for the settings page's picker.
 *
 * Best effort by design, and the box stays typeable: a new branch, a login that
 * cannot list them, or GitHub being down must not stop the field working, so an
 * empty list means "no suggestions", never "no". One page — a repository with
 * more than a hundred branches has more than this control should render.
 */
export async function listBranches(ctx: Ctx, projectId: number): Promise<string[]> {
  const [row] = await ctx.db.select({ repo_path: project.repo_path }).from(project).where(eq(project.id, projectId));
  const repo = row?.repo_path;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return [];
  const r = await ctx.gh?.request("GET", `/repos/${repo}/branches?per_page=100`, Branches);
  if (!r?.ok) return [];
  return r.data.map((b) => b.name).filter(Boolean);
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
  return async (argv, cwd) => {
    const r = await execIn(ctx, scope, `git ${argv.map(shq).join(" ")}`, { cwd: cwd ?? WORK });
    // stderr only when the command failed — that is where the reason lives and
    // callers read `out` for it. On success stderr is warnings, and porcelain `-z`
    // output is one NUL-terminated blob, so an appended line becomes a path.
    return { code: r.code, out: (r.code === 0 ? r.out : `${r.out}${r.err}`).trimEnd() };
  };
}

/**
 * `origin`, as a URL a sandbox can actually clone.
 *
 * The boss's remote is usually SSH and a sandbox has no key — nor should it: an
 * SSH key is not something the credential vault can inject, which works on HTTP
 * headers. Over HTTPS a read-only token is bound at the sidecar instead, and the
 * remote is rewritten rather than refused: it is theirs, this is only how we reach it.
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
 * The stored remote, not `git remote get-url` against a host checkout: that was
 * the last thing in the clone path requiring the host to be a git participant,
 * and it was a way for two answers to disagree — a group could clone one
 * repository while its PR opened on another.
 */
export async function remoteFor(db: DB, projectId: number): Promise<string | null> {
  const [row] = await db.select({ remote: project.remote }).from(project).where(eq(project.id, projectId));
  return row?.remote ? httpsRemote(row.remote) : null;
}

export interface CheckoutSpec {
  remote: string;
  branch: string;
  /** What to branch from. `origin/main` unless a group was told otherwise. */
  base: string;
  /**
   * Whose skills cache this checkout's own `.claude/skills` and friends belong
   * to. Omitted by a caller with no project — nothing is enumerated, and the
   * linking still happens, because delivery is not the part that needs a row.
   */
  projectId?: number | null;
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
    const r = await execIn(ctx, scope, cmd, opts);
    return { code: r.code, out: `${r.out}${r.err}` };
  }
  sandboxLog(ctx.bus, grpId, "cmd", cmd);
  // Stderr streams here rather than arriving in one block at the end: for
  // `git clone --progress` that block *was* the whole log.
  const stream = execLines(ctx, scope, cmd, { ...opts, onStderr: (l) => sandboxLog(ctx.bus, grpId, "out", l) });
  const seen: string[] = [];
  for (;;) {
    const step = await stream.next();
    if (step.done) {
      sandboxLog(ctx.bus, grpId, "end", step.value.code === 0 ? "ok" : `exit ${step.value.code}`);
      return { code: step.value.code, out: [...seen, step.value.err].filter(Boolean).join("\n") };
    }
    seen.push(step.value);
    if (seen.length > 400) seen.shift();
    sandboxLog(ctx.bus, grpId, "out", step.value);
  }
}

export async function createCheckout(ctx: Ctx, scope: Scope, spec: CheckoutSpec): Promise<void> {
  // The one a reader is looking for: nine serial execs, a bare clone and a fetch,
  // once per requirement. It had no row of its own, so the cost showed up only as
  // a scattering of `sandbox.exec` and nothing said they were one operation.
  await gitSpan("git.create_checkout", { "project.id": spec.projectId ?? 0 }, () =>
    createCheckoutInner(ctx, scope, spec),
  );
}

async function createCheckoutInner(ctx: Ctx, scope: Scope, spec: CheckoutSpec): Promise<void> {
  // Folded into the probe that was already happening, so a skill pushed this
  // morning is delivered this afternoon rather than whenever the container next
  // happens to be rebuilt. `SKILL_SYNC` cannot fail this command; see its own note.
  const already = await execIn(ctx, scope, `${SKILL_SYNC}; test -d ${WORK}/.git && echo yes`);
  if (already.out.includes("yes")) {
    await cacheProjectSkills(ctx.db, spec.projectId, already.out);
    return;
  }

  // `GIT_TERMINAL_PROMPT=0`: without it a repository the sandbox cannot read stops
  // on "could not read Username" and waits on a prompt nobody will answer. `shq`,
  // not `JSON.stringify` — the latter emits *double* quotes, under which `sh` still
  // expands `$(…)`, and the remote can come from `postProject`'s request body.
  // `--filter=blob:none`, never `--depth=1`: `rebaseOntoBase` and `merge-base
  // --is-ancestor` need the real history.
  const cloneCmd = `git clone --progress --filter=blob:none ${shq(spec.remote)} ${WORK}`;
  const clone = await streamed(ctx, scope, cloneCmd, {
    timeoutMs: ctx.config.timeouts.transferMs,
    env: { GIT_TERMINAL_PROMPT: "0" },
  });
  if (clone.code !== 0) throw new Error(`git clone failed: ${clone.out.slice(-400)}`);

  // Two places the branch can be:
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

  // An agent commits as itself, from the connected GitHub account: a repository
  // enforcing DCO requires `Signed-off-by` to match the author, and
  // `orch agent <agent@orch.local>` is not an identity anyone signed as.
  const who = await commitIdentity(ctx);
  await execIn(ctx, scope, `git config user.name ${shq(who.name)} && git config user.email ${shq(who.email)}`, {
    cwd: WORK,
  });

  // codex reads AGENTS.md where claude reads CLAUDE.md: same instructions, two
  // names. Linked rather than copied so editing one cannot leave a stale twin, and
  // both ways because a codex-native repo ships only AGENTS.md, and a claude turn
  // in it otherwise runs with no project instructions at all, silently.
  await execIn(ctx, scope, LINK_AGENTS_MD, { cwd: WORK });

  // Again, now that there is a checkout to find them in. The probe above ran
  // against an empty `/work`, so this is the run that actually links and lists a
  // repository's own skills — every later turn's probe just keeps it current.
  const synced = await execIn(ctx, scope, SKILL_SYNC);
  await cacheProjectSkills(ctx.db, spec.projectId, synced.out);
}

/**
 * Submodules, in two steps, in the container that is allowed to have them.
 *
 * `git clone --recursive` is CVE-2024-32002 and CVE-2025-48384, and never runs in
 * the utility container. The two steps **are** the mitigation — clone without
 * `--recursive`, init once the working tree exists — collapsing them re-exposes it.
 * `protocol.file.allow=user`: relative submodule URLs are local paths, refused since.
 */
async function initSubmodules(ctx: Ctx, scope: Scope): Promise<void> {
  const has = await execIn(ctx, scope, `test -f ${WORK}/.gitmodules && echo yes`);
  if (has.out.trim() !== "yes") return;
  const r = await execIn(ctx, scope, `git -c protocol.file.allow=user submodule update --init`, {
    cwd: WORK,
    timeoutMs: ctx.config.timeouts.transferMs,
  });
  if (r.code !== 0 && "grp" in scope) {
    // Not fatal: a repository whose submodules will not init is still a
    // repository the group can work in, and the agent bucket (007 §6) is where a
    // failed init belongs — it is something a turn can be given and act on.
    await ctx.bus.emit({
      grpId: scope.grp,
      author: "orchestrator",
      kind: "state_change",
      severity: "warn",
      say: msg`the submodules did not come up, so the checkout may be incomplete: ${{ why: (r.err || r.out).slice(-300) }}`,
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
 * `core.hooksPath=/dev/null` on **every** invocation, not once in a config file:
 * what it defends against is a repository that arranges for a hook to appear, and
 * a config written before that can be outlived. These five verbs and no others —
 * nothing here writes a working tree, so no repository content is ever executed.
 */
const UTIL_VERBS = new Set(["clone", "fetch", "push", "bundle", "ls-tree"]);

export async function utilGit(ctx: Ctx, argv: string[], cwd?: string): Promise<{ code: number; out: string }> {
  const verb = argv[0] ?? "";
  // Throws rather than returning a code: reaching this line is a bug in us, not a
  // condition a caller can be in.
  if (!UTIL_VERBS.has(verb)) {
    throw new Error(`utility container may not run 'git ${verb}': it does fetch/push/bundle and nothing else`);
  }
  // The verb goes in unquoted because it has just been checked against a literal
  // set, so it is one of four words and cannot carry a metacharacter. Everything
  // after it is a branch name, a path or a URL and is quoted like everywhere else.
  const cmd = `git -c core.hooksPath=/dev/null ${verb} ${argv.slice(1).map(shq).join(" ")}`;
  const r = await execIn(ctx, UTIL, cmd, {
    ...(cwd ? { cwd } : {}),
    timeoutMs: ctx.config.timeouts.transferMs,
    env: { GIT_TERMINAL_PROMPT: "0" },
  });
  return { code: r.code, out: `${r.out}${r.err}`.trimEnd() };
}

/** Where this project's bare mirror lives inside the utility container. */
const mirrorPath = (remote: string): string => `/repos/${remote.replace(/[^\w.-]+/g, "-")}`;

/**
 * The project's bare mirror, made once and brought up to date.
 *
 * `--bare` so nothing is written in a form anything would execute, and
 * `--filter=blob:none` because this needs refs and objects, never contents. The
 * fetch refspec is explicit: `git clone --bare` writes **no** `remote.origin.fetch`
 * — `--mirror` does — so without it the mirror freezes; `--prune` drops dead branches.
 */
async function ensureMirror(ctx: Ctx, remote: string): Promise<string> {
  return gitSpan("git.ensure_mirror", {}, () => ensureMirrorInner(ctx, remote));
}

async function ensureMirrorInner(ctx: Ctx, remote: string): Promise<string> {
  const path = mirrorPath(remote);
  const there = await execIn(ctx, UTIL, `test -d ${shq(path)} && echo yes`);
  if (there.out.trim() === "yes") return path;
  const made = await utilGit(ctx, ["clone", "--bare", "--filter=blob:none", remote, path]);
  if (made.code !== 0) throw new Error(`utility container could not mirror ${remote}: ${made.out.slice(-300)}`);
  return path;
}

/**
 * The mirror, and its refs current with the remote. Only for a caller that reads them.
 *
 * This used to be inside `ensureMirror`, so all three callers paid a network
 * round trip they had not asked for: measured, 1,184 fetches costing **2,608
 * seconds** in one day. Two of them never needed it. `keepBranch` fetches a local
 * bundle and already retries with an explicit `fetch origin` on the one failure
 * that means the mirror is behind; `pushBranch` only sends `refs/orch/*` outward.
 * `listTree` is the caller that reads refs, so it is the caller that pays.
 */
async function freshMirror(ctx: Ctx, remote: string): Promise<string> {
  const path = await ensureMirror(ctx, remote);
  return gitSpan("git.fetch_mirror", {}, async () => {
    // Best-effort: a mirror that cannot reach the remote right now is stale, and
    // stale is what the caller already reports. Refusing here would turn one
    // unreachable network into an empty file list.
    await utilGit(ctx, ["fetch", "--prune", "origin", "+refs/heads/*:refs/heads/*"], path);
    return path;
  });
}

/**
 * Throw the project's mirror away, when the boss removes the project.
 *
 * Here rather than in the caller, and not by exporting `mirrorPath`: a second
 * file deriving the same path is a second source of truth, and the day the
 * convention changes, removal quietly stops finding anything. Best-effort — the
 * mirror holds no record, so failing to delete it costs disk and nothing else.
 */
export async function removeMirror(ctx: Ctx, remote: string): Promise<boolean> {
  try {
    const r = await execIn(ctx, UTIL, `rm -rf ${shq(mirrorPath(remote))}`);
    return r.code === 0;
  } catch {
    return false;
  }
}

/**
 * Every tracked path at a ref, without a working tree anywhere.
 *
 * No clone of its own: the utility container already keeps a bare mirror per
 * project, and `ls-tree` answers "what files are there" against a bare repository
 * exactly as `ls-files` does against a worktree. Empty on any failure, and the
 * callers say so once — a stale map is not a reason to stop a tick.
 */
export async function treeFiles(ctx: Ctx, remote: string, branch: string): Promise<string[]> {
  return (await listTree(ctx, remote, branch)).files;
}

/**
 * The same, with the reason it is empty.
 *
 * Four things used to arrive as `[]` — container unreachable, clone refused, ref
 * absent, repository genuinely empty — and the caller reporting it had to guess.
 * Takes a **branch**, not a ref: a bare mirror has `refs/heads/main` and no
 * `refs/remotes/` at all, so `baseRefFor`'s `origin/main` is not a name it has.
 */
export async function listTree(
  ctx: Ctx,
  remote: string,
  branch: string,
): Promise<{ files: string[]; why: string | null }> {
  // Two spans, because they fail and cost differently: the mirror is a network
  // clone or fetch, `ls-tree` is a local read of what it brought back, and "the
  // repo-map rule is slow" has to resolve to one of them rather than to the rule.
  return activeTracer().startActiveSpan("git.ls_tree", async (span) => {
    try {
      const { files, why, failed } = await listTreeInner(ctx, remote, branch);
      // `why` is not the failure signal, which is why `failed` is separate: a
      // repository that really is empty produces a `why` and a command that
      // worked. `listTreeInner` never throws, so a span that errored only in the
      // catch below could not error at all.
      if (failed !== null) span.setStatus({ code: SpanStatusCode.ERROR, message: failed });
      return { files, why };
    } catch (e) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: errText(e) });
      throw e;
    } finally {
      span.end();
    }
  });
}

async function listTreeInner(
  ctx: Ctx,
  remote: string,
  branch: string,
): Promise<{ files: string[]; why: string | null; failed: string | null }> {
  const ref = branch.replace(/^origin\//, "");
  let mirror: string;
  try {
    mirror = await freshMirror(ctx, remote);
  } catch (e) {
    const why = errText(e);
    return { files: [], why, failed: why };
  }
  const r = await utilGit(ctx, ["ls-tree", "-r", "--name-only", ref], mirror);
  if (r.code !== 0) {
    const why = `git ls-tree ${ref} exited ${r.code}: ${(r.out || "no output").trim().slice(-300)}`;
    return { files: [], why, failed: why };
  }
  const files = r.out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // An empty repository is an answer, not a failure: the command ran, the ref
  // resolved, and there is nothing in it. The caller still wants the sentence.
  return {
    files,
    why: files.length ? null : `${ref} lists no files — an empty repository, or the wrong ref`,
    failed: null,
  };
}

/**
 * The head of every tracked file, in one round trip. `bytes: null` reads whole
 * files, which a parser needs and a line regex does not.
 *
 * Needs file *contents*, so the mirror cannot serve it: that clone is
 * `--filter=blob:none` and every read is a network fetch. One exec for the corpus.
 */
/**
 * A git operation whose cost is the point, reported as one row.
 *
 * The round trips underneath carry their own spans, but a reader asking "why did
 * this requirement take a minute to start" wants the operation, not nine execs.
 * Most of these report failure by returning rather than throwing, so the caller
 * says which result counts as failure.
 */
async function gitSpan<T>(
  name: string,
  attributes: Record<string, string | number>,
  run: () => Promise<T>,
  failed: (value: T) => string | null = () => null,
): Promise<T> {
  return activeTracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      const value = await run();
      const why = failed(value);
      if (why !== null) span.setStatus({ code: SpanStatusCode.ERROR, message: why });
      return value;
    } catch (e) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: errText(e) });
      throw e;
    } finally {
      span.end();
    }
  });
}

export async function treeHeads(ctx: Ctx, scope: Scope, bytes: number | null): Promise<Map<string, string>> {
  // One exec, but it reads the head of every tracked file inside a container, so
  // the cost scales with the repository rather than with the round trip. This
  // span says whether the index rule waits on the corpus or on the call above it.
  return activeTracer().startActiveSpan("git.tree_heads", async (span) => {
    try {
      const { heads, failed } = await treeHeadsInner(ctx, scope, bytes);
      // A container that cannot be read is deliberately not an error to the
      // caller — an unreadable corpus means "nothing changed", the safe product
      // answer. Still an error on the span: a tick that spent a round trip
      // failing must not look exactly like one that succeeded.
      if (failed !== null) span.setStatus({ code: SpanStatusCode.ERROR, message: failed });
      return heads;
    } catch (e) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: errText(e) });
      throw e;
    } finally {
      span.end();
    }
  });
}

async function treeHeadsInner(
  ctx: Ctx,
  scope: Scope,
  bytes: number | null,
): Promise<{ heads: Map<string, string>; failed: string | null }> {
  const marker = "\u0001==";
  const r = await execIn(
    ctx,
    scope,
    `cd ${shq(WORK)} && git ls-files -z | while IFS= read -r -d "" f; do ` +
      `printf '%s%s\n' ${shq(marker)} "$f"; ${bytes === null ? "cat" : `head -c ${bytes}`} -- "$f"; printf '\n'; done`,
  );
  const out = new Map<string, string>();
  if (r.code !== 0) return { heads: out, failed: `git ls-files exited ${r.code}: ${tail(r.out || r.err, 300)}` };
  for (const chunk of r.out.split(marker)) {
    const nl = chunk.indexOf("\n");
    if (nl <= 0) continue;
    out.set(chunk.slice(0, nl).trim(), chunk.slice(nl + 1));
  }
  return { heads: out, failed: null };
}

/**
 * A group's commits, out of its container and into the mirror. No network.
 *
 * Called every turn, deliberately: a container that dies — TTL, a crash, a
 * restart — then costs the turn in flight and nothing else. A bundle carries
 * objects and never a credential, which is why the direction is one-way: out of
 * the agent's container, never in. See `readOnlyGitPaths` for the other half.
 */
/**
 * A branch operation on one group: spanned, and never allowed to throw.
 *
 * Both callers promise a returned reason rather than an exception, so the catch
 * and the span's own failure test are the same two lines twice.
 */
function branchOp(
  name: string,
  grpId: number,
  run: () => Promise<{ ok: boolean; reason?: string }>,
): Promise<{ ok: boolean; reason?: string }> {
  return gitSpan(
    name,
    { "grp.id": grpId },
    async () => {
      try {
        return await run();
      } catch (e) {
        return { ok: false, reason: tail(errText(e, 100_000), 300) };
      }
    },
    (r) => (r.ok ? null : (r.reason ?? "failed")),
  );
}

export async function keepBranch(ctx: Ctx, grpId: number): Promise<{ ok: boolean; reason?: string }> {
  // Every way out of here is a returned reason, never a throw. Two callers are a
  // turn that has already finished its work and a slice acceptance that is not
  // awaited — for both, a container that cannot be opened has to be a reported
  // failure rather than an exception that takes the turn or the process with it.
  return branchOp("git.keep_branch", grpId, () => keep(ctx, grpId));
}

async function branchRemote(
  db: DB,
  grpId: number,
): Promise<{ ok: true; branch: string; projectId: number; remote: string } | { ok: false; reason: string }> {
  const [grp] = await db
    .select({ branch: grps.branch, project_id: grps.project_id })
    .from(grps)
    .where(eq(grps.id, grpId));
  if (!grp?.branch) return { ok: false, reason: "group has no branch" };
  const remote = await remoteFor(db, grp.project_id);
  return remote
    ? { ok: true, branch: grp.branch, projectId: grp.project_id, remote }
    : { ok: false, reason: "project has no remote" };
}

async function keep(ctx: Ctx, grpId: number): Promise<{ ok: boolean; reason?: string }> {
  const found = await branchRemote(ctx.db, grpId);
  if (!found.ok) return found;
  const { branch, remote, projectId } = found;
  const base = await baseRefFor(ctx, projectId);

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
  // Under `refs/orch/`, not `refs/heads/`: `ensureMirror` prunes with
  // `+refs/heads/*:refs/heads/*`, and prune deletes by the destination — measured,
  // a local-only branch there is reported `- [deleted] (none)` and is gone before
  // `push` can send it. `refs/heads/*` stays a mirror of the remote for `listTree`.
  const ref = `+refs/heads/${branch}:refs/orch/${branch}`;
  const fetched = await utilGit(ctx, ["fetch", inUtil, ref], mirror);
  if (fetched.code === 0) return { ok: true };

  // "Repository lacks these prerequisite commits" is not a corrupt bundle: it is
  // cut `--not <base>`, so its prerequisites are commits on a base this mirror has
  // not seen since it was cloned. One `fetch origin` and a retry, only on this
  // failure, so the ordinary turn still costs no network.
  if (!/prerequisite/i.test(fetched.out)) return { ok: false, reason: fetched.out.slice(-300) };
  await utilGit(ctx, ["fetch", "origin"], mirror);
  const again = await utilGit(ctx, ["fetch", inUtil, ref], mirror);
  return again.code === 0 ? { ok: true } : { ok: false, reason: again.out.slice(-300) };
}

/**
 * The branch, on the remote. Slice boundaries and PR time, never every turn.
 *
 * `--force`, not `--force-with-lease`: the group rebases routinely so its branch
 * legitimately diverges, and the lease could not hold anyway — a `--bare` clone
 * has no `refs/remotes/origin/*`, so it had nothing to compare against and was
 * rejected `(stale info)`. The branch lives under `orch/`, which only we write.
 */
export async function pushBranch(ctx: Ctx, grpId: number): Promise<{ ok: boolean; reason?: string }> {
  return branchOp("git.push_branch", grpId, () => push(ctx, grpId));
}

async function push(ctx: Ctx, grpId: number): Promise<{ ok: boolean; reason?: string }> {
  const kept = await keepBranch(ctx, grpId);
  // An empty bundle means nothing new to push, not a failure — but the branch
  // may still be unpushed from an earlier turn, so this carries on.
  if (!kept.ok && !/empty bundle/i.test(kept.reason ?? "")) return kept;

  const found = await branchRemote(ctx.db, grpId);
  if (!found.ok) return found;
  const mirror = await ensureMirror(ctx, found.remote);

  const pushed = await utilGit(
    ctx,
    ["push", "--force", "origin", `refs/orch/${found.branch}:refs/heads/${found.branch}`],
    mirror,
  );
  return pushed.code === 0 ? { ok: true } : { ok: false, reason: pushed.out.slice(-300) };
}

/**
 * The group's checkout, wherever the group is in its life.
 *
 * `startGroup` is not the only way a turn happens: a group can outlive its
 * sandbox, and a group predating this design has a branch but never a clone. Both
 * look the same from here — an empty `/work`. Every way out that is not a clone
 * says so, and stays an early return: a failing clone is `createCheckout`'s throw.
 */
export async function ensureCheckout(ctx: Ctx, grpId: number): Promise<void> {
  // `on`, not `grpId`, for exactly one of them: `event.grp_id` is a foreign key
  // to `grp`, so an event about a group that is not in the table cannot be
  // written against it. That one goes out unscoped and names the id in its body.
  /**
   * The whole sentence each time, not a reason threaded into a shared tail: a
   * descriptor inside another's values is "values, never text". Three repeated
   * clauses is what not doing it costs.
   */
  const report = async (say: Said, on: number | null = grpId): Promise<void> => {
    await ctx.bus.emit({ grpId: on, author: "orchestrator", kind: "state_change", severity: "blocker", say });
  };

  const [grp] = await ctx.db
    .select({ name: grps.name, project_id: grps.project_id, branch: grps.branch })
    .from(grps)
    .where(eq(grps.id, grpId));
  if (!grp)
    return report(
      msg`no group ${{ grp: grpId }} in the grp table, so /work is still empty — there is no code to run this turn`,
      null,
    );
  // Still two questions, not one: a project that is gone and a project with no
  // remote recorded send the reader to different places.
  const [found] = await ctx.db.select({ remote: project.remote }).from(project).where(eq(project.id, grp.project_id));
  if (!found)
    return report(
      msg`the project is gone (project ${{ project: grp.project_id }} is not there), so /work is still empty — there is no code to run this turn`,
    );
  const remote = await remoteFor(ctx.db, grp.project_id);
  if (!remote)
    return report(
      msg`project ${{ project: grp.project_id }} has no remote recorded, so there is nothing to clone — /work is still empty and there is no code to run this turn`,
    );
  await createCheckout(
    ctx,
    { grp: grpId },
    {
      remote,
      branch: grp.branch ?? `orch/${grp.name}`,
      base: await baseRefFor(ctx, grp.project_id),
      projectId: grp.project_id,
    },
  );
}
