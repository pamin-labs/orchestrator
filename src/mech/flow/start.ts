import { msg } from "@lingui/core/macro";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { DB } from "../../platform/persistence/database.ts";
import { roleFor, type Ctx } from "../../mech/ctx.ts";
import { agent, channel, escalation, grp as grpTable, project, resource } from "../../platform/persistence/schema.ts";

import { createCheckout, remoteFor } from "../git/checkout.ts";
import { canStart } from "./ownership.ts";
import { startNextSlice } from "./review.ts";
import { execIn, execLines, WORK } from "../sandbox/sandbox.ts";
import {
  detectDevcontainer,
  detectGates,
  detectInstall,
  detectShared,
  detectToolchain,
  READS,
  type Root,
  WORKFLOWS,
} from "../util/detect.ts";
import { shq } from "../../platform/process/shell.ts";
import { baseRefFor } from "../git/checkout.ts";
import { sandboxLog } from "../sandbox/sandboxlog.ts";
import { projectConfig } from "../util/rows.ts";
import { errText } from "../../platform/process/text.ts";
import { raise } from "./escalate.ts";
import { BOOTSTRAP_FAILED, BOOTSTRAP_OK, BOOTSTRAP_START } from "../../contracts/events.ts";
import { JsonObject, valueOr } from "../../contracts/json.ts";
import { outputLanguage } from "../../contracts/config.ts";

/**
 * The workflow files, into `files`, and their names back.
 *
 * Always, rather than only when the rule table finds nothing: one path through
 * detection is worth more than the round trips it saves on a recognised project,
 * and this runs once per project, at its first clone.
 */
/** Bounded, because a large repository's workflow directory is not — eight files
 *  is more CI than any project needs to say how it tests itself. Filtered by
 *  extension before anything is opened: a directory that is not there answers
 *  with an exit code, and one holding a README is not worth a round trip. */
async function readWorkflows(ctx: Ctx, grpId: number, files: Record<string, string>): Promise<string[]> {
  const listed = await execIn(ctx, { grp: grpId }, `ls -A ${shq(`${WORK}/${WORKFLOWS}`)}`);
  const names = (listed.code === 0 ? listed.out : "")
    .split("\n")
    .map((n) => n.trim())
    .filter((n) => /\.ya?ml$/.test(n))
    .sort()
    .slice(0, 8);
  for (const f of names) {
    const r = await execIn(ctx, { grp: grpId }, `cat ${shq(`${WORK}/${WORKFLOWS}/${f}`)}`);
    if (r.code === 0) files[`${WORKFLOWS}/${f}`] = r.out;
  }
  return names;
}

/**
 * What a fresh container needs before it can build anything, in order.
 *
 * Two steps, not one string with an `&&` in it: the toolchain is the repository's
 * own compiler, the install is its dependencies, and the second cannot run before
 * the first. Both are recorded, so a container rebuilt after its TTL replays them
 * in the same order rather than waking up with a checkout it cannot compile.
 */
async function setupSteps(db: DB, projectId: number): Promise<string[]> {
  const cfg = await projectConfig(db, projectId);
  return [cfg.toolchain, cfg.install].filter((v): v is string => Boolean(v?.trim()));
}

/** Every step, in order, stopping at the first that fails. */
async function runSetup(ctx: Ctx, grpId: number, steps: string[]): Promise<{ ok: boolean; tail: string; cmd: string }> {
  for (const cmd of steps) {
    const r = await runInstall(ctx, grpId, cmd);
    if (!r.ok) return { ...r, cmd };
  }
  return { ok: true, tail: "", cmd: "" };
}

/**
 * The only way a group starts working.
 *
 * Approval used to be the sole entry, so a group the boundary check refused was
 * simply dropped: the boss's click went nowhere, and nothing re-ran when the
 * thing blocking it went away. Splitting the decision ("may it start?") from the
 * act ("start it") is what lets the second one happen later, without the boss.
 */

/**
 * Wind a group up without merging it: it should not be done.
 *
 * The boss's `Don't proceed` and the CoS triaging a complaint as `reject` are one path, or
 * the two disagree about what "dropped" means. Rejecting used to only cancel the
 * queue, so the group kept its ACTIVE status and went on holding its paths against
 * every other group forever.
 */
/**
 * No retro turn: a group being dropped has nobody who wants its output, and the
 * reason is the sentence just written to its blackboard — spending an Opus turn to
 * restate that teaches the agents that retros are paperwork. The worktree and
 * every event stay; archiving must never mean deleting.
 *
 * `owns` is deliberately left alone. `canStart` counts only ACTIVE groups, so
 * DISSOLVED already releases the paths, and blanking the column would erase what
 * this group was allowed to touch from the record.
 */
