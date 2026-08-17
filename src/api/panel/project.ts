import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { SandboxOverrideSchema, StoredProjectConfigSchema } from "../../config-schema.ts";
import { JsonObject, JsonValue, jsonOr } from "../../contracts/json.ts";
import { runInstall } from "../../mech/flow/start.ts";
import { GateName } from "../../mech/gate.ts";
import { baseBranch, listBranches, removeMirror } from "../../mech/git/checkout.ts";
import { pushBlocked } from "../../mech/git/prwatch.ts";
import { forgetHolds } from "../../mech/git/repository.ts";
import { allowedImage, killSandbox } from "../../mech/sandbox/sandbox.ts";
import { clearSandboxLog } from "../../mech/sandbox/sandboxlog.ts";
import { forgetProjectSkills } from "../../mech/skills.ts";
import { projectConfig } from "../../mech/util/rows.ts";
import { errText } from "../../mech/util/text.ts";
import type { Result } from "../../mech/util/validate.ts";
import { abortJob } from "../../runtime/running.ts";
import { ACTIVE_JOB_STATES, stateParam } from "../../states.ts";
import { IdParams } from "../../contracts/fields.ts";
import type { AgentHandler, Handler } from "../../http/handler.ts";
import { bad, json, message } from "../../http/respond.ts";

/**
 * A repository this fleet works on: added, configured, and removed.
 *
 * Removal is the interesting half. A project is the root of most of the schema,
 * so tearing one down is an ordered cascade of twenty statements plus the
 * containers, the mirror and the holds — and the order is the correctness
 * argument, which is why the list is a named constant rather than twenty calls
 * inline.
 */

/**
 * The bootstrap role's one verb: make this checkout buildable.
 *
 * The command comes from the agent because nobody can enumerate them — bun,
 * poetry, uv, mise, a Makefile target — and the repo says which one it is. It
 * used to be checked against a list of package-manager names before running on
 * the host; it runs inside the group's own sandbox now, so what it *is* stopped
 * mattering. What is worth keeping is the answer, so the next group does not pay
 * to read the same repo again.
 */
const InstallCommand = z.string().max(2000);
const GateNames = z.array(GateName).max(40);
const GithubRepo = z.object({
  full_name: z.string(),
  default_branch: z.string(),
  clone_url: z.string(),
  permissions: z.record(z.string(), z.boolean()).optional(),
});

/** The install command this project needs, or `none` for "it needs nothing". */
export const SetupBody = z.object({ cmd: InstallCommand.optional(), none: z.boolean().optional() });

export const postSetup = (async (ctx, _req, a, _p, b) => {
  if (a.role !== "bootstrap") return bad(`${a.role} does not set this project up`);
  if (!a.grp_id) return bad("this agent has no group");
  const grp = ctx.db.query<{ project_id: number }, [number]>("SELECT project_id FROM grp WHERE id = ?").get(a.grp_id);
  if (!grp) return bad("this agent has no group");

  if (b.none) {
    ctx.db.run("UPDATE project SET config_json = json_set(config_json, '$.install', json('null')) WHERE id = ?", [
      grp.project_id,
    ]);
    ctx.bus.emit({ grpId: a.grp_id, author: a.role, kind: "state_change", body: "这个仓库不需要装什么" });
    return message("ok");
  }

  const cmd = (b.cmd ?? "").trim();
  if (!cmd) return bad('setup needs --cmd "<command>" or --none');
  // Same streamed install the first turn gets: the boss watches this one too,
  // and an agent's own attempt is the one most likely to need watching.
  const r = await runInstall(ctx, a.grp_id, cmd);
  // Remembered on the project, so the next group does not pay for the same
  // reading — and so the boss can see and correct what its groups run.
  if (r.ok) {
    ctx.db.run("UPDATE project SET config_json = json_set(config_json, '$.install', ?) WHERE id = ?", [
      cmd,
      grp.project_id,
    ]);
  }
  return r.ok ? message("ok") : bad(`install failed:\n${r.tail}`);
}) satisfies AgentHandler<z.infer<typeof SetupBody>>;

