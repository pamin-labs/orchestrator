import { validateDraftCard } from "../mech/flow/validate.ts";
import { canStart, claimsShared, overlaps, parseOwns, sharedFor } from "../mech/flow/ownership.ts";
import { sweepApproved } from "../mech/flow/start.ts";
import { baseRefFor, sandboxGit, treeFiles } from "../mech/git/checkout.ts";
import { execIn, WORK } from "../mech/sandbox/sandbox.ts";
import { extractClaimedFiles } from "../mech/flow/reconcile.ts";
import { shq } from "../mech/util/shq.ts";
import { say } from "../lang.ts";
import { bad, body, json, mayAct, resolveGroup, text, type AgentHandler } from "./shared.ts";
import { slug } from "./slug.ts";

/**
 * What a group does with its own plan: file the DRAFT card, fan out into
 * several groups, propose that the work is already done, report a path it may
 * not touch, and declare which paths it owns.
 *
 * All five are verbs an agent calls and all five can create or dissolve a
 * group, which is why they are one file: the invariant that a group has exactly
 * one owner of any path is enforced across them, not inside any one of them.
 */

/**
 * The Dispatcher files its DRAFT card.
 *
 * Validated here rather than trusted, and the group only becomes DRAFT once a
 * card exists — the boss should never be asked to approve nothing.
 */
export const postDraft: AgentHandler = async (ctx, req, a) => {
  const b = await body<{ group_id: number | string; card: string }>(req);
  if (a.role !== "dispatcher" && a.role !== "pm") return bad(`${a.role} does not file DRAFT cards`);

  const v = validateDraftCard(b.card ?? "");
  if (!v.ok) return bad(v.error);

  const grpId = resolveGroup(ctx, b.group_id, a.grp_id);
  if (!grpId) return bad("which group? pass its id or name");
  if (!mayAct(ctx, a, grpId)) return text("not your group", 403);
  const grp = ctx.db
    .query<{ project_id: number }, [number]>("SELECT project_id FROM grp WHERE id = ?")
    .get(grpId);
  if (!grp) return bad(`no group ${grpId}`);

  // Paths the card names that are not in the repo.
  //
  // Not a refusal — a card that plans a new file names it, and that is the whole
  // point of planning. But a plan written from memory of a codebase rather than
  // from reading it names files that were never there, and that is the cheapest
  // detectable symptom of the one failure with no deterministic line under it
  // (PLAN.md §13 risk ①): a decomposition pointed the wrong way. The boss gets the
  // list beside the card and decides which it is, in the same 20 seconds.
  //
  // Against the base ref rather than what is on disk: the host checkout sits on
  // whatever branch the boss last had out, so `existsSync` was asking a working
  // tree nobody planned against, and the answer moved when the boss switched
  // branches. `ls-tree` of the base is the same thing the group will be cut from.
  const remote = ctx.db
    .query<{ remote: string | null }, [number]>("SELECT remote FROM project WHERE id = ?")
    .get(grp.project_id)?.remote;
  const claimed = extractClaimedFiles([b.card]);
  let unknown: string[] = [];
  if (remote && claimed.length) {
    // Out of the utility container's mirror, not a checkout on this host: there
    // is none since step 6, and asking one that was not there threw rather than
    // returning a code — which is how this handler used to 500 with the DRAFT
    // card unfiled and nothing saying so.
    const inBase = new Set(await treeFiles(ctx, remote, await baseRefFor(ctx, grp.project_id)));
    if (inBase.size) unknown = claimed.filter((p) => !inBase.has(p)).slice(0, 8);
  }

  ctx.db.run(
    `INSERT INTO note (project_id, grp_id, kind, lang, body, frontmatter_json, at)
     VALUES (?, ?, 'fact', ?, ?, ?, unixepoch() * 1000)`,
    [
      grp.project_id,
      grpId,
      ctx.config.language,
      b.card,
      JSON.stringify({ draft_card: true, ...(unknown.length ? { unknownPaths: unknown } : {}) }),
    ],
  );
  ctx.db.run("UPDATE grp SET status = 'DRAFT' WHERE id = ?", [grpId]);
  // Planning is over, so anything still queued for this group is moot — and DRAFT
  // is not dispatchable, so it would otherwise sit pending forever and then fire
  // after approval against a plan it never saw.
  const dropped = ctx.sched.cancelPending(grpId, "planning finished");
  ctx.bus.emit({
    grpId,
    author: a.role,
    kind: "state_change",
    body: `DRAFT card filed: ${v.goal}${dropped ? ` (${dropped} planning turn(s) dropped)` : ""}`,
    meta: { slices: v.slices.length, objection: v.objection },
  });
  ctx.notifyBoss?.(0, `DRAFT ready: ${v.goal}`, "advisory");
  return text("ok");
};