export async function dropGroup(ctx: Ctx, grpId: number, why: string): Promise<void> {
  // All of it inside, including the queue and the timeline. They used to sit
  // outside because the scheduler and the bus each held the pool rather than
  // this handle, and a write of theirs would have waited on rows this
  // transaction had locked. Both read `writeHandle` now, so they join it — and a
  // dissolve that rolls back must not leave the group's queued work cancelled.
  await ctx.bus.transaction(async (tx) => {
    await ctx.sched.cancelPending(grpId, "dropped");
    await tx.update(grpTable).set({ status: "DISSOLVED", merge_seq: null }).where(eq(grpTable.id, grpId));
    await tx.update(agent).set({ state: "retired", session_id: null, token: null }).where(eq(agent.grp_id, grpId));
    await tx.update(channel).set({ status: "archived" }).where(eq(channel.grp_id, grpId));
    // Anything it had asked the boss dies with it, or the question outlives the
    // requirement and sits in `To do` forever.
    await tx
      .update(escalation)
      .set({ chain_state: "revoked", answered_at: Date.now() })
      .where(and(eq(escalation.grp_id, grpId), isNull(escalation.answer)));
    await ctx.bus.emit({
      grpId,
      author: "boss",
      kind: "state_change",
      // Two keys, not one key and a separator built here: the separator is part
      // of the sentence and belongs in the row that owns the sentence. Built
      // here it was a fullwidth `：`, which went into the English row too —
      // `dropped by the boss：ran out of budget`.
      say: why ? msg`dropped by the boss: ${{ why }}` : msg`dropped by the boss`,
    });
  });
}

/**
 * Install the project's dependencies, out loud.
 *
 * Streamed rather than awaited in silence: this is the first minute of a
 * requirement and the longest thing that happens before any work, so a panel
 * that shows nothing until it ends looks like a panel that is broken. Each line
 * goes out as a live frame — the same channel a turn's output uses, so the
 * timeline already knows how to render it — and only the tail is kept durably,
 * because an install log is worth watching and not worth storing.
 */
export async function runInstall(ctx: Ctx, grpId: number, cmd: string): Promise<{ ok: boolean; tail: string }> {
  const seen: string[] = [];
  sandboxLog(ctx.bus, grpId, "cmd", cmd);
  const stream = execLines(ctx, { grp: grpId }, cmd, {
    cwd: WORK,
    timeoutMs: ctx.config.installTimeoutMs,
    // Package managers print progress on stderr; without this an install is
    // silent for its whole run and then dumps everything at once.
    onStderr: (l) => sandboxLog(ctx.bus, grpId, "out", l),
  });
  let end = { code: -1, err: "" };
  for (;;) {
    const step = await stream.next();
    if (step.done) {
      end = step.value;
      break;
    }
    seen.push(step.value);
    if (seen.length > 400) seen.shift();
    sandboxLog(ctx.bus, grpId, "out", step.value);
  }
  sandboxLog(ctx.bus, grpId, "end", end.code === 0 ? "ok" : `exit ${end.code}`);
  const tail = [...seen.slice(-12), ...(end.err ? [end.err.slice(-400)] : [])].join("\n");
  await ctx.bus.emit({
    grpId,
    author: "orchestrator",
    kind: "state_change",
    // `meta.step` and not the body: the bootstrap pane has to find the start and
    // the end of one run, and the body is now rendered in whichever of ten
    // languages that browser reads. A protocol key is the same on both sides.
    meta: { step: end.code === 0 ? BOOTSTRAP_OK : BOOTSTRAP_FAILED },
    say:
      end.code === 0
        ? msg`installed: ${{ cmd }}`
        : msg`install failed (exit ${{ code: end.code }}): ${{ cmd }}\n${{ tail }}`,
  });
  return { ok: end.code === 0, tail };
}

/**
 * Put back what a fresh container does not have.
 *
 * A sandbox holds the work — the clone and everything installed into it — and is
 * replaceable: the TTL reaps an idle one, a credential change kills it, its server
 * restarts. `ensureSandbox` already builds another, and until now that was the
 * whole story, so the next turn woke in an empty container and reported that the
 * repository was broken.
 */
/**
 * Called from `ensureSandbox` rather than from each of its callers: a caller that
 * has to remember to restore is a caller that will not, and the ones that matter
 * are three levels down inside a turn.
 *
 * Inline rather than queued, because the turn that triggered the rebuild cannot do
 * anything useful until it finishes. `createCheckout` is idempotent, and the
 * install streams, which is what makes a long one watchable.
 */
