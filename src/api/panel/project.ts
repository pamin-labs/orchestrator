import { msg, plural } from "@lingui/core/macro";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { type Ctx, roleFor } from "../../mech/ctx.ts";
import type { DB } from "../../platform/persistence/database.ts";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { SandboxOverrideSchema, StoredProjectConfigSchema } from "../../contracts/config.ts";
import { JsonObject, JsonValue, valueOr } from "../../contracts/json.ts";
import { readRoot, registerGates, runInstall } from "../../mech/flow/start.ts";
import { GateName, proveGate } from "../../mech/gate.ts";
import { declaredCommands, type DetectedGate, gateErrorRegex, isTemplate } from "../../mech/util/detect.ts";
import { baseBranch, listBranches, removeMirror } from "../../mech/git/checkout.ts";
import { pushBlocked } from "../../mech/git/prwatch.ts";
import { forgetHolds } from "../../mech/git/repository.ts";
import { allowedImage, killSandbox, resourceExec, WORK } from "../../mech/sandbox/sandbox.ts";
import { clearSandboxLog } from "../../mech/sandbox/sandboxlog.ts";
import { forgetProjectSkills } from "../../mech/skills.ts";
import { projectConfig } from "../../mech/util/rows.ts";
import { errText } from "../../platform/process/text.ts";
import { abortJob } from "../../platform/process/running-turns.ts";
import { ACTIVE_JOB_STATES } from "../../contracts/states.ts";
import { IdParams } from "../../contracts/fields.ts";
import type { AgentHandler, Handler } from "../../http/handler.ts";
import { bad, badText, json, message } from "../../http/respond.ts";

import { noGithubClient } from "./authflow.ts";
import {
  agent,
  channel,
  cursor,
  escalation,
  event,
  grp,
  job,
  lease,
  member,
  note,
  project,
  resource,
  slice,
  task,
} from "../../platform/persistence/schema.ts";

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

/**
 * A gate the bootstrap agent worked out, for a stack detection could not classify.
 *
 * Detection can *enumerate* what a repository declares in any language; only
 * classification runs out of table rows, and that is the half an agent in the
 * container can do. So the agent names the gate and points at the command — and
 * `acceptGates` below checks that answer rather than approving it.
 */
const ProposedGate = z.object({ name: GateName, cmd: z.string().min(1).max(2000) });

/** The install command this project needs, or `none` for "it needs nothing" —
 *  and the gates it runs, when nothing deterministic found them. */
export const SetupBody = z.object({
  cmd: InstallCommand.optional(),
  none: z.boolean().optional(),
  gates: z.array(ProposedGate).max(10).optional(),
});

/**
 * Accept a proposed gate on evidence, never on trust.
 *
 * Two ways in, both machine-checked, neither of them a person.
 */
/** **Declared.** The command is one the repository itself committed — a package
 *  script, a Makefile target, a task, a CI step. The boss approved it by merging
 *  it; there is nothing left to ask. */
/** **Proven.** It is not declared, but it ran here, through the same tokenised
 *  argv path a lease uses, and passed. `rebar3 eunit` in an Erlang repository
 *  with no CI is the case: undeclared, and a run is better evidence than a
 *  declaration would have been. */
/** Neither, and it is refused with the reason and with what the repository does
 *  declare — a refusal that teaches, in the tradition `planning.ts` set. An agent
 *  may point at a command; it may not invent one and have it registered unseen. */
