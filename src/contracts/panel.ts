import { z } from "zod";
import { ESCALATION_STATES, GRP_STATES, SLICE_STATES, TASK_STATES } from "../states.ts";

/**
 * What the panel is sent, declared once.
 *
 * These shapes existed twice: as `db.query<Row>` type parameters here and as
 * hand-written interfaces in `web/src/lib/api.ts`. Neither was checked against
 * anything. `db.query<T>` is an unchecked cast — SQLite hands back whatever the
 * SELECT produced and TypeScript believes the annotation — so a migration that
 * renames a column produces `undefined` on the other side of the wire with no
 * error anywhere, and the browser's copy of the shape would still have said the
 * field was a `string`.
 *
 * So: zod is the declaration, `z.infer` is the type on both sides, and
 * `test/snapshot-shape.test.ts` runs a real snapshot through `.parse()`. The
 * parse is in a test rather than in the route because this is our own payload —
 * paying to validate it on every poll would buy nothing the test does not, and
 * the snapshot is re-read on every state change.
 */

export const Project = z.object({
  id: z.number(),
  name: z.string(),
  repo_path: z.string(),
  remote: z.string().nullable(),
  /** Empty means "ask the remote". Taken from GitHub at add time, correctable in 设置. */
  base_branch: z.string().nullable(),
});

export const Group = z.object({
  id: z.number(),
  project_id: z.number(),
  name: z.string(),
  branch: z.string().nullable(),
  status: z.enum(GRP_STATES),
  owns_json: z.string(),
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
  gates_json: z.string(),
  spent_tokens: z.number(),
  /** When it started waiting on the boss. The clock on 白干的单位. */
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

export const Answered = z.object({
  id: z.number(),
  grp_id: z.number(),
  question: z.string(),
  answer: z.string(),
  answered_by: z.string(),
  ref_note_id: z.number().nullable(),
});

export const GroupNote = z.object({ grpId: z.number(), body: z.string() });
export const GroupSaid = z.object({ grpId: z.number(), author: z.string(), body: z.string() });
export const ClaudeLoginFlowSchema = z.object({ url: z.string(), expiresAt: z.number() });
export const CodexLoginFlowSchema = ClaudeLoginFlowSchema.extend({ code: z.string() });
const PanelNoteSchema = z.object({
  id: z.number(),
  grpId: z.number().nullable(),
  kind: z.string(),
  body: z.string(),
  at: z.number(),
  exportPath: z.string().nullable(),
  frontmatter: z.string().nullable(),
  group: z.string().nullable(),
});
export const NotesResponseSchema = z.object({ notes: z.array(PanelNoteSchema) });
const Blocked = z.object({ grpId: z.number(), reason: z.string() });
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

export const SnapshotSchema = z.object({
  ready: z.boolean(),
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
export type GroupNote = z.infer<typeof GroupNote>;
export type GroupSaid = z.infer<typeof GroupSaid>;
export type ClaudeLoginFlow = z.infer<typeof ClaudeLoginFlowSchema>;
export type CodexLoginFlow = z.infer<typeof CodexLoginFlowSchema>;
export type PanelNote = z.infer<typeof PanelNoteSchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