export async function restoreWorkspace(ctx: Ctx, grpId: number): Promise<void> {
  const [grp] = await ctx.db
    .select({ project_id: grpTable.project_id, branch: grpTable.branch })
    .from(grpTable)
    .where(eq(grpTable.id, grpId));
  // No branch means the group has not started; `startGroup` owns that path and
  // is in the middle of it.
  if (!grp?.branch) return;
  const remote = await remoteFor(ctx.db, grp.project_id);
  if (!remote) return;

  await ctx.bus.emit({
    grpId,
    author: "orchestrator",
    kind: "state_change",
    meta: { step: BOOTSTRAP_START },
    say: msg`the sandbox is new — putting ${{ branch: grp.branch }} and the dependencies back`,
  });
  // The branch comes back off the remote, not out of a bundle the host kept:
  // `pushBranch` put it there at the last slice boundary, and `createCheckout`
  // checks it out when `ls-remote` finds it.
  await createCheckout(
    ctx,
    { grp: grpId },
    {
      remote,
      branch: grp.branch,
      base: await baseRefFor(ctx, grp.project_id),
      projectId: grp.project_id,
    },
  );

  const known = await setupSteps(ctx.db, grp.project_id);
  if (known.length) {
    const dep = await runSetup(ctx, grpId, known);
    if (dep.ok) return;
  }
  // No recorded command, or the recorded one stopped working: the same role that
  // works it out the first time works it out again, with the failure in hand.
  await ctx.sched.enqueue("agent_turn", {
    grp_id: grpId,
    priority: 9,
    payload: {
      role: roleFor(ctx, "bootstrap_env"),
      ...(known.length
        ? {
            rejection: `The sandbox was rebuilt and the setup on record does not work any more: ${known.join(" then ")}`,
          }
        : {}),
    },
  });
}

/**
 * What the repository turns out to be, read once, from the first clone.
 *
 * This used to run at registration against a checkout on the host. There is no such
 * checkout any more (ADR 007) and never will be, so it runs here: the first group's
 * container is the first moment the repository exists anywhere we can read it.
 */
/**
 * Once per project, marked by `config.detected` rather than by "are there gates
 * yet" — a project where detection genuinely finds nothing must not re-run forever
 * or grow duplicate resource rows.
 *
 * Everything it writes is a guess in a place the boss can correct: gate names, the
 * install command and the shared paths all land in project config, which is
 * `detect.ts`'s own stated rule.
 */