async function acceptGates(
  ctx: Ctx,
  grpId: number,
  projectId: number,
  proposed: z.infer<typeof ProposedGate>[],
): Promise<{ ok: true; names: string[] } | { ok: false; why: string }> {
  const root = await readRoot(ctx, grpId);
  const declared = new Set(declaredCommands(root));
  const accepted: DetectedGate[] = [];

  for (const g of proposed) {
    const template = g.cmd.trim();
    if (!isTemplate(template))
      return {
        ok: false,
        why:
          `gate ${g.name}: "${template}" cannot be a gate. A gate is tokenised on whitespace and run without a shell, ` +
          "so a pipe, a redirect, a `&&` or a substitution would be passed to the first word as arguments. " +
          "Put the sequence in a script or a task the repository declares, and point the gate at that.",
      };
    const gate: DetectedGate = { name: g.name, template, errorRegex: gateErrorRegex(g.name) };
    if (declared.has(template)) {
      accepted.push(gate);
      continue;
    }
    const proof = await proveGate(gate, {
      exec: resourceExec(ctx, { grp: grpId }),
      cwd: WORK,
      dataDir: ctx.config.dataDir,
      timeoutMs: ctx.config.leaseTimeoutMs,
    });
    if (!proof.pass) {
      const options = [...declared].slice(0, 12);
      return {
        ok: false,
        why:
          `gate ${g.name}: "${template}" is not declared anywhere in this repository, and running it here exited ` +
          `${proof.exitCode}:\n${proof.errorLines.slice(-12).join("\n")}\n\n` +
          (options.length
            ? `Commands this repository declares:\n${options.map((c) => `  ${c}`).join("\n")}`
            : "This repository declares no entrypoint at all — no package script, task, Makefile target or CI step.") +
          "\nEither point the gate at one of those, or fix the command so it passes on this checkout.",
      };
    }
    accepted.push(gate);
  }

  await registerGates(ctx.db, accepted);
  const names = accepted.map((g) => g.name);
  const current = (await projectConfig(ctx.db, projectId)).gates ?? [];
  const merged = [...new Set([...current, ...names])];
  await ctx.db
    .update(project)
    // `jsonb_set` for the same reason `rememberInstall` uses it: the rest of
    // `config_json` belongs to other writers and a read-merge-write would carry
    // whatever this request happened to read back over them.
    // `jsonb_build_array` over one parameter per name, never `JSON.stringify`:
    // the driver encodes a parameter for a jsonb target itself, so pre-encoding
    // stores a jsonb *string* of the array where the array belongs, and a bound
    // JS array reaches Postgres comma-joined rather than as an array literal.
    // Both were measured here; a guard covers the first.
    .set({
      config_json: sql`jsonb_set(${project.config_json}, '{gates}', jsonb_build_array(${sql.join(
        merged.map((n) => sql`${n}::text`),
        sql`, `,
      )}))`,
    })
    .where(eq(project.id, projectId));
  return { ok: true, names };
}

/**
 * The answer, remembered on the project so the next group does not pay to read
 * the same repository — and so the boss can see and correct what its groups run.
 * `null` is "it needs nothing", which is an answer too: an absent key is only
 * ever "nobody has looked".
 */
async function rememberInstall(db: DB, projectId: number, cmd: string | null): Promise<void> {
  await db
    .update(project)
    // Raw: `jsonb_set` has no Drizzle operator, and the point of it is to leave
    // the rest of `config_json` alone rather than read, merge and write it back.
    // `to_jsonb` and not a JSON string bound as a parameter: the driver encodes
    // one for a jsonb target, so pre-encoding stored `"\"bun install\""`. The
    // coalesce is the other half — `to_jsonb(NULL)` is NULL and `jsonb_set` with
    // a NULL value wipes the column, so "needs nothing" would erase the config.
    .set({
      config_json: sql`jsonb_set(${project.config_json}, '{install}', coalesce(to_jsonb(${cmd}::text), 'null'::jsonb))`,
    })
    .where(eq(project.id, projectId));
}

