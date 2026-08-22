import { z } from "zod";
import { JsonValue } from "./json.ts";
import { SaidSchema } from "./said.ts";
import { ESCALATION_STATES, GRP_STATES, SLICE_STATES, TASK_STATES } from "./states.ts";

/**
 * What the panel is sent, declared once.
 *
 * These shapes existed twice — as `db.query<Row>` parameters here and as
 * hand-written interfaces in the browser. Neither was checked: `db.query<T>` is an
 * unchecked cast, so a migration that renames a column produces `undefined` on the
 * other side of the wire with no error anywhere, and the browser's copy would
 * still have said the field was a `string`.
 */
/**
 * So zod is the declaration, `z.infer` is the type on both sides, and
 * `snapshot-shape.test.ts` runs a real snapshot through `.parse()`. The parse is in
 * a test rather than the route because this is our own payload: validating it on
 * every poll would buy nothing the test does not, and the snapshot is re-read on
 * every state change.
 */

export const Project = z.object({
  id: z.number(),
  name: z.string(),
  repo_path: z.string(),
  remote: z.string().nullable(),
  /** Empty means "ask the remote". Taken from GitHub at add time, correctable in `Settings`. */
  base_branch: z.string().nullable(),
});

export const Group = z.object({
  id: z.number(),
  project_id: z.number(),
  name: z.string(),
  branch: z.string().nullable(),
  status: z.enum(GRP_STATES),
  owns_json: JsonValue,
  budget_tokens: z.number().nullable(),
  spent_tokens: z.number(),
  pr_number: z.number().nullable(),
  /** The boss approved, but a boundary is holding it. Cleared when it starts. */
  approved_at: z.number().nullable(),
});

export const Slice = z.object({
  id: z.number(),
  grp_id: z.number(),
  seq: z.number(),
  title: z.string(),
  accept_spec: z.string(),
  difficulty: z.string(),
  status: z.enum(SLICE_STATES),
  gates_json: JsonValue,
  spent_tokens: z.number(),
  /** When it started waiting on the boss. The clock on wasted-work-per-hour. */
  awaiting_at: z.number().nullable(),
});

export const Task = z.object({
  id: z.number(),
  grp_id: z.number(),
  slice_id: z.number().nullable(),
  title: z.string(),
  status: z.enum(TASK_STATES),
});

export const Agent = z.object({
  id: z.number(),
  grp_id: z.number().nullable(),
  role: z.string(),
  model: z.string(),
  state: z.string(),
  activity: z.string().nullable(),
  session_tokens: z.number(),
  total_tokens: z.number(),
  turns: z.number(),
  slice_id: z.number().nullable(),
});

export const Channel = z.object({
  id: z.number(),
  project_id: z.number().nullable(),
  grp_id: z.number().nullable(),
  kind: z.string(),
  status: z.string().nullable(),
});

export const Archived = z.object({
  id: z.number(),
  project_id: z.number(),
  name: z.string(),
  branch: z.string().nullable(),
  pr_number: z.number().nullable(),
  spent_tokens: z.number(),
  slices: z.number(),
  at: z.number().nullable(),
});

export const Escalation = z.object({
  id: z.number(),
  grp_id: z.number().nullable(),
  severity: z.string(),
  question: z.string(),
  /**
   * The descriptors `question` and `brief` were rendered from, where the server
   * wrote them. Absent where an agent did — its own words are never rewritten —
   * and absent on every row stored before the column existed, which is why the
   * text beside them stays and the panel falls back to it.
   */
  said: SaidSchema.optional(),
  briefSaid: SaidSchema.optional(),
  chain_state: z.enum(ESCALATION_STATES),
  /** One line of what it is about, for the queue. Written by whoever filed it. */
  brief: z.string().nullable(),
  /**
   * env | spec | boundary | design | other. The queue folds a requirement's
   * questions by this: a dozen of one kind is one problem, not a dozen.
   */
  kind: z.string().nullable(),
  answered_by: z.string().nullable(),
  answer: z.string().nullable(),
  created_at: z.number(),
  asker: z.string().nullable(),
  /**
   * Which project the asker belongs to. A standing agent has no group, so this
   * is the only thing that tells one project's question from another's.
   */
  asker_project: z.number().nullable(),
});

export const DraftCard = z.object({
  grpId: z.number(),
  body: z.string(),
  at: z.number(),
  /** Paths the card names that are not in the repo — new files, or a plan from memory. */
  unknownPaths: z.string().nullable().optional(),
});