export async function detectProject(ctx: Ctx, grpId: number, projectId: number): Promise<void> {
  const cfg = await projectConfig(ctx.db, projectId);
  // Detection always writes both fields. A hand-edited/legacy `detected: true`
  // cannot suppress it when its companion gate list did not pass the boundary.
  if (cfg.detected === true && cfg.gates !== undefined) return;

  const ls = await execIn(ctx, { grp: grpId }, `ls -A ${shq(WORK)}`);
  const names = ls.out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const files: Record<string, string> = {};
  for (const f of READS) {
    // By first segment: `.devcontainer/devcontainer.json` is asked for when the
    // listing holds `.devcontainer`, since `ls -A` sees the directory, not what
    // is in it. A `cat` of a path that is not there costs one round trip and
    // answers non-zero, which is the same answer as not asking.
    if (!names.includes(f.split("/")[0]!)) continue;
    const r = await execIn(ctx, { grp: grpId }, `cat ${shq(`${WORK}/${f}`)}`);
    if (r.code === 0) files[f] = r.out;
  }
  const workflows = await readWorkflows(ctx, grpId, files);

  const root: Root = {
    names,
    read: (n) => files[n] ?? null,
    list: (dir) => (dir === WORKFLOWS ? workflows : []),
  };
  const gates = detectGates(root);

  /**
   * The upsert's conflict arm, named once and shared by both writers below.
   * `excluded` is the row the insert tried to add; it is a pseudo-table with no
   * Drizzle column of its own, so the four assignments stay `sql`.
   */
  const onNameConflict = {
    target: resource.name,
    set: {
      template: sql`excluded.template`,
      error_regex: sql`excluded.error_regex`,
      arg_schema_json: sql`excluded.arg_schema_json`,
      tags_json: sql`excluded.tags_json`,
    },
  };
  // `repo`: one gate at a time per repository, whatever the gate is.
  //
  // Concurrency is per resource, so build and typecheck ran side by side — and
  // both shell out to the project's own scripts, which install things. We can fix
  // our own templates and not the scripts a project ships, so the guarantee has
  // to be structural: gates of one repo do not overlap. Different repos still run
  // in parallel — the pool is keyed by project.
  // One statement per gate, as before, rather than a single multi-row insert:
  // `ON CONFLICT DO UPDATE` refuses to touch the same row twice within one
  // statement, so two gates sharing a name would become an error instead of an
  // upsert applied twice.
  for (const g of gates) {
    await ctx.db
      .insert(resource)
      .values({
        name: g.name,
        template: g.template,
        arg_schema_json: {},
        error_regex: g.errorRegex,
        concurrency: 1,
        tags_json: ["repo"],
      })
      .onConflictDoUpdate(onNameConflict);
  }

  // A project that ships the runner gets the browser resource. Without it every
  // acceptance line of the form "the menu opens" is unverifiable by anyone in the
  // fleet — measured, three groups stalled at once and the boss was asked to
  // click. Tagged `browser` so it draws from its own pool: each lease is a real
  // Chromium. A nested path, so it is asked for rather than read off the listing.
  const browse = await execIn(ctx, { grp: grpId }, `test -f ${shq(`${WORK}/scripts/browse.ts`)} && echo yes`);
  if (browse.out.trim() === "yes") {
    await ctx.db
      .insert(resource)
      .values({
        name: "browser",
        template: "bun run scripts/browse.ts --steps {steps}",
        // A step file, never a command: the Runner has real permissions, so the only
        // thing an agent may hand it is data (docs/project/plan.md, hard constraint 2).
        arg_schema_json: {
          steps: { type: "string", pattern: "^(?!.*\\.\\.)[A-Za-z0-9_./-]+\\.json$", maxLength: 200 },
        },
        error_regex: "FAIL:",
        concurrency: 1,
        tags_json: ["browser"],
      })
      .onConflictDoUpdate(onNameConflict);
  }

  const next = {
    ...cfg,
    detected: true,
    // Absent, not `[]`, when detection finds nothing. The two mean different
    // things and every reader downstream depends on the difference: an absent key
    // is "nobody has looked", and an empty array is the boss saying this project
    // has no deterministic floor. Writing `[]` here made detection speak for them.
    ...(cfg.gates?.length ? { gates: cfg.gates } : gates.length ? { gates: gates.map((g) => g.name) } : {}),
    toolchain: detectToolchain(root),
    install: detectInstall(root),
    shared: detectShared(root),
  };
  // `config_json` is `jsonb`, so the value goes in as it is rather than as text.
  // The undefined keys are dropped first: the reader's `catch(undefined)` arms
  // put them there for a field it could not parse, and `undefined` is not a JSON
  // value — validating with them still in wipes the column to `{}`.
  const stored = valueOr(Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)), JsonObject, {});
  await ctx.db.update(project).set({ config_json: stored }).where(eq(project.id, projectId));

  // The image a devcontainer names is said, not applied. Changing which image a
  // group runs in is the boss's call — it decides what every future turn has —
  // and `config_json.sandbox.image` is the field that makes it, in a pane that
  // already exists. What this owes them is knowing the project stated one.
  const declared = detectDevcontainer(root)?.image;
  if (declared && declared !== ctx.config.sandbox.image) {
    await ctx.bus.emit({
      grpId,
      author: "orchestrator",
      kind: "state_change",
      say: msg`this project's devcontainer develops in ${{ image: declared }} — Settings → Sandbox can point the group at it`,
      meta: { image: declared },
    });
  }

  if (!gates.length) {
    // Said plainly rather than letting the first slice fail with a puzzle. This
    // is the same warning registration used to give; only the moment moved.
    await ctx.bus.emit({
      grpId,
      author: "orchestrator",
      kind: "escalation",
      intent: "ask",
      severity: "advisory",
      say: msg`no gates detected in this repository. Every slice will fail review until this project has at least one: add a resource template and list its name in the project's gates.`,
    });
    return;
  }
  const found = gates.map((g) => g.name).join(", ");
  await ctx.bus.emit({
    grpId,
    author: "orchestrator",
    kind: "state_change",
    say: next.install
      ? msg`gates found: ${{ gates: found }} · install with ${{ install: next.install }}`
      : msg`gates found: ${{ gates: found }}`,
    meta: { gates: next.gates, detected: gates },
  });
}

