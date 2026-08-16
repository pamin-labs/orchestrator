import { dirname, join, resolve } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { rm } from "node:fs/promises";
import { dropSlices } from "./db.ts";
import { allowedImage, killSandbox, relinkSkills, remoteInClear, restartServer, runningServer, serverAddr, skillMounts, specFor } from "./mech/sandbox/sandbox.ts";
import { resetServerRestarts } from "./mech/ops/watchdog.ts";
import { clearSandboxLog, sandboxLines } from "./mech/sandbox/sandboxlog.ts";
import { preflight } from "./mech/ops/preflight.ts";
import { defaultImage, imageChoices, setDefaultImage, type ImageChoices } from "./mech/sandbox/images.ts";
import { driftingPaths, ensureServer, inspectServer, ourArgv, serverLogPath, serverLogTail, setServerAddr } from "./mech/sandbox/server.ts";
import { baseBranch, listBranches, removeMirror } from "./mech/git/checkout.ts";
import { interrupt, park, pause, resume, unpark } from "./mech/flow/intercept.ts";
import { canStart, parseOwns } from "./mech/flow/ownership.ts";
import { dropGroup, runInstall, startGroup, sweepApproved } from "./mech/flow/start.ts";
import { joinQueue, landed } from "./mech/flow/mergequeue.ts";
import { checkPrMessage, openPr, prBody, prTitle, pushBlocked } from "./mech/git/prwatch.ts";
import { forgetHolds } from "./mech/git/github.ts";
import { query as ctxQuery, DEFAULT_BUDGET } from "./mech/knowledge/ctx.ts";
import { loadTree, NOTE_PREFIX, render, search } from "./mech/knowledge/pageindex.ts";
import { forgetProjectSkills, listSkills, projectSkills, projectSkillsPending, restageSkills, setSkillOff, skillsOff } from "./mech/util/skills.ts";
import { abortJob } from "./runtime/running.ts";
import { say } from "./lang.ts";
import { Hono } from "hono";
import { agentOf, bad, body, firstIdea, json, mayAct, mintToken, resolveGroup, text, type AgentHandler, type Handler } from "./api/shared.ts";
import { getTasks, postTaskClaim, postTaskDone } from "./api/tasks.ts";
import { getCost, getState, snapshot } from "./api/snapshot.ts";
import { bossFact, expandHome, getAttachment, imagePaths, postAttach, postAttachLocal, withAttachments, type Attachment } from "./api/attach.ts";
import { postBlocked, postDraft, postDrop, postOwns, postSplit } from "./api/planning.ts";
import { slug } from "./api/slug.ts";
import { evictOldestLessons, LESSON_CAP, postJournal, postStatus } from "./api/report.ts";
import { postMail, postSay } from "./api/messaging.ts";
import { getLeaseLog, postLease } from "./api/lease.ts";
import { getEvidence, getGateLog, postAudit, postReview, postSliceDecision } from "./api/review.ts";

// The lesson cap is asserted in a test; eviction is called from the note route.
export { evictOldestLessons, LESSON_CAP };
import { ASK_KINDS, askKind, brief, getAnswerDraft, postAnswer, postAnswer2, postAskBoss, postDelegate, postEscalationRequirement, postRevoke, postTriage } from "./api/escalation.ts";

// The queue groups by kind and shows the brief; both are read outside the routes.
export { ASK_KINDS, askKind, brief };

// `bossFact` is called from the answer chain, `imagePaths` and `withAttachments`
// from the executor. Re-exported so those two keep one import each.
export { bossFact, expandHome, imagePaths, withAttachments, type Attachment };

// The panel payload. Re-exported: several tests build a fleet and assert on it.
export { snapshot };
import { getAuth, getGithubLogin, getGithubRepos, postAuth, postClaudeCancel, postClaudeCode, postClaudeLogin, postCodexDevice, postCodexDeviceCancel, postGithubLogin, postTrailers } from "./api/authflow.ts";

// Re-exported: `mintToken` and `agentOf` are wired from outside the routes, and
// the tests reach for them here.
export { agentOf, mayAct, mintToken, resolveGroup };
import { validateDraftCard } from "./mech/flow/validate.ts";
import type { Caller, Ctx } from "./ctx.ts";

// Both live in `ctx.ts` now — eighteen files under `mech/` want the type and
// nothing else here. Re-exported so no importer had to change.
export type { Caller, Ctx };

/**
 * One API, two clients: the web UI (the boss's main surface) and `orch` (what
 * agents call over Bash). Anything the web can do has an `orch` verb and vice
 * versa — there is deliberately no second implementation anywhere.
 */

// ---------------------------------------------------------------- agent verbs









/**
 * The line the queue shows.
 *
 * Asked for with `--brief`, because the agent knows what its question is about
 * and the queue cannot work it out from prose written for another agent. Derived
 * when it is missing rather than rejected: a question that cannot be filed is an
 * agent stuck on a formatting rule, and the fallback is right often enough — the
 * first sentence of a question usually names the problem.
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
const postSetup: AgentHandler = async (ctx, req, a) => {
  const b = await body<{ cmd?: string; none?: boolean }>(req);
  if (a.role !== "bootstrap") return bad(`${a.role} does not set this project up`);
  if (!a.grp_id) return bad("this agent has no group");
  const grp = ctx.db
    .query<{ project_id: number }, [number]>("SELECT project_id FROM grp WHERE id = ?")
    .get(a.grp_id);
  if (!grp) return bad("this agent has no group");

  if (b.none) {
    ctx.db.run(
      "UPDATE project SET config_json = json_set(config_json, '$.install', json('null')) WHERE id = ?",
      [grp.project_id],
    );
    ctx.bus.emit({ grpId: a.grp_id, author: a.role, kind: "state_change", body: "这个仓库不需要装什么" });
    return text("ok");
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
  return r.ok ? text("ok") : bad(`install failed:\n${r.tail}`);
};








/** The Architect cuts a group's boundary before work is planned inside it. */





/**
 * The Scribe's message, and the thing that publishes the branch.
 *
 * The validator is the convention — the role's prompt states these four
 * refusals by name, and `checkPrMessage` is what enforces them. A Scribe that
 * gets it wrong is told which rule and can send it again within the same turn:
 * nothing is published until one lands, so there is no half state to undo.
 */
const postPr: AgentHandler = async (ctx, req, a) => {
  const b = await body<{ group_id: number | string; title: string; body?: string }>(req);
  if (a.role !== "scribe") return bad(`${a.role} does not write pull request messages`);
  const gid = resolveGroup(ctx, b.group_id);
  if (!gid) return bad("which group? pass its id or name");
  if (!mayAct(ctx, a, gid)) return text("not your project", 403);

  const title = (b.title ?? "").trim();
  const summary = (b.body ?? "").trim();
  const wrong = checkPrMessage(title, summary);
  if (wrong) return bad(wrong);

  const g = ctx.db
    .query<{ status: string; pr_number: number | null }, [number]>("SELECT status, pr_number FROM grp WHERE id = ?")
    .get(gid);
  if (!g) return bad("no such group");
  ctx.db.run("UPDATE grp SET pr_title = ?, pr_summary = ? WHERE id = ?", [title, summary, gid]);
  ctx.bus.emit({
    grpId: gid,
    author: "scribe",
    kind: "note",
    intent: "note",
    body: title,
  });
  // Already open: the message is stored and `openPr` PATCHes the existing one
  // rather than opening a second. Publishing is still the same call either way.
  ctx.publishBranch?.(gid);
  return text("ok");
};


