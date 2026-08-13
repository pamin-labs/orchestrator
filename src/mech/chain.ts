import type { Ctx } from "../api.ts";
import { rollbackTo, type GitRunner } from "./worktree.ts";
import { dropGroup } from "./start.ts";

/**
 * The answer chain: PM -> Architect -> CoS -> the boss.
 *
 * The point is not to keep questions away from the boss; it is to keep the
 * *answerable* ones away. Each level may answer or abstain, and abstaining is the
 * expected move when a level is unsure — guessing on the boss's behalf is worse
 * than waiting, because a wrong answer becomes a premise the whole group reasons
 * from.
 */

export const CHAIN = ["pm", "architect", "cos", "boss"] as const;
export type ChainState = (typeof CHAIN)[number] | "answered" | "revoked";

/**
 * Topics that never route through the chain, however clear the precedent.
 *
 * ponytail: keyword matching, so it over-triggers rather than under-triggers.
 * A question wrongly sent to the boss costs one interruption; one wrongly
 * answered by an agent can cost money or a merge.
 */
const RESERVED = [
  /\b(spend|pay|purchase|buy|subscri|billing|invoice|budget increase)\b/i,
  /\b(merge|merging)\b.*\b(main|master)\b/i,
  /\b(secret|credential|api[_ -]?key|token|password|\.env)\b/i,
  /\b(deploy|publish|release)\b.*\b(prod|production|live)\b/i,
  /\b(scope|out of scope|drop the|add a feature|instead of what)\b/i,
  /(花钱|付费|采购|订阅|预算|密钥|凭据|上线|发布到生产|需求范围|范围变更)/,
];

export function isReserved(question: string): boolean {
  return RESERVED.some((re) => re.test(question));
}

/** Where a new question should start. */
export function entryPoint(question: string): (typeof CHAIN)[number] {
  return isReserved(question) ? "boss" : "pm";
}

export interface ChainDeps {
  /** Wired by api.ts: records a boss fact and checks whether it is the third of its kind. */
  bossFact?: (grpId: number | null, body: string) => void;
  ctx: Ctx;
  git?: GitRunner;
  /** Tell the boss. Wired to the notifier by the server. */
  notifyBoss?: (escId: number, question: string, severity: string) => void;
}

interface EscRow {
  id: number;
  grp_id: number | null;
  agent_id: number | null;
  severity: string;
  question: string;
  chain_state: string;
}

function load(ctx: Ctx, id: number): EscRow | null {
  return (
    ctx.db
      .query<EscRow, [number]>(
        "SELECT id, grp_id, agent_id, severity, question, chain_state FROM escalation WHERE id = ?",
      )
      .get(id) ?? null
  );
}

/**
 * Route a question to whoever should look at it next.
 *
 * A level that has no agent in this group is skipped rather than waited on: an
 * absent Architect must not turn into a stalled question.
 */
export function route(deps: ChainDeps, escId: number): string {
  const { ctx } = deps;
  const esc = load(ctx, escId);
  if (!esc || esc.chain_state === "answered" || esc.chain_state === "revoked") return "closed";

  // A stopped group can answer nothing: every level below the boss replies by
  // taking a turn, and a turn on a paused, parked or draft group is never
  // dispatched. The question then sits at chain_state='pm' forever while the only
  // visible symptom is a group that stopped — which is exactly what a blocker is
  // supposed to prevent.
  //
  // Blockers only. An advisory is "answer it if you can" — the sandbox refusing a
  // command an agent tried is the common one, and it is a JSON blob about a tool
  // call, not a decision. Lifting those to the boss put five of them on the phone
  // as "things need you" and buried the one blocker that did.
  const status = esc.grp_id
    ? ctx.db.query<{ status: string }, [number]>("SELECT status FROM grp WHERE id = ?").get(esc.grp_id)?.status
    : null;
  let level =
    esc.severity === "blocker" && status && !["PLANNING", "RUNNING", "PR_OPEN"].includes(status)
      ? "boss"
      : (esc.chain_state as (typeof CHAIN)[number]);
  for (;;) {
    if (level === "boss") {
      ctx.db.run("UPDATE escalation SET chain_state = 'boss' WHERE id = ?", [escId]);
      deps.notifyBoss?.(escId, esc.question, esc.severity);
      ctx.bus.emit({
        grpId: esc.grp_id,
        author: "orchestrator",
        kind: "escalation",
        intent: "ask",
        severity: esc.severity,
        body: `for you: ${esc.question}`,
        meta: { escalation_id: escId, chain_state: "boss" },
      });
      return "boss";
    }

    const agent = findResponder(ctx, esc.grp_id, level);
    if (agent) {
      ctx.db.run("UPDATE escalation SET chain_state = ? WHERE id = ?", [level, escId]);
      ctx.sched.enqueue("agent_turn", {
        grp_id: esc.grp_id,
        agent_id: agent,
        payload: { escalation: escId, role: level },
        priority: esc.severity === "blocker" ? 8 : 2,
      });
      ctx.sched.tick();
      return level;
    }
    level = CHAIN[CHAIN.indexOf(level) + 1]!;
  }
}