/**
 * One idea, several requirements.
 *
 * The boss types into one box, and what lands there is often not one thing: a dozen
 * questions and three unrelated asks in one paragraph. Until this existed the shape
 * of the system forced all of it into ONE requirement — one DRAFT card with one 目标
 * line and at most five slices, one branch, one Engineer working serially, and one PR
 * at the end. The Dispatcher's only options were to drop most of it or to write a 目标
 * that was not true ("多项改进"), and `checkSplit` would not object, because four
 * unrelated slices genuinely do have four different acceptance criteria.
 *
 * A requirement is the unit of a PR and of acceptance (PLAN.md §7), so unrelated work
 * must be unrelated requirements: separate branches, separate boundaries, separately
 * mergeable, separately rejectable. Splitting IS decomposition, which makes it the
 * Dispatcher's job — so it gets a verb rather than a prompt telling it to cope.
 *
 * Only before work exists. After a card is approved there is a branch and a checkout,
 * and re-cutting then is `respec`, not a split.
 */
const MAX_SPLIT = 6;

export const postSplit: AgentHandler = async (ctx, req, a) => {
  const b = await body<{ group_id: number | string; requirements?: { name?: string; idea: string }[]; why?: string }>(req);
  if (a.role !== "dispatcher" && a.role !== "pm") return bad(`${a.role} does not split requirements`);

  const gid = resolveGroup(ctx, b.group_id, a.grp_id);
  if (!gid) return bad("which group? pass its id or name");
  if (!mayAct(ctx, a, gid)) return text("not your group", 403);
  const grp = ctx.db
    .query<{ project_id: number; name: string; status: string; branch: string | null }, [number]>(
      "SELECT project_id, name, status, branch FROM grp WHERE id = ?",
    )
    .get(gid);
  if (!grp) return text("no such group", 404);
  if (grp.status !== "PLANNING") {
    return bad(
      `${grp.name} is ${grp.status}, not PLANNING. A split only makes sense before a card is approved; ` +
        `after that the branch exists and re-cutting the work is the boss's respec, not yours.`,
    );
  }
  const hasWork = ctx.db
    .query<{ c: number }, [number]>("SELECT count(*) AS c FROM slice WHERE grp_id = ?")
    .get(gid)!.c;
  if (hasWork > 0 || grp.branch) return bad(`${grp.name} already has slices or a branch; split before that`);

  const items = (b.requirements ?? []).filter((r) => r?.idea?.trim());
  if (items.length < 2) {
    return bad(
      "a split needs at least 2 requirements. If it is one thing, just file the card with `orch draft`.",
    );
  }
  if (items.length > MAX_SPLIT) {
    return bad(
      `${items.length} is too many for one split (max ${MAX_SPLIT}). Group what shares an acceptance path, ` +
        `and ask the boss which of the rest matters first.`,
    );
  }

  // What the boss originally said, so nothing typed in that box is lost — including
  // the attachment paths, which live in the first note.
  const original = ctx.db
    .query<{ id: number; body: string }, [number]>(
      "SELECT id, body FROM note WHERE grp_id = ? AND kind = 'fact' ORDER BY at LIMIT 1",
    )
    .get(gid);

  const made: { id: number; name: string }[] = [];
  for (const item of items) {
    // Slugged even when the agent supplied it. A group name becomes a branch
    // (`orch/<name>`), a path under docs/journal and an argument to host git —
    // "whatever 40 characters an agent felt like" is not a shape any of those want.
    const name = slug(item.name?.trim() || item.idea);
    const child = ctx.db
      .query<{ id: number }, [number, string]>(
        "INSERT INTO grp (project_id, name, status, created_at) VALUES (?, ?, 'PLANNING', unixepoch() * 1000) RETURNING id",
      )
      .get(grp.project_id, name)!;
    const ch = ctx.db
      .query<{ id: number }, [number, number]>(
        "INSERT INTO channel (project_id, grp_id, kind, created_at) VALUES (?, ?, 'group', unixepoch() * 1000) RETURNING id",
      )
      .get(grp.project_id, child.id)!;
    ctx.db.run(
      "INSERT INTO note (project_id, grp_id, kind, lang, body, at) VALUES (?, ?, 'fact', ?, ?, unixepoch() * 1000)",
      [
        grp.project_id,
        child.id,
        ctx.config.language,
        `${item.idea.trim()}\n\n（从「${grp.name}」拆出来的一条${original ? `，原始整段见 note #${original.id}` : ""}）`,
      ],
    );
    ctx.bus.emit({
      channelId: ch.id,
      grpId: child.id,
      author: "boss",
      kind: "boss_say",
      intent: "request",
      body: item.idea.trim(),
    });
    ctx.sched.enqueue("agent_turn", { grp_id: child.id, priority: 5, payload: { role: "dispatcher", idea: item.idea.trim() } });
    made.push({ id: child.id, name });
  }

  // The container is done: its pending turns would re-plan work that has moved. No
  // retro — it never did any work, and demanding one for a bookkeeping group would
  // teach the agents that retros are paperwork.
  ctx.sched.cancelPending(gid, "split into separate requirements");
  ctx.db.run("UPDATE grp SET status = 'DISSOLVED' WHERE id = ?", [gid]);
  ctx.db.run("UPDATE channel SET status = 'archived' WHERE grp_id = ?", [gid]);
  ctx.bus.emit({
    grpId: gid,
    author: a.role,
    kind: "state_change",
    body: `拆成 ${made.length} 个独立需求：${made.map((m) => m.name).join("、")}${b.why ? ` —— ${b.why}` : ""}`,
    meta: { split: made.map((m) => m.id) },
  });
  ctx.sched.tick();
  return json({ requirements: made });
};

