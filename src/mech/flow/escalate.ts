import { and, eq, isNull, notInArray, sql } from "drizzle-orm";
import type { DB } from "../../platform/persistence/database.ts";
import { escalation } from "../../platform/persistence/schema.ts";
import { ESCALATION_TERMINAL_STATES, type EscalationOpenState } from "../../contracts/states.ts";
import type { Said } from "../../contracts/said.ts";
import { JsonValue, jsonOr } from "../../contracts/json.ts";
import { renderSaid } from "../../platform/text/lang.ts";

/** A state a newly filed question may enter. The other two are terminal. */
type FilingState = EscalationOpenState;

/**
 * What a question is about, as data rather than as its opening line.
 *
 * Four subjects were matched by their prose — `starts_with(question, "PR #12
 * 被关掉了")` and three like it, in five files. That is a primary key made of a
 * sentence: editing it, or translating it, silently stops the matcher. A union
 * rather than `string`, because filing and matching are in different modules and
 * a typo in either is that same silent failure again.
 */
export type EscalationKey = "budget" | `auth:${string}` | `github:${string}` | `pr-closed:${number}`;

export const escalationKey = {
  /** Over the token cap. Deduped per group, so the group is not in the key. */
  budget: "budget",
  /** A runtime's credential stopped working. One warning per runtime, fleet-wide. */
  auth: (runtime: string) => `auth:${runtime}` as const,
  /** GitHub will not accept this project's login. One per repository. */
  githubRepo: (slug: string) => `github:${slug}` as const,
  /** The boss closed a PR without merging. One per PR, so reopening closes its own. */
  prClosed: (pr: number) => `pr-closed:${pr}` as const,
} as const;

/** Whose still-open question counts as the same one. Row ownership is independent. */
export type Dedupe = { scope: "global" } | { scope: "group"; grpId: number };

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
export interface Filing {
  grpId?: number | null;
  agentId?: number | null;
  /** Blocker stops the group. Advisory is a note in the queue. */
  severity?: "blocker" | "advisory";
  /**
   * A descriptor wherever the server wrote the sentence, a plain string wherever
   * somebody else did — an agent's own question is category 1 of ADR 035 and is
   * never rewritten. Both land in `question`, rendered, because four prompt sites
   * splice it verbatim; a descriptor lands in `question_said` as well and the
   * panel prefers that.
   */
  question: Said | string;
  /** ≤20 chars, what it is about — this is what the queue shows. */
  brief?: Said | string | null;
  /** Which language `question` and `brief` are rendered in when they are descriptors. */
  lang?: string | undefined;
  /** env | spec | boundary | design | other. Folds a requirement's questions. */
  kind?: string | null;
  /** `boss` skips the PM → Architect → CoS chain. Omitted questions start at PM. */
  chain?: EscalationOpenState | null;
}

/**
 * `dedupe` is spelled only on the branch that has a `key`, so "suppress a second
 * one" cannot be asked for without saying what the second one would be the same
 * *as*. Without that the request typechecks and quietly dedupes on nothing.
 */
export type EscalationRequest =
  | (Filing & { key?: undefined; dedupe?: undefined })
  | (Filing & { key: EscalationKey; dedupe?: Dedupe });

const textOf = (v: Said | string, lang: string | undefined) => (typeof v === "string" ? v : renderSaid(lang, v));

/**
 * Through `JSON.stringify` and back, the way `event-bus.ts` puts a descriptor
 * into `meta_json`: the column is typed `Json` because a row may have been
 * written by an older build, and a descriptor that will not serialise stores as
 * NULL rather than as something the reader cannot parse — which lands the panel
 * on the rendered text beside it, the same place an old row lands.
 */
const saidOf = (v: Said | string | null | undefined) =>
  typeof v === "object" && v !== null ? jsonOr(JSON.stringify(v), JsonValue, null) : null;

/** The columns every filing writes, whichever of the two paths writes them. */
const row = (ask: EscalationRequest) => ({
  grp_id: ask.grpId ?? null,
  agent_id: ask.agentId ?? null,
  severity: ask.severity ?? "blocker",
  question: textOf(ask.question, ask.lang),
  question_said: saidOf(ask.question),
  brief: ask.brief === null || ask.brief === undefined ? null : textOf(ask.brief, ask.lang),
  brief_said: saidOf(ask.brief),
  kind: ask.kind ?? null,
  chain_state: ask.chain ?? ("pm" satisfies FilingState),
  dedupe_key: ask.key ?? null,
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
  // the same question twice. The subject is `dedupe_key` — equality on a column
  // nobody writes prose into, so %, _ and \ are ordinary key characters again and
  // there is no pattern to escape.
  const open = and(
    isNull(escalation.answer),
    notInArray(escalation.chain_state, [...ESCALATION_TERMINAL_STATES]),
    eq(escalation.dedupe_key, ask.key),
    dedupe.scope === "group" ? eq(escalation.grp_id, dedupe.grpId) : undefined,
  );
  const lock = dedupe.scope === "group" ? `${dedupe.grpId}:${ask.key}` : ask.key;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lock}))`);
    const [existing] = await tx.select({ id: escalation.id }).from(escalation).where(open).limit(1);
    if (existing) return null;
    const [filed] = await tx.insert(escalation).values(row(ask)).returning({ id: escalation.id });
    return filed?.id ?? null;
  });
}