const postCtxQuery: AgentHandler = async (ctx, req, a) => {
  const b = await body<{ question: string; limit?: number }>(req);
  const projectId =
    ctx.db
      .query<{ project_id: number | null }, [number]>("SELECT project_id FROM agent WHERE id = ?")
      .get(a.id)?.project_id ?? null;
  // PageIndex: a model walks the summary tree and can land on a file whose name
  // shares no word with the question. It costs one cheap call, against grep rounds
  // that each re-read the agent's whole transcript. No tree yet, or a navigator
  // that fails, falls through to the lexical map inside ctxQuery.
  let where = "";
  const tree = loadTree(ctx.db, projectId);
  if (tree && ctx.askIn && projectId) {
    try {
      // In the caller's own sandbox, not the project's.
      //
      // The walk reads nothing from a checkout: the menu is built from summaries
      // already in the database and the model answers with ids. So the container
      // it runs in cannot change the answer — and routing every group's query into
      // the one project sandbox would put ten agents' first step through a single
      // container with a single CPU quota, on the step `assemble.ts` tells every
      // role to take FIRST. The index *build* stays project-scoped; it is shared
      // work and there is one of it.
      const scope = a.grp_id ? { grp: a.grp_id } : { project: projectId };
      const hits = await search(tree, b.question, ctx.askIn(scope));
      if (hits.length) {
        where = render(tree, hits);
        // A note the walk landed on is the answer, not a pointer to it: journals and
        // retros are already short, and making the agent go and fetch one costs
        // another round, which is the thing this whole path exists to avoid.
        const noteIds = hits.filter((h) => h.startsWith(NOTE_PREFIX)).map((h) => Number(h.split("/").pop()));
        for (const id of noteIds) {
          const n = ctx.db
            .query<{ kind: string; body: string }, [number]>("SELECT kind, body FROM note WHERE id = ?")
            .get(id);
          if (n) where += `\n\n### ${n.kind} #${id}\n${n.body.slice(0, 1200)}`;
        }
      }
    } catch {}
  }
  return text(
    ctxQuery({
      db: ctx.db,
      grpId: a.grp_id,
      projectId,
      question: b.question,
      where,
      // From config, not the module default: `ctxBudgetChars` was a setting that
      // read back as itself and changed nothing, because nobody ever passed it here.
      budget: b.limit ?? ctx.config.ctxBudgetChars ?? CTX_BUDGET_CHARS,
    }),
  );
};

export const CTX_BUDGET_CHARS = DEFAULT_BUDGET;






// ------------------------------------------------------------------ boss verbs
















const postIdea: Handler = async (ctx, req) => {
  const b = await body<{
    project_id: number;
    text: string;
    name?: string;
    attachments?: { name: string; path: string; type: string }[];
  }>(req);
  if (!b.text?.trim()) return bad("empty idea");
  const name = (b.name ?? slug(b.text)).slice(0, 40);
  const grp = ctx.db
    .query<{ id: number }, [number, string]>(
      "INSERT INTO grp (project_id, name, status, created_at) VALUES (?, ?, 'PLANNING', unixepoch() * 1000) RETURNING id",
    )
    .get(b.project_id, name)!;
  // `channel.grp_id` is the only link between the two; a reverse pointer on grp
  // would be a second source of truth for the same edge.
  const ch = ctx.db
    .query<{ id: number }, [number, number]>(
      "INSERT INTO channel (project_id, grp_id, kind, created_at) VALUES (?, ?, 'group', unixepoch() * 1000) RETURNING id",
    )
    .get(b.project_id, grp.id)!;

  // Attachments go on the blackboard as paths next to the words they came with, so
  // whoever plans this reads them in the same breath as the idea.
  const noteBody = withAttachments(b.text, b.attachments);
  ctx.db.run(
    "INSERT INTO note (project_id, grp_id, kind, lang, body, at) VALUES (?, ?, 'fact', ?, ?, unixepoch() * 1000)",
    [b.project_id, grp.id, ctx.config.language, noteBody],
  );
  ctx.bus.emit({ channelId: ch.id, grpId: grp.id, author: "boss", kind: "boss_say", intent: "request", body: b.text });
  // With another group already holding paths, the boundary has to be cut before
  // anyone plans work inside it — otherwise the plan is written against paths the
  // group turns out not to own.
  const others = ctx.db
    .query<{ id: number; name: string; owns_json: string }, [number, number]>(
      `SELECT id, name, owns_json FROM grp WHERE project_id = ? AND id != ?
         AND status IN ('PLANNING','RUNNING','PAUSING','PAUSED','PARKED','PR_OPEN')`,
    )
    .all(b.project_id, grp.id);
  if (others.length > 0) {
    // Every undeclared active group, not just the new one. The first group in a
    // project needs no boundary — but the moment a second appears, an undeclared
    // group beside a declared one is the exact situation the rule exists to
    // prevent, reached from the other direction.
    const needBoundary = [
      { id: grp.id, name, idea: b.text },
      ...others
        .filter((o) => parseOwns(o.owns_json).length === 0)
        .map((o) => ({ id: o.id, name: o.name, idea: firstIdea(ctx, o.id) })),
    ];
    ctx.sched.enqueue("agent_turn", {
      grp_id: grp.id,
      priority: 6,
      payload: { role: "architect", boundary: needBoundary, idea: b.text },
    });
  }

  ctx.sched.enqueue("agent_turn", { grp_id: grp.id, payload: { role: "dispatcher", idea: b.text } });
  ctx.sched.tick();
  return json({ grp_id: grp.id, channel_id: ch.id, boundaryNeeded: others.length > 0 });
};

