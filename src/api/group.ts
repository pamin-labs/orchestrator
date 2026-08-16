import { dropSlices } from "../db.ts";
import { interrupt, park, pause, resume, unpark } from "../mech/flow/intercept.ts";
import { dropGroup, startGroup, sweepApproved } from "../mech/flow/start.ts";
import { openPr, prBody, prTitle } from "../mech/git/prwatch.ts";
import { joinQueue, landed } from "../mech/flow/mergequeue.ts";
import { validateDraftCard } from "../mech/flow/validate.ts";
import { canStart, parseOwns } from "../mech/flow/ownership.ts";
import { killSandbox } from "../mech/sandbox/sandbox.ts";
import { clearSandboxLog } from "../mech/sandbox/sandboxlog.ts";
import { bad, body, firstIdea, json, text, type Handler } from "./shared.ts";
import { bossFact, withAttachments, type Attachment } from "./attach.ts";
import { slug } from "./slug.ts";
import { say } from "../lang.ts";
import type { Ctx } from "../ctx.ts";

/**
 * A requirement, from the sentence the boss typed to the branch coming back.
 *
 * The boss's four buttons live here — approve the card, pause, park, drop — and
 * so does what each of them costs. `postGroupControl` is one route because the
 * panel has one row of buttons, not because the eight actions behind it are one
 * thing.
 */

export const postIdea: Handler = async (ctx, req) => {
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

export const postDraftDecision: Handler = async (ctx, req, params) => {
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

export const postGroupControl: Handler = async (ctx, req, params) => {
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