/**
 * Register a repository this login can reach. There is no other kind of project.
 *
 * A project used to be a directory on this host, and everything that made it one
 * — `expandHome`, `checkRepoPath`, the `origin` lookup, gate/install detection,
 * the PR preflight — read a checkout at registration time. None of that can run
 * before a clone exists, and 007 §2 already decided where it goes instead:
 * after the first group's clone, writing its guess into project config. What is
 * left here is what GitHub can answer in one request.
 */
export const ProjectBody = z.object({
  repo: z.string().max(200).default(""),
  name: z.string().max(80).optional(),
  gates: GateNames.optional(),
});

export const postProject = (async (ctx, req, _p, b) => {
  const want = b.repo.trim();
  if (!want) return bad("which repository? (owner/name)");
  if (!ctx.gh) return bad("this server has no GitHub client");

  // Asked of GitHub rather than trusted from the browser: the default branch is
  // written into the row, and a wrong one is a group that branches off nothing.
  const r = await ctx.gh.request("GET", `/repos/${want}`, GithubRepo, undefined, req.signal);
  if (!r.ok) return bad(r.message);
  const repoPath = r.data.full_name;
  const remote = r.data.clone_url;
  const baseBranch = r.data.default_branch || null;
  const name = (b.name ?? "").trim() || repoPath.split("/")[1] || repoPath;

  const dup = ctx.db.query<{ name: string }, [string]>("SELECT name FROM project WHERE repo_path = ?").get(repoPath);
  if (dup) return bad(`${repoPath} is already registered as "${dup.name}"`);

  const gates = b.gates ?? [];
  const row = ctx.db
    .query<{ id: number }, [string, string, string, string, string | null]>(
      `INSERT INTO project (name, repo_path, remote, config_json, base_branch, created_at)
       VALUES (?, ?, ?, ?, ?, unixepoch() * 1000) RETURNING id`,
    )
    .get(name, repoPath, remote, JSON.stringify({ gates }), baseBranch)!;

  // Said rather than silently guessed at: nothing was looked at, because there is
  // nothing to look at until a group clones (007 §2).
  ctx.bus.emit({
    author: "orchestrator",
    kind: "state_change",
    body:
      `${name}（${repoPath} · ${baseBranch ?? "默认分支"}）加好了。闸门和安装命令等第一个组克隆完再猜，` +
      `现在填也行：设置 → 闸门。`,
  });
  // Registered, and then told the truth about it. Read access is enough to clone
  // and work, so this does not refuse the repository — it refuses to let the boss
  // find out at the end, when a group has done everything and the push is the
  // only step left. No extra request: the answer above carries it.
  const blocked = pushBlocked(r.data.permissions, repoPath);
  if (blocked) {
    ctx.bus.emit({
      author: "orchestrator",
      kind: "state_change",
      severity: "blocker",
      body: `${repoPath} 加好了，但这个登录推不上去：${blocked}。现在处理，别等第一个切片做完。`,
    });
  }

  ctx.sched.tick();
  return json({ id: row.id, gates });
}) satisfies Handler<z.infer<typeof ProjectBody>>;

/**
 * Rows to clear for one project, in an order SQLite will accept.
 *
 * Nothing declares `ON DELETE CASCADE` (`PRAGMA foreign_key_list` says NO ACTION
 * on every one), so the order is the whole correctness of this: children before
 * parents, and the two that are easy to miss are `escalation` → `note` and
 * `note` → `task`, which put those three in an order that reads backwards.
 *
 * Written as a list rather than one long function because the next table with a
 * `grp_id` has to appear here, and a list makes that a one-line change with a
 * visible place to put it.
 */
const G = "SELECT id FROM grp WHERE project_id = ?1";

const A = `SELECT id FROM agent WHERE project_id = ?1 OR grp_id IN (${G})`;

const C = `SELECT id FROM channel WHERE project_id = ?1 OR grp_id IN (${G})`;