const postDraftDecision: Handler = async (ctx, req, params) => {
  const b = await body<{ card?: string; reason?: string; attachments?: Attachment[] }>(req);
  const grpId = Number(params.id);
  const approve = params.decision === "approve";

  if (!approve) {
    bossFact(ctx, grpId, withAttachments(`boss sent the DRAFT back: ${b.reason ?? ""}`, b.attachments));
    // Back to PLANNING, which is what the group actually is now. Left in DRAFT it
    // still counted as a decision waiting on the boss, still showed the rejected
    // card, and 批准开工 still worked on it — one stray click approves the very
    // plan that was just sent back.
    //
    // Clearing approved_at as well: sending a plan back withdraws the approval, or
    // the next card to reach DRAFT would start itself on the strength of a yes the
    // boss said to a plan that no longer exists.
    ctx.db.run(
      "UPDATE grp SET status = 'PLANNING', approved_at = NULL WHERE id = ? AND status = 'DRAFT'",
      [grpId],
    );
    const why = withAttachments(b.reason ?? "respec", b.attachments);
    ctx.bus.emit({ grpId, author: "boss", kind: "boss_say", intent: "request", body: why });
    ctx.sched.enqueue("agent_turn", { grp_id: grpId, payload: { role: "dispatcher", respec: why } });
    ctx.sched.tick();
    return text("sent back");
  }

  // The boss usually approves what the Dispatcher filed; an edited card in the
  // request body is the "改完批准" path.
  const filed = ctx.db
    .query<{ body: string }, [number]>(
      `SELECT body FROM note WHERE grp_id = ? AND json_extract(frontmatter_json, '$.draft_card') = 1
       ORDER BY at DESC LIMIT 1`,
    )
    .get(grpId)?.body;
  const card = b.card ?? filed;

  if (card) {
    const v = validateDraftCard(card);
    if (!v.ok) return bad(v.error);
    // Four tables point at a slice, not one. Clearing only `task` left `job`,
    // `note` and `slice.depends_on` holding references, so re-approving a group
    // that had already run died on `FOREIGN KEY constraint failed` — see
    // `SLICE_REFS`.
    dropSlices(ctx.db, grpId);
    // A cap, per difficulty, written at birth. Until this, `budget_tokens` was
    // never INSERTed anywhere, so it was NULL on every row and both admission
    // checks in scheduler.ts had never stopped a single turn. It matters more now
    // that reviewers run on a CLI with no tool whitelist: the whitelist used to be
    // what bounded how much of the repo a review could read, and this is what
    // replaces it. The boss can raise any of them from the requirement page.
    const ins = ctx.db.prepare(
      `INSERT INTO slice (grp_id, seq, title, accept_spec, difficulty, budget_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, unixepoch() * 1000) RETURNING id`,
    );
    // One task per slice, up front. Without something to claim the writer
    // improvises an id, `task done` never lands, and the whole review pipeline
    // silently never fires — which is exactly what the live run showed.
    const insTask = ctx.db.prepare(
      "INSERT INTO task (grp_id, slice_id, title, created_at) VALUES (?, ?, ?, unixepoch() * 1000)",
    );
    v.slices.forEach((sl, i) => {
      const row = ins.get(
        grpId,
        i + 1,
        sl.title,
        sl.accept,
        sl.difficulty,
        ctx.config.sliceBudgetTokens?.[sl.difficulty] ?? ctx.config.sliceBudgetTokens?.normal ?? null,
      ) as { id: number };
      insTask.run(grpId, row.id, sl.title);
    });
  }
  // Boundaries before work. Two groups discovering at merge time that they were
  // both editing one file have already paid for the work twice.
  //
  // The slices above are written either way: without them there is nothing for the
  // automatic start to run once the boundary clears, and an edited card would be
  // lost between the two clicks.
  const start = canStart(ctx.db, grpId);
  if (!start.ok) {
    // A refusal used to end here, and the click was gone: the group sat in DRAFT
    // with nothing recording that the boss had said yes, and nobody re-ran it when
    // the group holding the paths merged. One click has to be final.
    ctx.db.run("UPDATE grp SET approved_at = unixepoch() * 1000 WHERE id = ?", [grpId]);
    // Put the Architect back on it — the boundary is its job, and it was observed
    // cutting one group's paths and forgetting the other's.
    const undeclared = ctx.db
      .query<{ id: number; name: string }, [number]>(
        `SELECT id, name FROM grp
         WHERE project_id = (SELECT project_id FROM grp WHERE id = ?)
           AND status IN ('PLANNING','DRAFT','RUNNING','PAUSING','PAUSED','PARKED','PR_OPEN')
           AND (owns_json IS NULL OR owns_json = '[]')`,
      )
      .all(grpId);
    if (undeclared.length) {
      ctx.sched.enqueue("agent_turn", {
        grp_id: grpId,
        priority: 7,
        payload: {
          role: "architect",
          boundary: undeclared.map((g) => ({ ...g, idea: firstIdea(ctx, g.id) })),
        },
      });
      ctx.sched.tick();
    }
    ctx.bus.emit({
      grpId,
      author: "orchestrator",
      kind: "state_change",
      body: say(ctx.config?.language, "group.approve_held", { why: start.reason ?? "" }),
    });
    // 200, not 422: the boss did decide, and a red error toast says the opposite.
    return text(say(ctx.config?.language, "group.approve_held", { why: start.reason ?? "" }));
  }

  const err = await startGroup(ctx, grpId);
  return err ? bad(err) : text("ok");
};

/**
 * Wind a merged group up. One path, whether the boss said so or `gh` did.
 *
 * Dissolving is the most irreversible thing on the panel — the group leaves every
 * view — so it must never rest on a guess about whether the branch is in main.
 */
export function landGroup(ctx: Ctx, grpId: number, by: string): number[] {
  const stale = landed(ctx.db, grpId);
  ctx.bus.emit({ grpId, author: by, kind: "state_change", body: say(ctx.config?.language, "group.merged") });

  // Turn this group's retro into lessons while the branch is fresh. This is
  // the only mechanism by which the twentieth group is smarter than the
  // first, so it runs on the way out, not "later".
  ctx.sched.enqueue("agent_turn", {
    grp_id: grpId,
    payload: {
      role: "librarian",
      rejection:
        "This group just merged. Read its retro and journals, then update the project's " +
        "lesson list (`orch journal add --kind lesson`) with anything that would have changed " +
        "a decision. Refresh the onboarding pack if this changed how the project is built or tested.",
    },
  });
  for (const id of stale) {
    ctx.sched.enqueue("agent_turn", {
      grp_id: id,
      payload: {
        role: "engineer",
        rejection: "main moved: `git fetch origin main` and `git rebase origin/main` before doing anything else.",
        rotate: true,
      },
    });
  }
  ctx.sched.tick();
  return stale;
}