/**
 * "This is already done." The one thing a planner could not say.
 *
 * A requirement that is a duplicate, or that someone fixed between the boss
 * typing it and the Dispatcher reading the code, has no exit: the Dispatcher digs
 * in, slices it, and files a card for work that does not need doing. The only
 * thing standing between that and a group burning a day on it is the boss's 20
 * seconds on the DRAFT card — PLAN.md §13's risk ①, and the one judgement in the
 * system with no deterministic line under it.
 *
 * This is not the agent dissolving the group. It cannot be: "there is nothing to
 * do here" is the single most attractive thing a tired model can conclude, and no
 * prompt survives being the cheap way out. So it is a proposal, it costs evidence
 * the server checks itself — a commit that is really in the repo, or a group that
 * really exists — and the boss presses the button.
 */
export const postDrop: AgentHandler = async (ctx, req, a) => {
  const b = await body<{ group_id?: number | string; why?: string; commit?: string; duplicate?: number | string }>(req);
  if (!["dispatcher", "pm", "architect"].includes(a.role)) return bad(`${a.role} does not propose dropping work`);
  const gid = resolveGroup(ctx, b.group_id, a.grp_id);
  if (!gid) return bad("which group? pass its id or name");
  if (!mayAct(ctx, a, gid)) return text("not your group", 403);
  const why = (b.why ?? "").trim();
  if (why.length < 10) return bad("--why has to say what already covers it, in a sentence");

  // Evidence the server can check. A sentence alone is a model's opinion of its
  // own workload, which is exactly what must not be able to close a requirement.
  let evidence: string;
  if (b.duplicate != null) {
    const dup = resolveGroup(ctx, b.duplicate);
    if (!dup) return bad(`no group ${b.duplicate}`);
    if (dup === gid) return bad("a group cannot be a duplicate of itself");
    const d = ctx.db.query<{ name: string }, [number]>("SELECT name FROM grp WHERE id = ?").get(dup)!;
    evidence = `duplicate of ${d.name} (grp ${dup})`;
  } else if (b.commit) {
    const sha = String(b.commit).trim();
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) return bad("--commit takes a sha, 7 to 40 hex characters");
    // Checked where the agent read it: its own clone. Against the host checkout
    // this asked a repository the caller has never seen — a sha that exists only
    // on the group's branch is not there at all, and the ancestry test below ran
    // against the boss's local `HEAD`, so the verdict changed with whatever branch
    // the boss happened to have checked out.
    const git = sandboxGit(ctx, { grp: gid });
    const r = await git(WORK, ["cat-file", "-t", sha], WORK);
    if (r.code !== 0 || r.out.trim() !== "commit") return bad(`${sha} is not a commit in this repo`);
    // And it has to be on the main line. Any real sha passes cat-file, including
    // one on an abandoned branch or on the group's own unmerged work — "it is
    // already done" means done where everyone can see it.
    const projectId = ctx.db
      .query<{ project_id: number }, [number]>("SELECT project_id FROM grp WHERE id = ?")
      .get(gid)?.project_id;
    if (!projectId) return bad("no such group");
    const base = await baseRefFor(ctx, projectId);
    const merged = await git(WORK, ["merge-base", "--is-ancestor", sha, base], WORK);
    if (merged.code !== 0) return bad(`${sha.slice(0, 8)} is a real commit but is not on ${base} yet`);
    evidence = `already landed in ${sha.slice(0, 8)}`;
  } else {
    return bad("give evidence: --duplicate <group> or --commit <sha>");
  }

  ctx.db.run(
    `INSERT INTO note (project_id, grp_id, kind, lang, body, frontmatter_json, at)
     VALUES ((SELECT project_id FROM grp WHERE id = ?), ?, 'decision', ?, ?, ?, unixepoch() * 1000)`,
    [gid, gid, ctx.config.language, `${why}\n\n证据：${evidence}`, JSON.stringify({ drop_proposal: 1 })],
  );
  // DRAFT, so the group stops being dispatchable and the boss is asked. Left in
  // PLANNING the Dispatcher would be woken again and re-propose the same thing.
  ctx.db.run("UPDATE grp SET status = 'DRAFT' WHERE id = ? AND status = 'PLANNING'", [gid]);
  ctx.bus.emit({
    grpId: gid,
    author: a.role,
    kind: "decision",
    intent: "decision",
    body: `建议作废：${why}（${evidence}）`,
    meta: { drop_proposal: true, evidence },
  });
  return text("ok");
};