const S = `SELECT id FROM slice WHERE grp_id IN (${G})`;

const PROJECT_ROWS: string[] = [
  `DELETE FROM cursor WHERE channel_id IN (${C}) OR agent_id IN (${A})`,
  `DELETE FROM member WHERE channel_id IN (${C}) OR agent_id IN (${A})`,
  `DELETE FROM lease WHERE grp_id IN (${G}) OR agent_id IN (${A})`,
  `DELETE FROM job WHERE grp_id IN (${G}) OR agent_id IN (${A}) OR slice_id IN (${S})`,
  `DELETE FROM escalation WHERE grp_id IN (${G}) OR agent_id IN (${A})`,
  `DELETE FROM event WHERE grp_id IN (${G}) OR channel_id IN (${C})`,
  `DELETE FROM note WHERE project_id = ?1 OR grp_id IN (${G}) OR slice_id IN (${S})`,
  `DELETE FROM task WHERE grp_id IN (${G}) OR slice_id IN (${S})`,
  `DELETE FROM slice WHERE grp_id IN (${G})`,
  `DELETE FROM channel WHERE id IN (${C})`,
  `DELETE FROM agent WHERE id IN (${A})`,
  // `grp.blocked_on` points at another grp. Clearing it first is what lets the
  // whole set go in one statement.
  `UPDATE grp SET blocked_on = NULL WHERE blocked_on IN (${G})`,
  `DELETE FROM grp WHERE project_id = ?1`,
  `DELETE FROM project WHERE id = ?1`,
];

/**
 * Remove a project: everything of ours, nothing of GitHub's.
 *
 * **This is the one place in this codebase where deleting is right, and it
 * contradicts the rule everywhere else.** `dropGroup`'s comment — "archiving
 * must never mean deleting" — is correct for a group: what a group did is the
 * record, and a dropped one keeps every event. A project being removed is the
 * boss saying they do not want the record either. Two different acts, and the
 * panel must never let one be mistaken for the other: 不做了 archives, this
 * erases.
 *
 * **The remote is never touched.** No branch is deleted, no PR is closed, no
 * GitHub call that writes anything is made from here — the only GitHub state
 * this drops is a hold in our own memory. Removing a project removes our copy
 * of the work; a boss who found their branches gone from GitHub afterwards
 * would have been robbed by a cleanup button.
 *
 * Order matters twice over: containers before rows, because a killed row takes
 * the sandbox id with it and an unnamed container lives until its TTL; and jobs
 * before containers, so nothing starts a turn against a project that is going
 * away.
 */