const postGroupControl: Handler = async (ctx, req, params) => {
  const grpId = Number(params.id);
  const action = params.action;
  switch (action) {
    case "budget": {
      // Budget exhaustion suspends the group, and until this existed there was no
      // route out of it: 继续 un-paused a group the scheduler refused to admit,
      // so the next tick suspended it again. A limit needs a way to be raised.
      const b = await body<{ tokens?: number | null }>(req);
      const t = b.tokens == null ? null : Math.round(Number(b.tokens));
      if (t !== null && !(t > 0)) return bad("tokens must be a positive number, or null to lift the cap");
      const spent = ctx.db
        .query<{ spent_tokens: number; status: string }, [number]>("SELECT spent_tokens, status FROM grp WHERE id = ?")
        .get(grpId);
      if (!spent) return text("no such group", 404);
      if (t !== null && t <= spent.spent_tokens) {
        return bad(`already spent ${spent.spent_tokens} tokens — a cap at ${t} would stop it again immediately`);
      }
      ctx.db.run("UPDATE grp SET budget_tokens = ? WHERE id = ?", [t, grpId]);
      ctx.bus.emit({
        grpId,
        author: "boss",
        kind: "state_change",
        body: t === null ? "budget cap lifted" : `budget raised to ${t} tokens`,
      });
      // Raising the cap is the answer to the question the watchdog asked, so it
      // also closes it: a stale "out of budget" row in 等你 is worse than none.
      ctx.db.run(
        `UPDATE escalation SET chain_state = 'answered', answered_by = 'boss', answer = ?, answered_at = unixepoch() * 1000
         WHERE grp_id = ? AND chain_state = 'boss' AND answer IS NULL AND question LIKE 'budget:%'`,
        [t === null ? "cap lifted" : `raised to ${t}`, grpId],
      );
      if (spent.status === "PAUSED") resume(ctx, grpId);
      ctx.sched.tick();
      return json({ budget: t });
    }
    case "pause": {
      // Reports how many turns it is waiting on: PAUSING is honest, PAUSED
      // would not be while something is still in flight.
      const waiting = pause(ctx, grpId);
      return json({ status: waiting ? "PAUSING" : "PAUSED", waiting });
    }
    case "resume": {
      // Un-pausing an over-budget group is a no-op the boss cannot see: the
      // scheduler refuses to admit it, so it sits in RUNNING doing nothing.
      const g = ctx.db
        .query<{ budget_tokens: number | null; spent_tokens: number }, [number]>(
          "SELECT budget_tokens, spent_tokens FROM grp WHERE id = ?",
        )
        .get(grpId);
      if (g?.budget_tokens != null && g.spent_tokens >= g.budget_tokens) {
        return bad(
          `out of budget (${g.spent_tokens}/${g.budget_tokens} tokens). Raise the cap first, ` +
            `or it stops again on the next tick.`,
        );
      }
      resume(ctx, grpId);
      return text("ok");
    }
    case "park":
      park(ctx, grpId, "you parked it");
      return text("ok");
    case "newpr": {
      // A closed PR normally comes back by being reopened on GitHub, and the
      // watchdog picks that up. But a PR cannot be reopened once its branch has
      // been force-pushed or deleted, and sometimes the boss simply wants a clean
      // one — without this the group is stuck holding a pr_number that openPr
      // treats as "already done", so it could never get another.
      const g = ctx.db
        .query<{ name: string; repo: string; pr_number: number | null }, [number]>(
          "SELECT g.name, p.repo_path AS repo, g.pr_number FROM grp g JOIN project p ON p.id = g.project_id WHERE g.id = ?",
        )
        .get(grpId);
      if (!g) return text("no such group", 404);
      if (!ctx.gh) return bad("no GitHub client on this server");
      ctx.db.run("UPDATE grp SET pr_number = NULL WHERE id = ?", [grpId]);
      const r = await openPr({
        ctx,
        gh: ctx.gh,
                grpId,
        title: prTitle(ctx, grpId),
        body: prBody(ctx, grpId),
      });
      if ("error" in r) {
        // Put the old number back: a group with no PR and no way to open one is
        // worse off than one whose PR is closed.
        ctx.db.run("UPDATE grp SET pr_number = ? WHERE id = ?", [g.pr_number, grpId]);
        return bad(r.error);
      }
      ctx.db.run("UPDATE grp SET status = 'PR_OPEN', paused_at = NULL WHERE id = ?", [grpId]);
      joinQueue(ctx.db, grpId);
      ctx.db.run(
        `UPDATE escalation SET chain_state = 'answered', answered_by = 'boss', answer = ?
         WHERE grp_id = ? AND answer IS NULL AND question LIKE 'PR #%被关掉了%'`,
        [`opened #${r.number} instead`, grpId],
      );
      ctx.bus.emit({
        grpId,
        author: "boss",
        kind: "state_change",
        body: `opened PR #${r.number} to replace the closed one`,
        meta: { pr: r.number },
      });
      return json({ number: r.number });
    }
    case "drop": {
      // 不做了. A requirement that turned out to be a duplicate, or that someone
      // else already fixed, had no way off the board: 退回重拆 sends it back to the
      // Dispatcher, which writes another card for work nobody wants. The paths it
      // held stayed held, so a group waiting on them waited forever.
      const b = await body<{ why?: string }>(req);
      const g = ctx.db
        .query<{ status: string; name: string }, [number]>("SELECT status, name FROM grp WHERE id = ?")
        .get(grpId);
      if (!g) return text("no such group", 404);
      if (g.status === "DISSOLVED") return text("ok");
      dropGroup(ctx, grpId, b.why ?? "");
      // Its paths are free the moment it leaves ACTIVE, so anything the boss
      // already approved behind it can start now.
      return json({ started: await sweepApproved(ctx) });
    }
    case "wake":
      await unpark(ctx, grpId);
      return text("ok");
    // Throw the container away; the next turn builds a fresh one and
    // `restoreWorkspace` puts the checkout and the dependencies back (the branch
    // itself lives in the boss's repo, so nothing on it is at risk). The way out
    // of a container that is wedged, is missing a mount the boss has just
    // allowed, or is holding a credential that has since been replaced.
    case "rebuild": {
      await killSandbox(ctx, { grp: grpId });
      // The old lines described a container that no longer exists.
      clearSandboxLog(grpId);
      ctx.bus.emit({
        grpId,
        author: "boss",
        kind: "state_change",
        body: say(ctx.config?.language, "sandbox.rebuild"),
      });
      ctx.sched.tick();
      return text("ok");
    }
    case "interrupt": {
      const b = await body<{ mode?: string }>(req);
      const mode = b.mode === "rollback" ? "rollback" : "keep";
      const out = await interrupt(ctx, grpId, mode);
      return json(out);
    }
    default:
      return bad(`unknown action ${action}`);
  }
};






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
const postProject: Handler = async (ctx, req) => {
  const b = await body<{ name?: string; repo?: string; gates?: string[] }>(req);
  const want = (b.repo ?? "").trim();
  if (!want) return bad("which repository? (owner/name)");
  if (!ctx.gh) return bad("this server has no GitHub client");

  // Asked of GitHub rather than trusted from the browser: the default branch is
  // written into the row, and a wrong one is a group that branches off nothing.
  const r = await ctx.gh.request<{
    full_name: string;
    default_branch: string;
    clone_url: string;
    permissions?: Record<string, boolean>;
  }>("GET", `/repos/${want}`);
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
};

/** Idle SSE connections get dropped by proxies and by browsers' own timeouts. */
const SSE_HEARTBEAT_MS = 25_000;

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
const deleteProject: Handler = async (ctx, _req, params) => {
  const id = Number(params.id);
  const p = ctx.db
    .query<{ name: string; repo_path: string; remote: string | null }, [number]>(
      "SELECT name, repo_path, remote FROM project WHERE id = ?",
    )
    .get(id);
  if (!p) return text("no such project", 404);
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
    .query<{ id: number }, [number]>(
      `SELECT id FROM job
        WHERE state IN ('pending', 'running')
          AND (grp_id IN (SELECT id FROM grp WHERE project_id = ?1)
               OR agent_id IN (SELECT id FROM agent WHERE project_id = ?1))`,
    )
    .all(id);
  let stopped = 0;
  for (const j of doomed) if (abortJob(j.id)) stopped++;
  ctx.db.run(
    `UPDATE job SET state = 'cancelled', ended_at = unixepoch() * 1000, error = 'project removed'
      WHERE state IN ('pending', 'running')
        AND (grp_id IN (SELECT id FROM grp WHERE project_id = ?1)
             OR agent_id IN (SELECT id FROM agent WHERE project_id = ?1))`,
    [id],
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
    } catch (e: any) {
      failed.push(`grp ${g.id}: ${e?.message ?? e}`);
    }
    clearSandboxLog(g.id);
  }
  try {
    await killSandbox(ctx, { project: id });
  } catch (e: any) {
    failed.push(`project sandbox: ${e?.message ?? e}`);
  }
  // The bare mirror in the utility container. Its own file owns the path, so
  // that convention has one home; failing is disk, not data — everything in it
  // is on the remote or in a container.
  if (p.remote && !(await removeMirror(ctx, p.remote))) failed.push("mirror");

  // 3. Files, read out of the bodies that name them before those bodies go.
  const root = resolve(join(ctx.config.dataDir ?? "data", "attachments"));
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
};

