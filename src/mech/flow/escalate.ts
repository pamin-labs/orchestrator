import { and, eq, isNull, notInArray, sql } from "drizzle-orm";
import type { DB } from "../../platform/persistence/database.ts";
import { escalation } from "../../platform/persistence/schema.ts";
import { ESCALATION_TERMINAL_STATES, type EscalationOpenState } from "../../contracts/states.ts";

/** A state a newly filed question may enter. The other two are terminal. */
type FilingState = EscalationOpenState;

/** What counts as the same still-open subject. Row ownership is independent. */
export type Dedupe = { prefix: string; scope: "global" } | { prefix: string; scope: "group"; grpId: number };

/**
 * Filing a question for a human, in one place.
 *
 * Nine sites wrote this INSERT with four column lists, and three guarded it with
 * three subtly different predicates. Dedupe scope is explicit because the row
 * recording which group hit a bad credential is one account-wide warning, while a
 * budget warning belongs to one group.
 *
 * The bus message stays at the call site, or each question is announced twice.
 */
export interface EscalationRequest {
  grpId?: number | null;
  agentId?: number | null;
  /** Blocker stops the group. Advisory is a note in the queue. */
  severity?: "blocker" | "advisory";
  question: string;
  /** ≤20 chars, what it is about — this is what the queue shows. */
  brief?: string | null;
  /** env | spec | boundary | design | other. Folds a requirement's questions. */
  kind?: string | null;
  /** `boss` skips the PM → Architect → CoS chain. Omitted questions start at PM. */
  chain?: EscalationOpenState | null;
  dedupe?: Dedupe;
}

/** The columns every filing writes, whichever of the two paths writes them. */
const row = (ask: EscalationRequest) => ({
  grp_id: ask.grpId ?? null,
  agent_id: ask.agentId ?? null,
  severity: ask.severity ?? "blocker",
  question: ask.question,
  brief: ask.brief ?? null,
  kind: ask.kind ?? null,
  chain_state: ask.chain ?? ("pm" satisfies FilingState),
  created_at: Date.now(),
});

export async function raise(db: DB, ask: EscalationRequest): Promise<number | null> {
  const dedupe = ask.dedupe;
  if (!dedupe) {
    const [filed] = await db.insert(escalation).values(row(ask)).returning({ id: escalation.id });
    return filed?.id ?? null;
  }

  // The check and the insert are one transaction holding a lock on the subject,
  // where they used to be one statement: `INSERT ... SELECT ... WHERE NOT EXISTS`
  // needs a FROM-less SELECT, which Drizzle cannot build with a typed column list.
  // Without the lock two simultaneous failures both pass a stale check and file
  // the same question twice. `starts_with` compares the prefix literally, so %, _
  // and \ stay ordinary subject characters — which is what `LIKE` would not do.
  const open = and(
    isNull(escalation.answer),
    notInArray(escalation.chain_state, [...ESCALATION_TERMINAL_STATES]),
    sql`starts_with(${escalation.question}, ${dedupe.prefix})`,
    dedupe.scope === "group" ? eq(escalation.grp_id, dedupe.grpId) : undefined,
  );
  const key = dedupe.scope === "group" ? `${dedupe.grpId}:${dedupe.prefix}` : dedupe.prefix;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
    const [existing] = await tx.select({ id: escalation.id }).from(escalation).where(open).limit(1);
    if (existing) return null;
    const [filed] = await tx.insert(escalation).values(row(ask)).returning({ id: escalation.id });
    return filed?.id ?? null;
  });
}