export const deleteProject = (async (ctx, _req, params) => {
  const id = params.id;
  const p = ctx.db
    .query<{ name: string; repo_path: string; remote: string | null }, [number]>(
      "SELECT name, repo_path, remote FROM project WHERE id = ?",
    )
    .get(id);
  if (!p) return message("no such project", 404);
  const grps = ctx.db.query<{ id: number }, [number]>("SELECT id FROM grp WHERE project_id = ?").all(id);

  // 1. Nothing new starts, and what is running is actually stopped.
  //
  // Marking the row cancelled is not stopping it. The stream reader stays
  // attached, the CLI keeps running until the container dies on the next line,
  // and its writes then land on rows that are gone — a foreign key failure
  // inside a turn whose group no longer exists, which surfaces as an unhandled
  // rejection with nothing in the message about a project having been removed.
  // `abortJob` is what the offline hold already uses for the same shape.
  //
  // Both scopes: a project's standing agents (Architect, CoS, Dispatcher) have
  // `grp_id` NULL and `project_id` set, so a `grp_id IN (…)` filter left every
  // one of their turns running against a project that was being erased.
  const doomed = ctx.db
    .query<{ id: number }, [string, number]>(
      `SELECT id FROM job
        WHERE state IN (SELECT value FROM json_each(?1))
          AND (grp_id IN (SELECT id FROM grp WHERE project_id = ?2)
               OR agent_id IN (SELECT id FROM agent WHERE project_id = ?2))`,
    )
    .all(stateParam(ACTIVE_JOB_STATES), id);
  let stopped = 0;
  for (const j of doomed) if (abortJob(j.id)) stopped++;
  ctx.db.run(
    `UPDATE job SET state = 'cancelled', ended_at = unixepoch() * 1000, error = 'project removed'
      WHERE state IN (SELECT value FROM json_each(?1))
        AND (grp_id IN (SELECT id FROM grp WHERE project_id = ?2)
             OR agent_id IN (SELECT id FROM agent WHERE project_id = ?2))`,
    [stateParam(ACTIVE_JOB_STATES), id],
  );
  if (stopped) {
    ctx.bus.emit({
      author: "orchestrator",
      kind: "state_change",
      body: `${p.name}：${stopped} 个在跑的 turn 先掐掉了，再删数据`,
    });
  }

  // 2. Containers, while their ids are still readable.
  const failed: string[] = [];
  for (const g of grps) {
    try {
      await killSandbox(ctx, { grp: g.id });
    } catch (e) {
      failed.push(`grp ${g.id}: ${errText(e)}`);
    }
    clearSandboxLog(g.id);
  }
  try {
    await killSandbox(ctx, { project: id });
  } catch (e) {
    failed.push(`project sandbox: ${errText(e)}`);
  }
  // The bare mirror in the utility container. Its own file owns the path, so
  // that convention has one home; failing is disk, not data — everything in it
  // is on the remote or in a container.
  if (p.remote && !(await removeMirror(ctx, p.remote))) failed.push("mirror");

  // 3. Files, read out of the bodies that name them before those bodies go.
  const root = resolve(join(ctx.config.dataDir, "attachments"));
  const said = ctx.db
    .query<{ body: string }, [number]>(
      `SELECT body FROM note WHERE project_id = ?1 OR grp_id IN (${G})
       UNION ALL SELECT body FROM event WHERE grp_id IN (${G})`,
    )
    .all(id)
    .map((r) => r.body)
    .join("\n");
  for (const m of said.matchAll(/^- (?:\[[^\]]+\] )?(\S+?)(?: \(image\))?$/gm)) {
    const path = resolve(m[1]!);
    // Only inside the attachments directory: these strings come out of prose an
    // agent wrote, and `rm -rf` on whatever one of them happens to say is not a
    // cleanup button.
    if (path.startsWith(`${root}/`)) await rm(path, { recursive: true, force: true }).catch(() => {});
  }

  // 4. Rows, in one transaction: a half-removed project is worse than either end.
  ctx.db.transaction(() => {
    for (const sql of PROJECT_ROWS) ctx.db.run(sql, [id]);
  })();

  // 5. State that outlives the row. `holds` is keyed by `owner/repo` and would
  // hold a repository nobody has any more; clearing all of them costs at most
  // one extra failed turn on another held project, which is what re-arms it.
  // The skills cache is keyed by project id, and ids are reused by SQLite —
  // leaving it would hand the next project this one's skill list.
  forgetHolds("github");
  forgetProjectSkills(ctx.db, id);

  ctx.bus.emit({
    author: "orchestrator",
    kind: "state_change",
    body: `移除了项目 ${p.name}（${p.repo_path}）：${grps.length} 个需求、容器和记录都清掉了。GitHub 上什么都没动。`,
  });
  ctx.sched.tick();
  return json({ ok: true, groups: grps.length, failed });
}) satisfies Handler<undefined, z.infer<typeof IdParams>>;

/**
 * A partial `config_json`, merged key by key. `null` removes one override.
 *
 * Every value with a runtime consumer is checked here. Sandbox uses the same
 * schema as `specFor`, so the write door and the container boundary cannot
 * disagree. Stale keys with no runtime consumer are not accepted: inert data can
 * otherwise become active in a later release without ever crossing validation.
 */