/** A responder for this level: in-group for PM, standing for the rest. */
function findResponder(ctx: Ctx, grpId: number | null, role: string): number | null {
  if (role === "pm") {
    return (
      ctx.db
        .query<{ id: number }, [number | null]>(
          "SELECT id FROM agent WHERE grp_id IS ? AND role = 'pm' AND state != 'retired'",
        )
        .get(grpId)?.id ?? null
    );
  }
  const standing = ctx.db
    .query<{ id: number }, [string]>(
      "SELECT id FROM agent WHERE grp_id IS NULL AND role = ? AND state != 'retired'",
    )
    .get(role)?.id;
  if (standing) return standing;
  // A configured-but-not-yet-hired standing role is a level that exists; skipping
  // it would send the question to the boss for no reason.
  if ((ctx.knownRoles?.() ?? []).includes(role)) return ctx.hire?.(null, role) ?? null;
  return null;
}

export interface AnswerInput {
  escId: number;
  by: string;
  answer: string;
  /** A note id the answer rests on. Required for the CoS. */
  refNoteId?: number;
}

/** A level answers. Resolves whoever is blocked on `orch ask-boss`. */
export function answer(deps: ChainDeps, input: AnswerInput): { ok: true } | { ok: false; error: string } {
  const { ctx } = deps;
  const esc = load(ctx, input.escId);
  if (!esc) return { ok: false, error: `no escalation ${input.escId}` };
  if (esc.chain_state === "answered") return { ok: false, error: "already answered" };

  if (input.by === "cos") {
    // The CoS speaks for the boss only where the boss has already spoken.
    if (!input.refNoteId) {
      return { ok: false, error: "a stand-in answer must cite the decision it rests on (--ref <note_id>)" };
    }
    const note = ctx.db
      .query<{ kind: string }, [number]>("SELECT kind FROM note WHERE id = ?")
      .get(input.refNoteId);
    if (!note) return { ok: false, error: `no note ${input.refNoteId}` };
    if (note.kind !== "decision" && note.kind !== "fact") {
      return { ok: false, error: `note ${input.refNoteId} is a ${note.kind}, not a decision` };
    }
  }
  if (input.by !== "boss" && isReserved(esc.question)) {
    return { ok: false, error: "this one is reserved for the boss whatever the precedent" };
  }

  ctx.db.run(
    `UPDATE escalation SET answer = ?, answered_by = ?, ref_note_id = ?, chain_state = 'answered',
     answered_at = unixepoch() * 1000 WHERE id = ?`,
    [input.answer, input.by, input.refNoteId ?? null, input.escId],
  );
  ctx.bus.emit({
    grpId: esc.grp_id,
    author: input.by,
    kind: "say",
    intent: "inform",
    body: input.answer,
    meta: { in_reply_to_escalation: input.escId, answered_by: input.by, ref: input.refNoteId ?? null },
  });
  if (esc.severity === "blocker" && esc.grp_id) {
    ctx.db.run(
      "UPDATE grp SET status = 'RUNNING', paused_at = NULL WHERE id = ? AND status IN ('PAUSED','PAUSING')",
      [esc.grp_id],
    );
  }

  const w = ctx.waiters.get(`escalation:${input.escId}`);
  ctx.waiters.delete(`escalation:${input.escId}`);
  w?.(input.answer);
  ctx.sched.tick();
  return { ok: true };
}

/** A level declines. Not a failure — it is what keeps a guess from becoming a premise. */
export function abstain(deps: ChainDeps, escId: number, by: string, why: string): void {
  const { ctx } = deps;
  const esc = load(ctx, escId);
  if (!esc) return;
  const next = CHAIN[CHAIN.indexOf(by as (typeof CHAIN)[number]) + 1] ?? "boss";
  ctx.db.run("UPDATE escalation SET chain_state = ? WHERE id = ?", [next, escId]);
  ctx.bus.emit({
    grpId: esc.grp_id,
    author: by,
    kind: "escalation",
    intent: "ask",
    severity: esc.severity,
    body: `${by} passed this up: ${why || "no reason given"}`,
    meta: { escalation_id: escId, next },
  });
  route(deps, escId);
}

/**
 * Undo a stand-in's answer and take over.
 *
 * Without this, delegated answers are an irreversible bet and the boss would
 * rightly never enable them. Rolling the worktree back to the checkpoint recorded
 * when the question was asked is what makes the bet reversible.
 */