export const postSetup = (async (ctx, _req, a, _p, b) => {
  if (a.role !== roleFor(ctx, "bootstrap_env")) return badText(`${a.role} does not set this project up`);
  const [owner] = a.grp_id
    ? await ctx.db.select({ project_id: grp.project_id }).from(grp).where(eq(grp.id, a.grp_id))
    : [];
  const projectId = owner?.project_id;
  if (!a.grp_id || !projectId) return badText("this agent has no group");

  const cmd = (b.cmd ?? "").trim();
  if (!b.none && !cmd && !b.gates?.length)
    return badText('setup needs --cmd "<command>", --none, or --gate <name>=<command>');

  if (b.none) {
    await rememberInstall(ctx.db, projectId, null);
    await ctx.bus.emit({
      grpId: a.grp_id,
      author: a.role,
      kind: "state_change",
      say: msg`this repository needs nothing installed`,
    });
  } else if (cmd) {
    // Same streamed install the first turn gets: the boss watches this one too,
    // and an agent's own attempt is the one most likely to need watching.
    const r = await runInstall(ctx, a.grp_id, cmd);
    if (!r.ok) return badText(`install failed:\n${r.tail}`);
    await rememberInstall(ctx.db, projectId, cmd);
  }

  // After the install, never before: a proposed gate that has to be proven by
  // running it is run on a checkout with its dependencies present, which is the
  // checkout every later gate will see.
  if (b.gates?.length) {
    const got = await acceptGates(ctx, a.grp_id, projectId, b.gates);
    if (!got.ok) return badText(got.why);
    await ctx.bus.emit({
      grpId: a.grp_id,
      author: a.role,
      kind: "state_change",
      // The sentence detection already emits for the same fact. One gate list,
      // one way of saying it, whoever worked it out.
      say: msg`gates found: ${{ gates: got.names.join(", ") }}`,
      meta: { gates: got.names },
    });
  }
  return message("ok");
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
  if (!want) return bad(msg`which repository? (owner/name)`);
  if (!ctx.gh) return noGithubClient();

  // Asked of GitHub rather than trusted from the browser: the default branch is
  // written into the row, and a wrong one is a group that branches off nothing.
  const r = await ctx.gh.request("GET", `/repos/${want}`, GithubRepo, undefined, req.signal);
  if (!r.ok) return badText(r.message);
  const repoPath = r.data.full_name;
  const remote = r.data.clone_url;
  const baseBranch = r.data.default_branch || null;
  const name = (b.name ?? "").trim() || repoPath.split("/")[1] || repoPath;

  const [dup] = await ctx.db.select({ name: project.name }).from(project).where(eq(project.repo_path, repoPath));
  if (dup) return bad(msg`${{ repoPath }} is already registered as "${{ name: dup.name }}"`);

  const gates = b.gates ?? [];
  const [row] = await ctx.db
    .insert(project)
    .values({
      name,
      repo_path: repoPath,
      remote,
      config_json: { gates },
      base_branch: baseBranch,
      created_at: Date.now(),
    })
    .returning({ id: project.id });

  // Said rather than silently guessed at: nothing was looked at, because there is
  // nothing to look at until a group clones (007 §2).
  await ctx.bus.emit({
    author: "orchestrator",
    kind: "state_change",
    // Two whole sentences rather than one with `"the default branch"` handed in
    // as a value: a parameter carrying a noun phrase is this line rendered half
    // here and half in the browser.
    say: baseBranch
      ? msg`${{ name }} (${{ repo: repoPath }} · ${{ branch: baseBranch }}) has been added. The gates and the install command are guessed once the first group has cloned; fill them in now instead under Settings → Gates.`
      : msg`${{ name }} (${{ repo: repoPath }}, on whatever the remote calls its default branch) has been added. The gates and the install command are guessed once the first group has cloned; fill them in now instead under Settings → Gates.`,
  });
  // Registered, and then told the truth about it. Read access is enough to clone
  // and work, so this does not refuse the repository — it refuses to let the boss
  // find out at the end, when a group has done everything and the push is the
  // only step left. No extra request: the answer above carries it.
  const blocked = pushBlocked(r.data.permissions, repoPath);
  if (blocked) {
    await ctx.bus.emit({
      author: "orchestrator",
      kind: "state_change",
      severity: "blocker",
      say: msg`${{ repo: repoPath }} has been added, but this login cannot push to it: ${{ why: blocked }}. Deal with it now, rather than after the first slice is finished.`,
    });
  }

  await ctx.sched.tick();
  return json({ id: row!.id, gates });
}) satisfies Handler<z.infer<typeof ProjectBody>>;