/** Sandbox, checkout, RUNNING, first slice. Returns an error message, or null. */
export async function startGroup(ctx: Ctx, grpId: number): Promise<string | null> {
  const [grp] = await ctx.db
    .select({ name: grpTable.name, project_id: grpTable.project_id, branch: grpTable.branch })
    .from(grpTable)
    .where(eq(grpTable.id, grpId));
  if (grp && !grp.branch) {
    {
      try {
        const remote = await remoteFor(ctx.db, grp.project_id);
        if (!remote) return "project has no remote recorded; a group clones from it";
        const branch = `orch/${grp.name}`;
        const base = await baseRefFor(ctx, grp.project_id);
        await createCheckout(ctx, { grp: grpId }, { remote, branch, base, projectId: grp.project_id });
        await ctx.db.update(grpTable).set({ branch }).where(eq(grpTable.id, grpId));
        await ctx.bus.emit({
          grpId,
          author: "orchestrator",
          kind: "state_change",
          say: msg`checkout on ${{ branch }}`,
        });

        // The first moment the repository exists anywhere readable. It runs
        // before the install below because it is what works out the command.
        await detectProject(ctx, grpId, grp.project_id);

        // Dependencies, before the first engineer turn — still a role, not a
        // table of stacks. bun, pnpm, poetry, uv, pdm, mise, a Makefile target:
        // nobody enumerates those, and the repo says which one it is. What
        // changed is where it runs: the agent installs inside its own sandbox,
        // so there is nothing left for the orchestrator to do on its behalf.
        const known = await setupSteps(ctx.db, grp.project_id);
        if (known.length) {
          const dep = await runSetup(ctx, grpId, known);
          if (!dep.ok)
            await ctx.sched.enqueue("agent_turn", {
              grp_id: grpId,
              priority: 9,
              payload: {
                role: roleFor(ctx, "bootstrap_env"),
                rejection: `The setup command on record does not work any more: ${dep.cmd}\n${dep.tail}`,
              },
            });
        } else {
          await ctx.sched.enqueue("agent_turn", {
            grp_id: grpId,
            priority: 9,
            payload: { role: roleFor(ctx, "bootstrap_env") },
          });
        }
      } catch (e) {
        // Refuse to start rather than let the group run without its own checkout.
        return `could not prepare the group's checkout: ${errText(e)}`;
      }
    }
  }

  await ctx.db.update(grpTable).set({ status: "RUNNING", approved_at: null }).where(eq(grpTable.id, grpId));
  await ctx.bus.emit({ grpId, author: "boss", kind: "state_change", say: msg`DRAFT approved` });
  // Approving a plan that then sits still is the most confusing failure there is:
  // it looks like the system ignored you.
  await startNextSlice(ctx, grpId);
  await ctx.sched.tick();
  return null;
}

/**
 * Groups the boss already approved that a boundary was holding back.
 *
 * Called from `orch owns` (the Architect just re-cut, which may free a *different*
 * group than the one it touched) and from the watchdog, which is the backstop for
 * every other way a blocker leaves — merged, split, parked and then dissolved.
 * Returns the ids that started.
 */
export async function sweepApproved(ctx: Ctx): Promise<number[]> {
  const waiting = await ctx.db
    .select({ id: grpTable.id })
    .from(grpTable)
    .where(and(eq(grpTable.status, "DRAFT"), isNotNull(grpTable.approved_at)));
  const started: number[] = [];
  for (const g of waiting) {
    if (!(await canStart(ctx.db, g.id)).ok) continue;
    const err = await startGroup(ctx, g.id);
    if (err === null) {
      started.push(g.id);
      continue;
    }
    // Withdraw the intent and say so. Worktree failures are almost always
    // permanent — a full disk, a branch name already taken, no write permission —
    // and this runs on the watchdog tick, so leaving the intent set retried it
    // every thirty seconds forever, returning an error to nobody.
    await ctx.db.update(grpTable).set({ approved_at: null }).where(eq(grpTable.id, g.id));
    // No `key`: nothing matches this subject, so there is nothing for a matcher
    // to lose. `raise` still stores the descriptor beside the rendered text, so
    // the panel reads it in the browser's language and the prompt that splices
    // `question` reads it in the boss's.
    await raise(ctx.db, {
      grpId: g.id,
      lang: outputLanguage(ctx.config),
      brief: msg`the approval did not take`,
      kind: "env",
      chain: "boss",
      question: msg`The approval did not take: ${{ err }}. It has been withdrawn — approve again once that is fixed.`,
    });
    await ctx.bus.emit({
      grpId: g.id,
      author: "orchestrator",
      kind: "escalation",
      intent: "ask",
      severity: "blocker",
      say: msg`the approval did not take: ${{ err }}`,
    });
  }
  return started;
}