/**
 * "I am blocked by something I am not allowed to touch."
 *
 * The gap this closes, seen whole: pm-ai-agent's gate failed on a missing line in
 * `tsconfig.json`. The file is not in its `owns`, so the sandbox refused the write.
 * It could not open a requirement for it — there was no verb. It could not hand it
 * to whoever owns it — `orch mail` is a message, and a message creates no work. So
 * it rewrote its own code three times, hit the retry ceiling, escalated, and
 * stopped. The boss got a blocker with no button on it, and four other groups sat
 * red on the same line.
 *
 * The evidence is the path itself: the server checks the file exists and is
 * genuinely outside this group's boundary. "I cannot reach it" is a fact about the
 * repository, not a claim about how hard the work is — which is the difference
 * between this and a way out of difficult work.
 *
 * Where it goes is decided here, not by the agent: a live group that owns the path
 * gets it as an addition, and if nobody owns it, it becomes a requirement the boss
 * approves like any other. Either way the caller records what it is waiting on and
 * stops, and the watchdog starts it again when that lands.
 */
export const postBlocked: AgentHandler = async (ctx, req, a) => {
  const b = await body<{ group_id?: number | string; path?: string; why?: string }>(req);
  const gid = resolveGroup(ctx, b.group_id, a.grp_id);
  if (!gid) return bad("which group? pass its id or name");
  if (!mayAct(ctx, a, gid)) return text("not your group", 403);
  const path = (b.path ?? "").trim().replace(/^\.\//, "");
  const why = (b.why ?? "").trim();
  if (!path) return bad("--path <file> — which file you cannot change");
  if (why.length < 10) return bad("--why has to say what is wrong with it, in a sentence");

  const me = ctx.db
    .query<{ project_id: number; name: string; owns_json: string }, [number]>(
      "SELECT project_id, name, owns_json FROM grp WHERE id = ?",
    )
    .get(gid);
  if (!me) return bad("no such group");
  // In the group's own checkout, not the host's. The caller named this path from
  // inside `/work`, and the host main checkout sits on whatever the boss last had
  // out — so a file the group created, or one that exists only on its branch,
  // came back as "not a file in this repo", which is both wrong and misleading.
  const seen = await execIn(ctx, { grp: gid }, `test -e ${shq(`${WORK}/${path}`)}`);
  if (seen.code !== 0) return bad(`${path} is not a file in your checkout`);
  // The whole justification. Inside its own boundary the group is expected to fix
  // it, and saying otherwise is the cheap way out of difficult work.
  if (parseOwns(me.owns_json).some((o) => overlaps(o, path))) {
    return bad(`${path} is inside your own boundary — fix it`);
  }

  const owner = ctx.db
    .query<{ id: number; name: string; owns_json: string }, [number, number]>(
      `SELECT id, name, owns_json FROM grp WHERE project_id = ? AND id != ?
         AND status IN ('PLANNING','RUNNING','PAUSING','PAUSED','PARKED','PR_OPEN')`,
    )
    .all(me.project_id, gid)
    .find((o) => parseOwns(o.owns_json).some((glob) => overlaps(glob, path)));

  // Two groups each waiting on the other is two groups that never move again, and
  // nothing downstream would notice: both are PAUSED for a stated reason, and the
  // reason is each other.
  if (owner) {
    for (let at: number | null = owner.id, hops = 0; at && hops < 32; hops++) {
      if (at === gid) return bad(`${owner.name} is already waiting on you — one of you has to go first`);
      at = ctx.db.query<{ blocked_on: number | null }, [number]>("SELECT blocked_on FROM grp WHERE id = ?").get(at)
        ?.blocked_on ?? null;
    }
  }

  let target: number;
  if (owner) {
    // Somebody live already owns it. A second group for the same file would be
    // refused by canStart anyway, so this is an addition to their work.
    target = owner.id;
    ctx.bus.emit({
      grpId: owner.id,
      author: a.role,
      kind: "say",
      intent: "request",
      body: `${me.name} 被 ${path} 挡住了，那是你们的路径：${why}`,
      meta: { from_group: gid, path },
    });
    ctx.sched.enqueue("agent_turn", {
      grp_id: owner.id,
      priority: 6,
      payload: {
        role: "pm",
        rejection: `Another group is blocked on ${path}, which is inside your boundary: ${why}\n\nAdd it to this group's work.`,
      },
    });
  } else {
    const name = slug(`${path} ${why}`).slice(0, 40) || `fix-${gid}`;
    // A shared file — package.json, tsconfig.json, the migrations array — belongs
    // to no group on purpose, and a requirement opened for one could never start:
    // the boundary can only be the file itself, and canStart refuses exactly that.
    // The grant names this one path for this one group, so everybody else is still
    // refused, and the boundary is settled here rather than costing an Architect
    // turn to discover there is only one answer.
    const grant = claimsShared([path], sharedFor(ctx.db, me.project_id));
    const grp = ctx.db
      .query<{ id: number }, [number, string, string | null, string]>(
        `INSERT INTO grp (project_id, name, status, shared_grant, owns_json, created_at)
         VALUES (?, ?, 'PLANNING', ?, ?, unixepoch() * 1000) RETURNING id`,
      )
      .get(me.project_id, name, grant.length ? JSON.stringify(grant) : null, JSON.stringify([path]))!;
    ctx.db.run(
      "INSERT INTO channel (project_id, grp_id, kind, created_at) VALUES (?, ?, 'group', unixepoch() * 1000)",
      [me.project_id, grp.id],
    );
    const idea = `${why}\n\n（${me.name} 报的：${path} 不在它的边界内，它改不了）`;
    ctx.db.run(
      "INSERT INTO note (project_id, grp_id, kind, lang, body, at) VALUES (?, ?, 'fact', ?, ?, unixepoch() * 1000)",
      [me.project_id, grp.id, ctx.config.language, idea],
    );
    // boss_say, because that is what every planner reads as the requirement, and a
    // second shape for "this is the ask" would be a second thing to remember.
    ctx.bus.emit({ grpId: grp.id, author: a.role, kind: "boss_say", intent: "request", body: idea });
    ctx.sched.enqueue("agent_turn", { grp_id: grp.id, priority: 6, payload: { role: "dispatcher", idea } });
    target = grp.id;
  }

  // Stop, and say what it is waiting for. PAUSED rather than a spin: a group with
  // nothing it can legally do should not hold a concurrency slot.
  ctx.db.run(
    "UPDATE grp SET status = 'PAUSED', paused_at = unixepoch() * 1000, blocked_on = ? WHERE id = ?",
    [target, gid],
  );
  ctx.sched.cancelPending(gid, `blocked on ${path}`);
  ctx.bus.emit({
    grpId: gid,
    author: a.role,
    kind: "state_change",
    body: say(ctx.config?.language, "group.blocked", { path, target: String(target) }),
    meta: { blocked_on: target, path },
  });
  ctx.sched.tick();
  return json({ blocked_on: target, handedTo: owner ? owner.name : "a new requirement" });
};

export const postOwns: AgentHandler = async (ctx, req, a) => {
  const b = await body<{ group_id: number | string; paths: string[] }>(req);
  if (a.role !== "architect") return bad(`${a.role} does not cut boundaries`);
  if (!Array.isArray(b.paths) || b.paths.length === 0) return bad("give at least one path glob");
  const gid = resolveGroup(ctx, b.group_id, a.grp_id);
  if (!gid) return bad("which group? pass its id or name");
  if (!mayAct(ctx, a, gid)) return text("not your group", 403);

  ctx.db.run("UPDATE grp SET owns_json = ? WHERE id = ?", [JSON.stringify(b.paths), gid]);
  const check = canStart(ctx.db, gid);
  ctx.bus.emit({
    grpId: gid,
    author: "architect",
    kind: "decision",
    intent: "decision",
    body: `owns ${b.paths.join(", ")}${check.ok ? "" : ` — still blocked: ${check.reason}`}`,
    meta: { paths: b.paths, ok: check.ok },
  });
  // A re-cut can free a group other than the one it touched, so the whole project
  // is swept. Without this the boss's approval sat waiting on a boundary that had
  // already been drawn.
  await sweepApproved(ctx);
  return check.ok ? text("ok") : bad(check.reason ?? "boundary still overlaps");
};