/**
 * This machine's directories, for the **attachment** picker and nothing else.
 *
 * It used to be how a project was added, which is why it reports `.git` on each
 * entry — a project is a GitHub repository now and comes from the repo list. It
 * stays because attaching a file or a folder to a message is genuinely about
 * this machine: a browser cannot hand over a real path.
 *
 * Names only, never contents: this endpoint has no business reading files, and
 * the page it serves only needs to know what to offer.
 */
/**
 * The blackboard's static half, readable.
 *
 * `note` holds every journal, decision, retro, risk, handoff, onboarding pack and
 * lesson — PLAN.md §7 calls the lesson list "the only mechanism by which the
 * twentieth group is smarter than the first" — and none of it was reachable from
 * the panel at all. Agents could `orch ctx query` it; the boss could not read it.
 */
const getNotes: Handler = async (ctx, req) => {
  const q = new URL(req.url).searchParams;
  const project = q.get("project");
  const group = q.get("group");
  const kind = q.get("kind");
  const where: string[] = [];
  const args: any[] = [];
  if (group) {
    where.push("n.grp_id = ?");
    args.push(Number(group));
  } else if (project) {
    // Project scope includes the standing notes (onboarding, lessons) that belong
    // to no group, which is exactly where they matter.
    where.push("(n.project_id = ? OR g.project_id = ?)");
    args.push(Number(project), Number(project));
  }
  if (kind) {
    where.push("n.kind = ?");
    args.push(kind);
  }
  // The draft card is a note too, and it already has its own screen.
  where.push("coalesce(json_extract(n.frontmatter_json, '$.draft_card'), 0) != 1");
  // Nor are the index's own rows notes: `pageindex` is a serialised tree and
  // `map` is a rendered directory listing, both stored here because `note` was
  // the table that already existed. Neither is anything the boss reads.
  where.push("n.kind NOT IN ('pageindex', 'map')");

  const rows = ctx.db
    .query<unknown, any[]>(
      `SELECT n.id, n.grp_id AS grpId, n.kind, n.body, n.at, n.export_path AS exportPath,
              n.frontmatter_json AS frontmatter, g.name AS "group"
       FROM note n LEFT JOIN grp g ON g.id = n.grp_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY n.at DESC LIMIT 300`,
    )
    .all(...args);
  return json({ notes: rows });
};

/**
 * Every skill on this machine, and whether agents can see it.
 *
 * `on` is what the boss ticked: those get staged into the directory every sandbox
 * mounts, so an agent discovers and invokes them itself. Unticked ones are still
 * listed — naming one in a requirement injects it into that single turn — which is
 * why the composer offers all of them and asks before using an unticked one.
 */
const getSkills: Handler = async (ctx, req) => {
  const id = Number(new URL(req.url).searchParams.get("project"));
  const repo = ctx.db
    .query<{ repo_path: string }, [number]>("SELECT repo_path FROM project WHERE id = ?")
    .get(id)?.repo_path;
  projectSkillsPending(ctx, id, repo);
  const off = new Set(skillsOff(ctx.db));
  return json({
    skills: listSkills(repo, projectSkills(ctx.db, id)).map(({ name, rel, description, scope }) => ({
      name,
      path: rel,
      description,
      scope,
      // A project skill ships with the repository the group is working on, so it
      // is always delivered and there is nothing to tick.
      on: scope === "project" || !off.has(name),
    })),
  });
};

/**
 * Tick or untick one skill, then rebuild the staging directory.
 *
 * Rebuilt now rather than at the next sandbox: the mount is a directory, so what
 * changes here is visible to every running container as soon as the next turn's CLI
 * process starts. No sandbox is rebuilt for a tick box.
 */
const postSkill: Handler = async (ctx, req) => {
  const b = (await req.json().catch(() => ({}))) as { name?: string; on?: boolean };
  // No name is a rescan: the boss installed or removed a skill outside this
  // process, and the staged copy is the only thing that does not know yet.
  if (b.name) setSkillOff(ctx.db, b.name, b.on === false);
  const { staged, failed } = restageSkills(ctx.db, ctx.config?.skillsDir ?? "/var/tmp/orch-cache/skills");
  // The mount is a staging path now, not either CLI's own directory, so a
  // changed set is not visible until the links are rebuilt. Every live
  // container, because a standing agent's container has no checkout and so no
  // other moment that would ever redo them.
  await relinkSkills();
  return json({ staged: staged.length, failed });
};

const getDirs: Handler = async (ctx, req) => {
  const q = new URL(req.url).searchParams;
  const asked = q.get("path") ?? homedir();
  const path = resolve(expandHome(asked));
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch (e) {
    return bad(`${path}: ${(e as Error).message}`);
  }
  const taken = new Set(
    ctx.db.query<{ repo_path: string }, []>("SELECT repo_path FROM project").all().map((r) => r.repo_path),
  );
  const dirs = entries
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => {
      const full = join(path, d.name);
      return { name: d.name, path: full, repo: existsSync(join(full, ".git")), taken: taken.has(full) };
    })
    .sort((a, b) => (a.repo === b.repo ? a.name.localeCompare(b.name) : a.repo ? -1 : 1));
  // Files only when someone is picking files. The repo picker asking for them
  // would list a thousand entries in a source directory to choose one folder.
  const files = q.get("files")
    ? entries
        .filter((d) => d.isFile() && !d.name.startsWith("."))
        .map((d) => {
          const full = join(path, d.name);
          let size = 0;
          try {
            size = statSync(full).size;
          } catch {}
          return { name: d.name, path: full, size };
        })
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];
  // A repo can be picked at any level, including the one being listed.
  return json({
    path,
    parent: path === "/" ? null : dirname(path),
    repo: existsSync(join(path, ".git")),
    dirs,
    files,
  });
};

