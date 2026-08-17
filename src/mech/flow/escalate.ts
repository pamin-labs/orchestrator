import type { DB } from "../../db.ts";
import { ESCALATION_TERMINAL_STATES, stateParam, type EscalationOpenState } from "../../contracts/states.ts";

/** A state a newly filed question may enter. The other two are terminal. */
type FilingState = EscalationOpenState;

/** What counts as the same still-open subject. Row ownership is independent. */
export type Dedupe = { prefix: string; scope: "global" } | { prefix: string; scope: "group"; grpId: number };

/**
 * Filing a question for a human, in one place.
 *
 * Nine sites wrote this INSERT with four column lists, and three guarded it with
 * three subtly different predicates. `raise` owns both pieces. Dedupe scope is
 * explicit because the row that records which group hit a bad credential is
 * still one account-wide warning, while a budget warning belongs to one group.
 *
 * The bus message stays at the call site: every caller says something different,
 * and a generic message here would announce each question twice.
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

type Insert = [number | null, number | null, "blocker" | "advisory", string, string | null, string | null, FilingState];

const COLUMNS = "grp_id, agent_id, severity, question, brief, kind, chain_state, created_at";
const VALUES = "?, ?, ?, ?, ?, ?, ?, unixepoch() * 1000";

export function raise(db: DB, ask: EscalationRequest): number | null {
  const values: Insert = [
    ask.grpId ?? null,
    ask.agentId ?? null,
    ask.severity ?? "blocker",
    ask.question,
    ask.brief ?? null,
    ask.kind ?? null,
    ask.chain ?? "pm",
  ];
  if (!ask.dedupe) {
    return db
      .query<{ id: number }, Insert>(`INSERT INTO escalation (${COLUMNS}) VALUES (${VALUES}) RETURNING id`)
      .get(...values)!.id;
  }

  // One statement, not SELECT then INSERT: two simultaneous failures cannot both
  // pass a stale check. `substr` keeps %, _ and \ as literal subject characters.
  const open = `answer IS NULL AND chain_state NOT IN (SELECT value FROM json_each(?))
    AND substr(question, 1, length(?)) = ?`;
  const terminal = stateParam(ESCALATION_TERMINAL_STATES);
  if (ask.dedupe.scope === "global") {
    return (
      db
        .query<{ id: number }, [...Insert, string, string, string]>(
          `INSERT INTO escalation (${COLUMNS})
           SELECT ${VALUES} WHERE NOT EXISTS (SELECT 1 FROM escalation WHERE ${open})
           RETURNING id`,
        )
        .get(...values, terminal, ask.dedupe.prefix, ask.dedupe.prefix)?.id ?? null
    );
  }
  return (
    db
      .query<{ id: number }, [...Insert, string, string, string, number]>(
        `INSERT INTO escalation (${COLUMNS})
         SELECT ${VALUES} WHERE NOT EXISTS (SELECT 1 FROM escalation WHERE ${open} AND grp_id = ?)
         RETURNING id`,
      )
      .get(...values, terminal, ask.dedupe.prefix, ask.dedupe.prefix, ask.dedupe.grpId)?.id ?? null
  );
}