/**
 * The four sets everything below is scoped by, as subqueries rather than ids read
 * back into this process. Functions and not values: a builder is consumed by the
 * statement it goes into, and every one of these is used more than once.
 */
function scopes(db: DB, id: number) {
  const groups = () => db.select({ id: grp.id }).from(grp).where(eq(grp.project_id, id));
  const agents = () =>
    db
      .select({ id: agent.id })
      .from(agent)
      .where(or(eq(agent.project_id, id), inArray(agent.grp_id, groups())));
  const channels = () =>
    db
      .select({ id: channel.id })
      .from(channel)
      .where(or(eq(channel.project_id, id), inArray(channel.grp_id, groups())));
  const slices = () => db.select({ id: slice.id }).from(slice).where(inArray(slice.grp_id, groups()));
  return { groups, agents, channels, slices };
}

/**
 * Rows to clear for one project, in an order the database will accept.
 *
 * Nothing declares `ON DELETE CASCADE`, so the order is the whole correctness of
 * this: children before parents, and the two easy to miss are `escalation` → `note`
 * and `note` → `task`.
 *
 * A list rather than one long function, because the next table with a `grp_id` has
 * to appear here and a list makes that a one-line change.
 */
function projectRows(db: DB, id: number) {
  const { groups, agents, channels, slices } = scopes(db, id);
  return [
    db.delete(cursor).where(or(inArray(cursor.channel_id, channels()), inArray(cursor.agent_id, agents()))),
    db.delete(member).where(or(inArray(member.channel_id, channels()), inArray(member.agent_id, agents()))),
    db.delete(lease).where(or(inArray(lease.grp_id, groups()), inArray(lease.agent_id, agents()))),
    db
      .delete(job)
      .where(or(inArray(job.grp_id, groups()), inArray(job.agent_id, agents()), inArray(job.slice_id, slices()))),
    db.delete(escalation).where(or(inArray(escalation.grp_id, groups()), inArray(escalation.agent_id, agents()))),
    db.delete(event).where(or(inArray(event.grp_id, groups()), inArray(event.channel_id, channels()))),
    db
      .delete(note)
      .where(or(eq(note.project_id, id), inArray(note.grp_id, groups()), inArray(note.slice_id, slices()))),
    db.delete(task).where(or(inArray(task.grp_id, groups()), inArray(task.slice_id, slices()))),
    db.delete(slice).where(inArray(slice.grp_id, groups())),
    db.delete(channel).where(inArray(channel.id, channels())),
    db.delete(agent).where(inArray(agent.id, agents())),
    // `grp.blocked_on` points at another grp. Clearing it first is what lets the
    // whole set go in one statement.
    db.update(grp).set({ blocked_on: null }).where(inArray(grp.blocked_on, groups())),
    db.delete(grp).where(eq(grp.project_id, id)),
    db.delete(project).where(eq(project.id, id)),
  ];
}

/**
 * Remove a project: everything of ours, nothing of GitHub's.
 *
 * **The one place in this codebase where deleting is right**, against the rule
 * everywhere else. `dropGroup` is correct that archiving must never mean
 * deleting — what a group did is the record. A project being removed is the boss
 * saying they do not want the record either. `Don't proceed` archives; this erases, and the
 * panel must never let one be mistaken for the other.
 */
/**
 * **The remote is never touched.** No branch deleted, no PR closed, no GitHub
 * call that writes anything — a boss who found their branches gone afterwards
 * would have been robbed by a cleanup button.
 *
 * Order matters twice: containers before rows, because a killed row takes the
 * sandbox id with it and an unnamed container lives out its TTL; and jobs before
 * containers, so nothing starts a turn against a project that is going away.
 */