const getStream: Handler = async (ctx, req) => {
  const since = Number(new URL(req.url).searchParams.get("since") ?? 0);
  let unsub = () => {};
  let beat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      const raw = (s: string) => {
        try {
          c.enqueue(enc.encode(s));
          return true;
        } catch {
          unsub();
          if (beat) clearInterval(beat);
          return false;
        }
      };
      // Which project a frame belongs to, so the feed can be scoped. grp -> project
      // is immutable, so it is cached rather than queried per frame — live frames
      // arrive per token.
      const ofGrp = new Map<number, number | null>();
      const projectOf = (grpId: number | null | undefined): number | null => {
        if (grpId == null) return null;
        if (!ofGrp.has(grpId)) {
          ofGrp.set(
            grpId,
            ctx.db.query<{ project_id: number }, [number]>("SELECT project_id FROM grp WHERE id = ?").get(grpId)
              ?.project_id ?? null,
          );
        }
        return ofGrp.get(grpId) ?? null;
      };
      const send = (data: any) =>
        raw(`data: ${JSON.stringify({ ...data, projectId: data.projectId ?? projectOf(data.grpId) })}\n\n`);

      // A stream that sends nothing has sent no bytes, and a browser does not
      // report a byteless response as open — the UI sat on "connecting…" forever
      // on a fresh database with no events to replay. The comment also defeats
      // proxy buffering, and `retry` sets the reconnect delay.
      raw(`retry: 3000\n: connected\n\n`);

      for (const e of ctx.bus.since(since)) send({ type: "event", ...e });
      unsub = ctx.bus.subscribe(send);
      beat = setInterval(() => raw(`: ping\n\n`), SSE_HEARTBEAT_MS);
      req.signal.addEventListener("abort", () => {
        unsub();
        if (beat) clearInterval(beat);
        try {
          c.close();
        } catch {}
      });
    },
    cancel() {
      unsub();
      if (beat) clearInterval(beat);
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
};

// ---------------------------------------------------------------------- router


/**
 * A project's own knobs: what it gates on, how it installs, what its sandboxes
 * look like. Merged into `config_json` key by key, so a page that only knows
 * about gates cannot blank the sandbox block on save.
 */
/**
 * Everything `config_json` means. Read from it, in this order: `gate.ts`,
 * `start.ts`, `executor.ts`, `sandbox.ts`, `repomap.ts`.
 *
 * A list rather than a shape check — the values are validated where they are
 * used, and the thing this stops is a key nobody validates because nobody knew
 * it was there.
 */
const CONFIG_KEYS = new Set(["gates", "install", "sandbox", "container", "index"]);

const patchProjectConfig: Handler = async (ctx, req, params) => {
  const id = Number(params.id);
  const row = ctx.db.query<{ config_json: string }, [number]>("SELECT config_json FROM project WHERE id = ?").get(id);
  if (!row) return text("no such project", 404);
  const patch = await body<Record<string, unknown>>(req);
  // A column, not a config_json key: it is read on every clone, rebase and diff,
  // and it is re-detected and written back when the remote renames it. Empty
  // means "ask the remote", which is what a fresh project starts as.
  if ("baseBranch" in patch) {
    const want = String(patch.baseBranch ?? "").trim();
    ctx.db.run("UPDATE project SET base_branch = ? WHERE id = ?", [want || null, id]);
    delete patch.baseBranch;
  }
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(row.config_json || "{}");
  } catch {
    current = {};
  }
  // The keys this config actually has. It used to merge whatever arrived, and
  // `config_json` is not inert data: `install` is run as a shell command inside
  // the sandbox and `gates` decides which resource templates a slice must pass,
  // so an unknown key is either a typo that silently does nothing or a name some
  // later version will start honouring — set by whoever could reach this route
  // before anybody decided what it means.
  //
  // A refusal rather than a filter, for the same reason as the image above: a
  // setting that is quietly dropped is worse than one that is turned away.
  for (const k of Object.keys(patch)) {
    if (!CONFIG_KEYS.has(k)) return bad(`项目配置里没有 ${k} 这一项`);
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete current[k];
    else current[k] = v;
  }
  // Said here as well as enforced in `specFor`. The enforcement is what makes it
  // true — this route merges arbitrary keys, and a check only in the panel is a
  // check a curl walks around — but a config that is silently ignored is worse
  // than one that is refused, so the door answers.
  const want = (current as { sandbox?: { image?: string } }).sandbox?.image;
  if (want && !allowedImage(want)) {
    return bad(
      `镜像只能是我们发布的（ghcr.io/pamin-labs/…）或者你本地构建的（比如 orch/agent:1）。` +
        `agent 在这个镜像里跑，而它面前是你的代码 —— 换成别处的镜像等于把整条边界交出去，而且从面板上看不出来。`,
    );
  }
  ctx.db.run("UPDATE project SET config_json = ? WHERE id = ?", [JSON.stringify(current), id]);
  return json(current);
};

const getProjectConfig: Handler = async (ctx, _req, params) => {
  const row = ctx.db
    .query<{ config_json: string; repo_path: string; base_branch: string | null }, [number]>(
      "SELECT config_json, repo_path, base_branch FROM project WHERE id = ?",
    )
    .get(Number(params.id));
  if (!row) return text("no such project", 404);
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(row.config_json || "{}");
  } catch {
    config = {};
  }
  const resources = ctx.db
    .query<{ name: string; template: string }, []>("SELECT name, template FROM resource ORDER BY name")
    .all();
  return json({
    repoPath: row.repo_path,
    config,
    resources,
    baseBranch: row.base_branch,
    // What it resolves to right now, so an empty box is not a mystery.
    baseBranchNow: await baseBranch(ctx, Number(params.id)),
    // What the remote has, so the box is a choice rather than a memory test.
    branches: await listBranches(ctx, Number(params.id)),
  });
};

/**
 * One group's container: what it is, and what it has been saying.
 *
 * The lines are in memory and capped (`sandboxlog.ts`) — this is the machine
 * setting itself up, which is worth watching and scrolling back through, not
 * worth a table. The panel says so rather than pretending the log is durable.
 */
const getSandbox: Handler = async (ctx, req) => {
  const grpId = Number(new URL(req.url).searchParams.get("grp") ?? 0);
  const grp = ctx.db
    .query<
      { id: number; name: string; status: string; project_id: number; sandbox_id: string | null; sandbox_at: number | null; branch: string | null },
      [number]
    >("SELECT id, name, status, project_id, sandbox_id, sandbox_at, branch FROM grp WHERE id = ?")
    .get(grpId);
  if (!grp) return text("no such group", 404);
  const spec = specFor(ctx, grp.project_id);
  return json({
    group: { id: grp.id, name: grp.name, status: grp.status, branch: grp.branch },
    sandbox: {
      id: grp.sandbox_id,
      at: grp.sandbox_at,
      image: spec.image,
      cpu: spec.cpu,
      memory: spec.memory,
      ttlSeconds: spec.ttlSeconds,
      mounts: [
        ...Object.entries(spec.cacheDirs).map(([mountPath, hostPath]) => ({ mountPath, hostPath, readOnly: false })),
        ...skillMounts(ctx).map((m) => ({ mountPath: m.mountPath, hostPath: m.host?.path ?? "", readOnly: true })),
      ],
    },
    lines: sandboxLines(grpId),
  });
};

const getPreflight: Handler = async (ctx) =>
  json({
    checks: await preflight({
      db: ctx.db,
      sandbox: ctx.config.sandbox ?? { server: "127.0.0.1:8080", apiKey: "", image: "" },
      skillsDir: ctx.config.skillsDir,
    }),
  });

/**
 * What the image field may be set to. Two lists, never a text box.
 *
 * Cached for a minute: the remote half is two round trips to ghcr.io and the
 * local half shells out to docker, and the settings dialog asks on every open.
 */
let imageCache: { at: number; v: ImageChoices } | null = null;
const getImages: Handler = async (ctx) => {
  if (!imageCache || Date.now() - imageCache.at > 60_000) {
    imageCache = { at: Date.now(), v: await imageChoices() };
  }
  // Which one a project gets when it says nothing. Registering a repository
  // sets no image at all, so this is what the fleet actually runs on.
  return json({ ...imageCache.v, current: defaultImage(ctx.db, ctx.config.sandbox?.image ?? "") });
};