export const ProjectConfigBody = z
  .object({
    baseBranch: z.string().nullable().optional(),
    gates: GateNames.nullable().optional(),
    install: InstallCommand.nullable().optional(),
    sandbox: SandboxOverrideSchema.nullable().optional(),
    index: z
      .object({ exclude: z.array(z.string()).optional() })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

type StoredConfigPatch = Omit<z.infer<typeof ProjectConfigBody>, "baseBranch">;
type StoredProjectConfig = z.infer<typeof StoredProjectConfigSchema>;

function mergeProjectConfig(raw: string, patch: StoredConfigPatch): Result<{ config: StoredProjectConfig }> {
  const current = jsonOr(raw, JsonObject.nullable(), null);
  if (!current) return { ok: false, error: "项目配置必须是一个 JSON 对象；拒绝用一次局部修改覆盖整份配置" };

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete current[key];
    else current[key] = JsonValue.parse(value);
  }
  const checked = StoredProjectConfigSchema.safeParse(current);
  if (!checked.success) return { ok: false, error: z.prettifyError(checked.error) };
  const image = checked.data.sandbox?.image;
  if (image && !allowedImage(image)) {
    return {
      ok: false,
      error:
        `镜像只能是我们发布的（ghcr.io/pamin-labs/…）或者你本地构建的（比如 orch/agent:1）。` +
        `agent 在这个镜像里跑，而它面前是你的代码 —— 换成别处的镜像等于把整条边界交出去，而且从面板上看不出来。`,
    };
  }
  return { ok: true, config: checked.data };
}

export const patchProjectConfig = (async (ctx, _req, params, data) => {
  const id = params.id;
  const row = ctx.db.query<{ config_json: string }, [number]>("SELECT config_json FROM project WHERE id = ?").get(id);
  if (!row) return message("no such project", 404);
  const { baseBranch: nextBase, ...patch } = data;
  // `baseBranch` is a column, not a config_json key: it is read on every clone,
  // rebase and diff. Empty means "ask the remote".
  const changesConfig = Object.keys(patch).length > 0;
  const parsed = jsonOr(row.config_json, JsonObject.nullable(), null);
  let config: StoredProjectConfig = parsed ?? {};
  if (changesConfig) {
    // Validate the whole merge so an unrelated patch cannot bless a malformed
    // field written by an older binary or a database-side repair.
    const merged = mergeProjectConfig(row.config_json, patch);
    if (!merged.ok) return bad(merged.error);
    config = merged.config;
  }

  // Validate first, then write both homes as one act. A rejected image used to
  // return 422 after `base_branch` had already changed.
  ctx.db.transaction(() => {
    if ("baseBranch" in data) {
      const want = (nextBase ?? "").trim();
      ctx.db.run("UPDATE project SET base_branch = ? WHERE id = ?", [want || null, id]);
    }
    if (changesConfig) {
      ctx.db.run("UPDATE project SET config_json = ? WHERE id = ?", [JSON.stringify(config), id]);
    }
  })();
  return json(config);
}) satisfies Handler<z.infer<typeof ProjectConfigBody>, z.infer<typeof IdParams>>;

export const getProjectConfig = (async (ctx, _req, params) => {
  const row = ctx.db
    .query<{ repo_path: string; base_branch: string | null }, [number]>(
      "SELECT repo_path, base_branch FROM project WHERE id = ?",
    )
    .get(params.id);
  if (!row) return message("no such project", 404);
  const config = projectConfig(ctx.db, params.id);
  const resources = ctx.db
    .query<{ name: string; template: string }, []>("SELECT name, template FROM resource ORDER BY name")
    .all();
  return json({
    repoPath: row.repo_path,
    config,
    resources,
    baseBranch: row.base_branch,
    // What it resolves to right now, so an empty box is not a mystery.
    baseBranchNow: await baseBranch(ctx, params.id),
    // What the remote has, so the box is a choice rather than a memory test.
    branches: await listBranches(ctx, params.id),
  });
}) satisfies Handler<undefined, z.infer<typeof IdParams>>;