/**
 * An escalation a stand-in answered, offered back so the boss can take it over.
 *
 * `grp_id` and `answer` are nullable because the query cannot promise otherwise: a
 * standing agent's question belongs to no group, and `chain_state = 'answered'` is
 * reached by `revoked` and by the answer chain running out, neither of which writes
 * an answer. Both were declared required and asserted rather than parsed, so the
 * NULLs reached the browser typed as `string`.
 */
export const Answered = z.object({
  id: z.number(),
  grp_id: z.number().nullable(),
  question: z.string(),
  /** As on `Escalation`: the descriptor if the server wrote the question. */
  said: SaidSchema.optional(),
  answer: z.string().nullable(),
  answered_by: z.string(),
  ref_note_id: z.number().nullable(),
});

const GroupNote = z.object({ grpId: z.number(), body: z.string() });
const GroupSaid = z.object({ grpId: z.number(), author: z.string(), body: z.string() });
/** Why an approved group is still held. `reason`/`said` are the `HostFailure`
 *  pair: English for anything that is not a browser, the key for one that is. */
const Blocked = z.object({ grpId: z.number(), reason: z.string(), said: SaidSchema.optional() });
const QueueEntry = z.object({
  projectId: z.number(),
  grpId: z.number(),
  name: z.string(),
  branch: z.string().nullable(),
  seq: z.number(),
});

/**
 * A subscription window, as the watchdog last read it.
 *
 * Stored as a JSON blob in `usage_snapshot.json`, so the row type cannot say
 * what is in it — the server used to spread a `JSON.parse` and TypeScript
 * concluded the whole thing was `{runtime, at}`. The browser meanwhile declared
 * six more fields it was reading off it, and neither side was wrong about the
 * data, only about who knew. Parsed rather than cast, because this one really is
 * untrusted at the boundary: it was written by an earlier version of us.
 */
export const UsageWindow = z.object({
  runtime: z.string(),
  at: z.number(),
  status: z.string().optional(),
  /** Unix seconds. The five-hour window's reset. */
  resetsAt: z.number().optional(),
  fiveHourPercent: z.number().optional(),
  weeklyPercent: z.number().optional(),
  weeklyResetsAt: z.number().optional(),
  /** Why the last read failed. The percentages beside it are the last good ones. */
  error: z.string().optional(),
});

/**
 * A preflight check that is currently failing, on its way to the panel.
 *
 * No `ok`: only failures are sent. The whole set — passing included — is the
 * settings page's answer, and it costs a host round trip to produce; this is the
 * one the boss has to be told about without opening anything.
 */
export const HostFailure = z.object({
  name: z.string(),
  /** English, and the panel's fallback: a key its own table does not know yet still reads. */
  detail: z.string(),
  /** How the boss fixes it. */
  fix: z.string().optional(),
  /** The same two sentences as keys, rendered in whatever language this browser reads. */
  said: SaidSchema,
  fixSaid: SaidSchema.optional(),
});

export const SnapshotSchema = z.object({
  ready: z.boolean(),
  /** What preflight last found wrong. Empty on a healthy host. */
  failing: z.array(HostFailure),
  projects: z.array(Project),
  groups: z.array(Group),
  slices: z.array(Slice),
  tasks: z.array(Task),
  agents: z.array(Agent),
  escalations: z.array(Escalation),
  channels: z.array(Channel),
  draftCards: z.array(DraftCard),
  lateObjections: z.array(GroupSaid),
  approvedBlocked: z.array(Blocked),
  dropProposals: z.array(GroupNote),
  ideas: z.array(GroupNote),
  answered: z.array(Answered),
  mergeQueue: z.array(QueueEntry.extend({ place: z.object({ position: z.number(), total: z.number() }).nullable() })),
  archived: z.array(Archived),
  usage: z.array(UsageWindow),
  limits: z.object({
    maxGroups: z.number().nullable(),
    leaseSlots: z.record(z.string(), z.number()),
    autoAdvance: z.boolean(),
    autoAcceptTiers: z.array(z.string()),
  }),
  lastSeq: z.number(),
});

export type UsageWindow = z.infer<typeof UsageWindow>;
export type Project = z.infer<typeof Project>;
export type Group = z.infer<typeof Group>;
export type Slice = z.infer<typeof Slice>;
export type Task = z.infer<typeof Task>;
export type Agent = z.infer<typeof Agent>;
export type Channel = z.infer<typeof Channel>;
export type Archived = z.infer<typeof Archived>;
export type Escalation = z.infer<typeof Escalation>;
export type DraftCard = z.infer<typeof DraftCard>;
export type Answered = z.infer<typeof Answered>;
export type HostFailure = z.infer<typeof HostFailure>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