const postImage: Handler = async (ctx, req) => {
  const b = await body<{ image?: string }>(req);
  const image = (b.image ?? "").trim();
  // The same rule the container build applies, applied where the boss can read
  // it. Without this the refusal arrives as a container that will not create.
  if (image && !allowedImage(image)) return bad(`${image} 不是我们发布的镜像，也不是本机构建的`);
  setDefaultImage(ctx.db, image);
  return text("ok");
};

/**
 * The process that hands out containers, and what a restart of it would cost.
 *
 * Whether it is *healthy* is preflight's answer and stays preflight's answer —
 * two things saying "is it up" that can disagree is worse than one that is
 * occasionally stale. This is only what preflight cannot know: the pid, the
 * argv it was started with, and therefore whether there is anything to restart
 * it *with*. `runningServer` learns the argv by seeing the process, so an
 * orchestrator that booted while the server was already down has never seen one
 * and the button has to be dead rather than hopeful.
 *
 * The two counts are the evidence for that button (硬约束 5): a restart kills
 * every container and every turn inside them.
 */
const getSandboxServer: Handler = async (ctx) => {
  const live = runningServer();
  const count = (sql: string) => ctx.db.query<{ c: number }, []>(sql).get()!.c;
  // Inspect, never ensure. Which of the cases this is decides which button the
  // panel may show — and a GET that starts a process is a page that changes the
  // machine by being looked at.
  const state = await inspectServer(ctx);
  const drift = driftingPaths(ctx);
  return json({
    running: state.kind !== "down",
    addr: serverAddr(ctx),
    // Plain HTTP to a host that is neither loopback nor an encrypted overlay.
    inClear: remoteInClear(serverAddr(ctx)),
    state: state.kind,
    why: "why" in state ? state.why : null,
    pid: "pid" in state ? state.pid : (live?.pid ?? null),
    config: state.kind === "started" ? state.config : (live?.config ?? null),
    argv: live?.argv ?? [],
    // Ours only. Restarting a server we did not start takes down whatever else
    // on this machine was using it, and nothing here can see what that was.
    restartable: !!ourArgv(ctx),
    // The silent one: a mount of a path missing from `allowed_host_paths`
    // succeeds and delivers an empty directory.
    drift,
    // Its own last words, when there are any. Shown rather than summarised: the
    // reason a start fails is almost always in here verbatim.
    log: state.kind === "down" ? serverLogTail(ctx, 8) : "",
    containers: count("SELECT count(*) AS c FROM grp WHERE sandbox_id IS NOT NULL"),
    runningTurns: count("SELECT count(*) AS c FROM job WHERE state = 'running'"),
  });
};

const postSandboxServerRestart: Handler = async (ctx) => {
  // `ourArgv`, not `runningServer().argv`. The panel only offers this when the
  // server is one we started; this is the same rule enforced where it matters,
  // because a request can arrive from anywhere and "restart" here means killing
  // a machine-wide process that may be somebody's own.
  const argv = ourArgv(ctx);
  if (!argv) {
    return bad(
      "这个沙盒服务器不是我们起的，不会去动它 —— 它可能是你自己起的，配的是别的东西。要重启就自己重启，之后这里会认得它。",
    );
  }
  const err = await restartServer(argv, serverLogPath(ctx));
  // A deliberate restart clears the automatic counter, or the boss restarts by
  // hand, it does not take, and the watchdog has already spent its three tries
  // on the same problem.
  resetServerRestarts();
  if (err) return bad(err);
  ctx.bus.emit({ author: "orchestrator", kind: "state_change", body: "沙盒服务器重启了，容器都没了" });
  return json({ ok: true });
};

/** Point us at another server. The way out of "that one is not ours". */
const postSandboxServerAddr: Handler = async (ctx, req) => {
  const b = await body<{ addr?: string }>(req);
  const addr = (b.addr ?? "").trim();
  // `host:port`, or empty to fall back to the yaml. Checked because a bad value
  // here makes every container call fail somewhere far away from this box.
  // A hostname and an optional scheme, because the server does not have to be on
  // this machine: a Tailscale peer or a cloud box works the same way.
  if (addr && !/^(https?:\/\/)?[\w.-]+(:\d{2,5})?$/.test(addr)) {
    return bad("填 host:port，或者 https://host:port。比如 127.0.0.1:8081、sandbox.tail1234.ts.net:8080");
  }
  setServerAddr(ctx, addr);
  return json({ ok: true, addr: serverAddr(ctx) });
};

/** Start one when there is none. The panel's way out of the `down` state. */
const postSandboxServerStart: Handler = async (ctx) => {
  const st = await ensureServer(ctx);
  if (st.kind === "down") return bad(st.why);
  ctx.bus.emit({
    author: "orchestrator",
    kind: "state_change",
    body: st.kind === "started" ? `沙盒服务器起好了（pid ${st.pid}）` : "沙盒服务器本来就在跑，直接用了",
  });
  return json({ ok: true, state: st.kind });
};