export async function revoke(
  deps: ChainDeps,
  escId: number,
): Promise<{ rolledBackTo?: string; answeredBy?: string }> {
  const { ctx } = deps;
  const esc = ctx.db
    .query<{ grp_id: number | null; answered_by: string | null; checkpoint_sha: string | null }, [number]>(
      "SELECT grp_id, answered_by, checkpoint_sha FROM escalation WHERE id = ?",
    )
    .get(escId);
  if (!esc) return {};

  ctx.db.run("UPDATE escalation SET chain_state = 'boss', answer = NULL WHERE id = ?", [escId]);
  if (esc.grp_id) ctx.sched.cancelPending(esc.grp_id, "answer revoked");

  let rolledBackTo: string | undefined;
  if (esc.checkpoint_sha && esc.grp_id && deps.git) {
    const grp = ctx.db
      .query<{ worktree: string | null; project_id: number }, [number]>(
        "SELECT worktree, project_id FROM grp WHERE id = ?",
      )
      .get(esc.grp_id);
    const repo = grp
      ? ctx.db
          .query<{ repo_path: string }, [number]>("SELECT repo_path FROM project WHERE id = ?")
          .get(grp.project_id)?.repo_path
      : undefined;
    if (repo && grp?.worktree) {
      const back = await rollbackTo(deps.git, repo, grp.worktree, esc.checkpoint_sha);
      if (back.ok) rolledBackTo = esc.checkpoint_sha;
      else {
        ctx.bus.emit({
          grpId: esc.grp_id,
          author: "orchestrator",
          kind: "escalation",
          intent: "inform",
          severity: "advisory",
          body: `answer revoked, but the rollback to ${esc.checkpoint_sha.slice(0, 8)} failed: ${back.error}`,
        });
      }
    }
  }
  ctx.bus.emit({
    grpId: esc.grp_id,
    author: "boss",
    kind: "state_change",
    body:
      `revoked ${esc.answered_by ?? "the"} answer` +
      (rolledBackTo ? ` and rolled back to ${rolledBackTo.slice(0, 8)}` : ""),
    meta: { escalation_id: escId, rolledBackTo },
  });
  return { rolledBackTo, answeredBy: esc.answered_by ?? undefined };
}

export type Triage = "patch" | "respec" | "reject";

/**
 * What the boss's complaint means for the work.
 *
 * `respec` has to exist. Without it every complaint is heard as "change this
 * line", and a wrong decomposition can never be corrected — the group keeps
 * polishing something the boss did not ask for.
 */
export function triage(deps: ChainDeps, grpId: number, as: Triage, note: string, skills: string[] = []): void {
  const { ctx } = deps;
  // Through bossFact: a patch is the boss complaining, and the third identical
  // complaint is supposed to become a project rule rather than a third isolated fact.
  //
  // `??` on a void call always takes the fallback: bossFact returns undefined
  // whether or not it ran, so every sentence the boss said was written twice and
  // the requirement's 记录 tab showed each one doubled.
  const body = `boss (${as}): ${note}`;
  if (deps.bossFact) deps.bossFact(grpId, body);
  else {
    ctx.db.run("INSERT INTO note (grp_id, kind, lang, body, at) VALUES (?, 'fact', ?, ?, unixepoch() * 1000)", [
      grpId,
      ctx.config.language,
      body,
    ]);
  }
  ctx.bus.emit({
    grpId,
    author: "cos",
    kind: "state_change",
    intent: "decision",
    body: `triaged as ${as}: ${note}`,
    meta: { triage: as },
  });

  if (as === "reject") {
    // Actually dissolve it. Cancelling the queue left the group ACTIVE, so it went
    // on holding its paths against every other group — a requirement nobody wanted
    // could block one they did, indefinitely. The retro turn that used to be
    // enqueued here could never run either: no status a dropped group has is
    // dispatchable, so it sat pending forever.
    dropGroup(ctx, grpId, note);
  } else if (as === "respec") {
    // PLANNING, not DRAFT. DRAFT blocks dispatch, so setting it here deadlocked the
    // Dispatcher turn enqueued on the next line — the group sat waiting on a boss
    // who was being shown the very card that had just been thrown out.
    ctx.db.run("UPDATE grp SET status = 'PLANNING' WHERE id = ?", [grpId]);
    ctx.sched.enqueue("agent_turn", {
      grp_id: grpId,
      payload: { role: "dispatcher", respec: note, rotate: true, skills },
    });
  } else {
    // A patch normally goes to the PM, who owns the work in flight. But while the
    // card is waiting for approval there is no work in flight and no PM — the
    // Dispatcher owns the card, and the card is the thing that has to change.
    // Sending it to a PM meant the addition was never read and the boss approved a
    // card that did not contain what they had just asked for.
    const draft =
      ctx.db.query<{ status: string }, [number]>("SELECT status FROM grp WHERE id = ?").get(grpId)?.status ===
      "DRAFT";
    if (draft) {
      ctx.db.run("UPDATE grp SET status = 'PLANNING' WHERE id = ?", [grpId]);
      ctx.sched.enqueue("agent_turn", {
        grp_id: grpId,
        payload: {
          role: "dispatcher",
          rejection:
            `The boss added a requirement while the card was waiting for approval: ${note}\n\n` +
            `Rewrite the card so it covers this, then file it again with \`orch draft\`.`,
          skills,
        },
      });
    } else {
      ctx.sched.enqueue("agent_turn", {
        grp_id: grpId,
        payload: { role: "pm", rejection: `The boss wants a correction: ${note}`, skills },
      });
    }
  }
  ctx.sched.tick();
}