export const deleteProject = (async (ctx, _req, params) => {
  const id = params.id;
  const [p] = await ctx.db
    .select({ name: project.name, repo_path: project.repo_path, remote: project.remote })
    .from(project)
    .where(eq(project.id, id));
  if (!p) return message("no such project", 404);
  const grps = await ctx.db.select({ id: grp.id }).from(grp).where(eq(grp.project_id, id));

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
  // Scoped by the project's own groups and agents, not by `scopes()`: a standing
  // agent's turn belongs to this project through `agent.project_id` alone, and the
  // wider set would also sweep in an agent that only shares a group with one.
  const running = () =>
    and(
      inArray(job.state, [...ACTIVE_JOB_STATES]),
      or(
        inArray(job.grp_id, ctx.db.select({ id: grp.id }).from(grp).where(eq(grp.project_id, id))),
        inArray(job.agent_id, ctx.db.select({ id: agent.id }).from(agent).where(eq(agent.project_id, id))),
      ),
    );
  const doomed = await ctx.db.select({ id: job.id }).from(job).where(running());
  let stopped = 0;
  for (const j of doomed) if (abortJob(j.id)) stopped++;
  await ctx.db.update(job).set({ state: "cancelled", ended_at: Date.now(), error: "project removed" }).where(running());
  if (stopped) {
    await ctx.bus.emit({
      author: "orchestrator",
      kind: "state_change",
      say: msg`${{ name: p.name }}: ${plural({ n: stopped }, { one: "# running turn was", other: "# running turns were" })} killed before the data goes`,
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
  const { groups } = scopes(ctx.db, id);
  const wrote = await unionAll(
    ctx.db
      .select({ body: note.body })
      .from(note)
      .where(or(eq(note.project_id, id), inArray(note.grp_id, groups()))),
    ctx.db.select({ body: event.body }).from(event).where(inArray(event.grp_id, groups())),
  );
  const said = wrote.map((r) => r.body).join("\n");
  for (const m of said.matchAll(/^- (?:\[[^\]]+\] )?(\S+?)(?: \(image\))?$/gm)) {
    const path = resolve(m[1]!);
    // Only inside the attachments directory: these strings come out of prose an
    // agent wrote, and `rm -rf` on whatever one of them happens to say is not a
    // cleanup button.
    if (path.startsWith(`${root}/`)) await rm(path, { recursive: true, force: true }).catch(() => {});
  }

  // 4. Rows, in one transaction: a half-removed project is worse than either end.
  await ctx.bus.transaction(async (tx) => {
    for (const statement of projectRows(tx, id)) await statement;
  });

  // 5. State that outlives the row. `holds` is keyed by `owner/repo` and would
  // hold a repository nobody has any more; clearing all of them costs at most
  // one extra failed turn on another held project, which is what re-arms it.
  // The skills cache is keyed by project id, and ids are reused by SQLite —
  // leaving it would hand the next project this one's skill list.
  forgetHolds("github");
  await forgetProjectSkills(ctx.db, id);

  await ctx.bus.emit({
    author: "orchestrator",
    kind: "state_change",
    say: msg`Removed the project ${{ name: p.name }} (${{ repo: p.repo_path }}): ${plural({ n: grps.length }, { one: "# ticket", other: "# tickets" })}, the containers and the records are gone. Nothing on GitHub was touched.`,
  });
  await ctx.sched.tick();
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

/**
 * A refusal rather than a reason, because two of the three are sentences the boss
 * reads in the browser and one is zod's English.
 *
 * `Result<T>.error` is a string shown to an *agent* verbatim, which is the other
 * kind — this route answers a panel, so `bad()` carries the descriptor beside the
 * English and the browser picks the language. Returning the built refusal keeps
 * that choice at the site that knows which of the two it is.
 */
type Merged = { ok: true; config: StoredProjectConfig } | { ok: false; refusal: ReturnType<typeof badText> };

function mergeProjectConfig(raw: unknown, patch: StoredConfigPatch): Merged {
  const current = valueOr(raw, JsonObject.nullable(), null);
  if (!current)
    return {
      ok: false,
      refusal: bad(
        msg`A project's config has to be a JSON object. One partial edit will not be allowed to replace the whole of it.`,
      ),
    };

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete current[key];
    else current[key] = JsonValue.parse(value);
  }
  const checked = StoredProjectConfigSchema.safeParse(current);
  // zod wrote this one, in English, and `bad()` cannot translate what it did not
  // write — the same division `respond.ts` states for its two doors.
  if (!checked.success) return { ok: false, refusal: badText(z.prettifyError(checked.error)) };
  const image = checked.data.sandbox?.image;
  if (image && !allowedImage(image)) {
    return {
      ok: false,
      refusal: bad(
        msg`An image has to be one we publish (ghcr.io/pamin-labs/…) or one you built locally (orch/agent:1, say). The agent runs inside this image with your code in front of it, so pointing it somewhere else hands over the whole boundary — and nothing on the panel would show it.`,
      ),
    };
  }
  return { ok: true, config: checked.data };
}

export const patchProjectConfig = (async (ctx, _req, params, data) => {
  const id = params.id;
  const [row] = await ctx.db.select({ config_json: project.config_json }).from(project).where(eq(project.id, id));
  if (!row) return message("no such project", 404);
  const { baseBranch: nextBase, ...patch } = data;
  // `baseBranch` is a column, not a config_json key: it is read on every clone,
  // rebase and diff. Empty means "ask the remote".
  const changesConfig = Object.keys(patch).length > 0;
  const parsed = valueOr(row.config_json, JsonObject.nullable(), null);
  let config: StoredProjectConfig = parsed ?? {};
  if (changesConfig) {
    // Validate the whole merge so an unrelated patch cannot bless a malformed
    // field written by an older binary or a database-side repair.
    const merged = mergeProjectConfig(row.config_json, patch);
    if (!merged.ok) return merged.refusal;
    config = merged.config;
  }

  // Validate first, then write both homes as one act. A rejected image used to
  // return 422 after `base_branch` had already changed.
  await ctx.bus.transaction(async (tx) => {
    if ("baseBranch" in data) {
      const want = (nextBase ?? "").trim();
      // Pinned when the boss names one, cleared when the box is emptied. Without
      // that flag `baseBranch` cannot tell a choice from a cached lookup, and it
      // overwrote both — so picking a branch here lasted until the next tick.
      // Emptying the box is the way back to following the remote's default.
      await tx
        .update(project)
        .set({ base_branch: want || null, base_branch_pinned: !!want })
        .where(eq(project.id, id));
    }
    if (changesConfig) {
      await tx.update(project).set({ config_json: config }).where(eq(project.id, id));
    }
  });
  return json(config);
}) satisfies Handler<z.infer<typeof ProjectConfigBody>, z.infer<typeof IdParams>>;

export const getProjectConfig = (async (ctx, _req, params) => {
  const [row] = await ctx.db
    .select({
      repo_path: project.repo_path,
      base_branch: project.base_branch,
      base_branch_pinned: project.base_branch_pinned,
    })
    .from(project)
    .where(eq(project.id, params.id));
  if (!row) return message("no such project", 404);
  const config = await projectConfig(ctx.db, params.id);
  const resources = await ctx.db
    .select({ name: resource.name, template: resource.template })
    .from(resource)
    .orderBy(resource.name);
  return json({
    repoPath: row.repo_path,
    config,
    resources,
    baseBranch: row.base_branch,
    basePinned: row.base_branch_pinned,
    // What it resolves to right now, so an empty box is not a mystery.
    baseBranchNow: await baseBranch(ctx, params.id),
    // What the remote has, so the box is a choice rather than a memory test.
    branches: await listBranches(ctx, params.id),
  });
}) satisfies Handler<undefined, z.infer<typeof IdParams>>;