const ROUTES: Array<[string, RegExp, Handler]> = [
  ["GET", /^\/api\/auth$/, getAuth],
  ["POST", /^\/api\/auth$/, postAuth],
  ["POST", /^\/api\/auth\/claude\/login$/, postClaudeLogin],
  ["POST", /^\/api\/auth\/claude\/login\/code$/, postClaudeCode],
  ["POST", /^\/api\/auth\/claude\/login\/cancel$/, postClaudeCancel],
  ["GET", /^\/api\/auth\/github$/, getGithubLogin],
  ["GET", /^\/api\/github\/repos$/, getGithubRepos],
  ["POST", /^\/api\/auth\/github$/, postGithubLogin],
  ["POST", /^\/api\/git\/trailers$/, postTrailers],
  ["POST", /^\/api\/auth\/codex\/device$/, postCodexDevice],
  ["POST", /^\/api\/auth\/codex\/device\/cancel$/, postCodexDeviceCancel],
  ["GET", /^\/api\/preflight$/, getPreflight],
  ["GET", /^\/api\/sandbox\/images$/, getImages],
  ["POST", /^\/api\/sandbox\/images$/, postImage],
  ["GET", /^\/api\/sandbox-server$/, getSandboxServer],
  ["POST", /^\/api\/sandbox-server\/restart$/, postSandboxServerRestart],
  ["POST", /^\/api\/sandbox-server\/start$/, postSandboxServerStart],
  ["POST", /^\/api\/sandbox-server\/addr$/, postSandboxServerAddr],
  ["GET", /^\/api\/sandbox$/, getSandbox],
  ["GET", /^\/api\/project\/(?<id>\d+)\/config$/, getProjectConfig],
  ["POST", /^\/api\/project\/(?<id>\d+)\/config$/, patchProjectConfig],

  ["GET", /^\/api\/state$/, getState],
  ["GET", /^\/api\/cost$/, getCost],
  ["GET", /^\/api\/stream$/, getStream],
  ["GET", /^\/api\/dirs$/, getDirs],
  ["GET", /^\/api\/notes$/, getNotes],
  ["GET", /^\/api\/skills$/, getSkills],
  ["POST", /^\/api\/skills$/, postSkill],
  ["POST", /^\/api\/projects$/, postProject],
  ["DELETE", /^\/api\/projects\/(?<id>\d+)$/, deleteProject],
  ["POST", /^\/api\/ideas$/, postIdea],
  ["POST", /^\/api\/attach$/, postAttach],
  ["POST", /^\/api\/attach\/local$/, postAttachLocal],
  ["POST", /^\/api\/say$/, postSay],
  ["POST", /^\/api\/draft\/(?<id>\d+)\/(?<decision>approve|reject)$/, postDraftDecision],
  // No `landed`: whether a PR is merged is GitHub's answer, and `pollPrs` asks it
  // every tick. A button for it was a boss confirming by hand what the server
  // already knew — and one mis-click dissolved a group whose PR was still open.
  ["POST", /^\/api\/groups\/(?<id>\d+)\/(?<action>pause|resume|park|wake|interrupt|budget|drop|newpr|rebuild)$/, postGroupControl],
  ["GET", /^\/api\/slices\/(?<id>\d+)\/evidence$/, getEvidence],
  ["GET", /^\/api\/slices\/(?<id>\d+)\/gate\/(?<name>[\w.-]+)$/, getGateLog],
  ["POST", /^\/api\/slices\/(?<id>\d+)\/(?<decision>accept|reject)$/, postSliceDecision],
  ["POST", /^\/api\/escalations\/(?<id>\d+)\/answer$/, postAnswer],
  ["POST", /^\/api\/escalations\/(?<id>\d+)\/revoke$/, postRevoke],
  ["POST", /^\/api\/escalations\/(?<id>\d+)\/requirement$/, postEscalationRequirement],
  ["POST", /^\/api\/escalations\/(?<id>\d+)\/delegate$/, postDelegate],
  ["GET", /^\/api\/escalations\/(?<id>\d+)\/draft$/, getAnswerDraft],
  ["GET", /^\/api\/attach\/(?<name>[^/]+)$/, getAttachment],
];

/**
 * Is this write coming from somewhere other than the panel?
 *
 * `/api/*` takes no token — its caller is a browser on 127.0.0.1 and the port is
 * the whole authentication story. That stops the network and does not stop a web
 * page: `body<T>()` never checks `content-type`, so a POST with the default
 * `text/plain` is a *simple* request, no preflight, delivered. The attacker
 * cannot read the reply and does not need to — wiping the boss's credentials,
 * approving a DRAFT and dropping a group are all one-way.
 *
 * A deny-list, not an allow-list, because the legitimate non-browser callers —
 * `curl`, `bun test`, the mailbox replay — send neither header, and refusing
 * those would be refusing everything except the panel. Every browser that can
 * mount this attack sends `Sec-Fetch-Site`.
 */
export function crossSiteWrite(req: Request, port: number): boolean {
  if (req.method === "GET" || req.method === "HEAD") return false;
  const site = req.headers.get("sec-fetch-site");
  // Present on every modern browser request, and it says `same-origin` however
  // the boss spelled the host — `localhost` and `127.0.0.1` are the same page to
  // it and different strings to `Origin`.
  if (site) return site !== "same-origin" && site !== "none";
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    const u = new URL(origin);
    const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
    return !loopback || u.port !== String(port);
  } catch {
    return true;
  }
}

/**
 * The regex table, as a Hono handler.
 *
 * Temporary by design: routes move onto Hono a cluster at a time, and whatever
 * has not moved yet still resolves here. It goes away with the last entry in
 * `ROUTES`. Keeping both alive at once is what makes the move reviewable in
 * pieces instead of as one 3800-line rewrite.
 */
function legacyRoutes(ctx: Ctx): (req: Request) => Promise<Response> {
  return async (req) => {
    const path = new URL(req.url).pathname;
    for (const [method, re, h] of ROUTES) {
      if (req.method !== method) continue;
      const m = re.exec(path);
      if (!m) continue;
      return h(ctx, req, (m.groups ?? {}) as Record<string, string>);
    }
    return text("not found", 404);
  };
}

/**
 * Everything an agent can call, behind one authentication check.
 *
 * `/orch` has no session and no cookie: the only credential is the token minted
 * when the agent was hired, and the mailbox is what carries it out of the
 * sandbox. The prefix gate on the mailbox decides which routes are *reachable*,
 * never who is reaching them — so this middleware is the whole check, and it is
 * one place rather than the first two lines of every handler.
 */
function orchRoutes(ctx: Ctx): Hono<{ Variables: { agent: Caller } }> {
  const app = new Hono<{ Variables: { agent: Caller } }>();
  app.use("*", async (c, next) => {
    const a = agentOf(ctx, c.req.raw);
    // 401, where 19 of these used to say 422 and two said 401. Nothing branches
    // on the difference — `orch` prints the body for anything past 400 — and
    // "you are not who you say you are" has a status code.
    if (!a) return c.text("unknown or missing agent token", 401);
    c.set("agent", a);
    await next();
  });
  const on = (fn: AgentHandler) => (c: { req: { raw: Request; param: () => Record<string, string> }; get: (k: "agent") => Caller }) =>
    fn(ctx, c.req.raw, c.get("agent"), c.req.param());

  app.post("/status", on(postStatus));
  app.post("/journal", on(postJournal));
  app.post("/mail", on(postMail));
  app.post("/ask-boss", on(postAskBoss));
  app.post("/setup", on(postSetup));
  app.post("/lease", on(postLease));
  app.get("/lease/:id/log", on(getLeaseLog));
  app.post("/ctx/query", on(postCtxQuery));
  app.get("/task", on(getTasks));
  app.post("/task/claim", on(postTaskClaim));
  app.post("/task/done", on(postTaskDone));
  app.post("/review", on(postReview));
  app.post("/audit", on(postAudit));
  app.post("/pr", on(postPr));
  app.post("/answer", on(postAnswer2));
  app.post("/triage", on(postTriage));
  app.post("/draft", on(postDraft));
  app.post("/owns", on(postOwns));
  app.post("/drop", on(postDrop));
  app.post("/blocked", on(postBlocked));
  app.post("/split", on(postSplit));
  return app;
}

export function makeApp(ctx: Ctx): (req: Request) => Promise<Response> {
  const app = new Hono();

  // One place, ahead of everything. It used to be an `if` at the top of the
  // dispatch loop, which is the same thing until someone adds a second dispatch
  // path — and a CSRF check that one route can be written around is not a check.
  app.use("/api/*", async (c, next) => {
    if (crossSiteWrite(c.req.raw, ctx.config.port ?? 47821)) {
      return c.text("cross-site writes are refused", 403);
    }
    await next();
  });

  // An uncaught handler error was a 500 with the message in the body, and stays
  // one: `orch` prints this text straight at an agent, and "error: ..." is more
  // use to it than an empty 500.
  app.onError((e, c) => c.text(`error: ${(e as Error)?.message ?? e}`, 500));

  app.route("/orch", orchRoutes(ctx));
  app.all("*", (c) => legacyRoutes(ctx)(c.req.raw));
  return async (req) => app.fetch(req);
}


