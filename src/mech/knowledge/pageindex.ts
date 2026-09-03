import { msg } from "@lingui/core/macro";
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { jsonOr } from "../../contracts/json.ts";
import { saveSingletonNote, singletonNote } from "../util/rows.ts";
import { type DB, readSetting, writeSetting } from "../../platform/persistence/database.ts";
import { agent, grp, note, nowMs } from "../../platform/persistence/schema.ts";
import type { Ctx } from "../../mech/ctx.ts";
import type { Config } from "../../platform/config/load.ts";
import { runnerFor, WORK, type Scope } from "../sandbox/sandbox.ts";
import { providerFor } from "../../runtime/providers.ts";
import { authStamp } from "../sandbox/auth.ts";
import type { Usage } from "../../runtime/claude.ts";
import { cacheRatio } from "../../runtime/providers/contract.ts";
import { SpanStatusCode } from "@opentelemetry/api";
import { activeTracer } from "../../platform/observability/traces.ts";
import { scrub } from "../../platform/observability/redaction.ts";
import { z } from "zod";

/**
 * PageIndex over this repo: a summary tree, navigated by reasoning.
 *
 * The method is VectifyAI's (github.com/VectifyAI/PageIndex) — a table-of-contents
 * tree whose nodes carry LLM-written summaries, retrieved by letting a model walk
 * it rather than embedding chunks and taking a cosine top-k. Their implementation
 * is Python and takes PDFs page by page; the method is what transfers, so this is
 * that method over `git ls-files`.
 */
/**
 * Why a model call per query is worth it: seven groups were each grepping the same
 * repository for the same file, and a grep round re-reads the whole transcript —
 * turns above 60 rounds ate 59% of the measured cache-read bill. One haiku call
 * answering "it is in `src/mech/notify.ts`, here is why" removes several rounds.
 *
 * Both LLM steps degrade to the lexical map rather than failing: no key, a timeout
 * or a malformed answer must not take retrieval down with it.
 */

export interface Node {
  /** Stable id: the path. Directories end in `/`. */
  id: string;
  kind: "dir" | "file";
  /** LLM-written, one line. Empty until summarised. */
  summary: string;
  /** Changes when the file does, so only what changed is re-summarised. */
  sig: string;
  children: string[];
}

export type Tree = Record<string, Node>;

const NodeSchema = z.object({
  id: z.string(),
  kind: z.enum(["dir", "file"]),
  summary: z.string(),
  sig: z.string(),
  children: z.array(z.string()),
});
const TreeSchema = z.record(z.string(), NodeSchema);

/** One prompt in, one text out. Injected so tests never spawn a model. */
export type Ask = (prompt: string) => Promise<string>;

/**
 * A leaf's text, by id. Injected because the corpus is not one kind of thing: the
 * repo's files come off disk and the blackboard's journals, retros and decisions
 * come out of `note`. They index the same way and answer the same question — where
 * is what I need — so they belong in one tree rather than two retrieval paths.
 */
export type Read = (id: string) => string | null;

/** Notes live under this prefix, so a leaf's id says which corpus it came from. */
export const NOTE_PREFIX = "notes/";

/**
 * How much of a file the summary is written from. Not its signature any more:
 * that is git's blob hash, so the whole file decides *whether* to re-summarise
 * and this decides only how much of it the model gets to read.
 */
/**
 * Measured on this repository, 691 indexable files: 1800 characters covered 17%
 * of them whole, against a median file of 4382 — four files in five described
 * from a fragment. Raising it is close to free: a pass fetches only the files it
 * is about to summarise, at most twelve, and a head is a few hundred tokens
 * against the ~10,000 a CLI invocation costs before it reads anything. 6000
 * covers 59% whole, and the median with room.
 */
export const HEAD_CHARS = 6000;

/** Structure first, summaries second — the same order as the original. */
export function skeleton(files: string[]): Tree {
  const tree: Tree = { "/": { id: "/", kind: "dir", summary: "", sig: "", children: [] } };
  const link = (parent: string, child: string) => {
    if (!tree[parent]!.children.includes(child)) tree[parent]!.children.push(child);
  };
  for (const rel of files) {
    const parts = rel.split("/");
    let parent = "/";
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = `${parts.slice(0, i + 1).join("/")}/`;
      tree[dir] ??= { id: dir, kind: "dir", summary: "", sig: "", children: [] };
      link(parent, dir);
      parent = dir;
    }
    tree[rel] = { id: rel, kind: "file", summary: "", sig: "", children: [] };
    link(parent, rel);
  }
  return tree;
}

const sigOf = (text: string): string => `${text.length}:${Bun.hash(text).toString(36)}`;

/**
 * Summarise bottom-up: a file from its head, a directory from its children's
 * summaries. Directories therefore describe what is under them, which is the
 * property the search step actually navigates on.
 *
 * Incremental by signature. A repo where nothing changed costs zero model calls,
 * which is what makes it affordable to keep this fresh on a timer.
 */
export async function summarise(
  tree: Tree,
  read: Read,
  ask: Ask,
  opts: { maxCalls?: number; previous?: Tree; sigFor?: (id: string) => string | null } = {},
): Promise<{ tree: Tree; calls: number; failed: number }> {
  const prev = opts.previous ?? {};
  const state = { calls: 0, failed: 0, budget: opts.maxCalls ?? 40 };

  for (const node of walkOrder(tree)) {
    if (node.kind === "dir") {
      const children = node.children.map((id) => `${id}: ${tree[id]?.summary ?? ""}`).join("\n");
      const prompt = `One line in English, under 20 words: what does ${node.id} hold, as a whole?\n\n${children.slice(0, 4000)}`;
      await summariseNode(node, children, prompt, prev, ask, state);
      continue;
    }
    const head = read(node.id)?.slice(0, HEAD_CHARS);
    // A file the corpus would not hand over — binary, unreadable, gone between the
    // listing and the read, or simply not fetched because this pass has no budget
    // left for it. Keep what the last pass knew rather than dropping it: a blank
    // leaf changes its directory's signature, and that is the cascade above.
    if (!head) {
      carry(node, prev[node.id]);
      continue;
    }
    await summariseNode(node, head, filePrompt(node.id, head), prev, ask, state, opts.sigFor?.(node.id) ?? null);
  }
  return { tree, calls: state.calls, failed: state.failed };
}

/**
 * The files the next pass would spend a call on, in the order it will reach them.
 *
 * With signatures coming from git, a pass no longer has to read a file to find
 * out whether it changed — so it no longer has to read the ones that did not.
 * Reading the head of every tracked file to summarise at most twelve of them was
 * the largest fixed cost in the tick, and it scaled with the repository.
 */
/**
 * An over-approximation on purpose: directories spend from the same budget, so
 * the pass may reach fewer files than this names. Fetching a head that goes
 * unused costs a few kilobytes; missing one costs a node its summary for a tick.
 */
export function pendingFiles(
  tree: Tree,
  previous: Tree,
  sigFor: (id: string) => string | null,
  limit: number,
): string[] {
  const out: string[] = [];
  for (const node of walkOrder(tree)) {
    if (out.length >= limit) break;
    if (node.kind !== "file") continue;
    const sig = sigFor(node.id);
    // `null` is "the caller did not get this one from git" — a note, whose body it
    // already holds. Only repository files are fetched.
    if (sig === null || previous[node.id]?.sig === sig) continue;
    out.push(node.id);
  }
  return out;
}

/** The order a pass walks the tree in: everything under a directory, then the
 *  directory, deepest first. */
/**
 * A directory is summarised from its children's summaries, so it has to come
 * after them — but "every file, then every directory" is more than that
 * requires, and with hundreds of files against a budget of twelve no directory
 * was reached for fifty-eight ticks. Per directory instead: each is summarised
 * on the tick its own children finish, and a budget that runs out leaves whole
 * subtrees described rather than a field of leaves under nothing.
 */
/**
 * The root is walked but never summarised — search never shows it — so its own
 * files come last, when no directory pass is waiting on them.
 */
export function walkOrder(tree: Tree): Node[] {
  const dirs = Object.values(tree)
    .filter((n) => n.kind === "dir" && n.id !== "/")
    .sort((a, b) => b.id.split("/").length - a.id.split("/").length);
  const out: Node[] = [];
  const filesIn = (dir: Node) => dir.children.map((id) => tree[id]).filter((n) => n?.kind === "file");
  for (const dir of dirs) {
    for (const file of filesIn(dir)) if (file) out.push(file);
    out.push(dir);
  }
  const root = tree["/"];
  if (root) for (const file of filesIn(root)) if (file) out.push(file);
  return out;
}

function filePrompt(id: string, head: string): string {
  const instruction = id.startsWith(NOTE_PREFIX)
    ? "One line in English, under 20 words: what does this note establish? Name the decision or fact, not the format."
    : `One line in English, under 20 words: what is ${id} for? Name the thing it owns, not its language.`;
  return `${instruction}\n\n----\n${head}\n----`;
}

/** What the last pass knew, when this one cannot replace it. */
function carry(node: Node, old: Node | undefined): void {
  if (!old) return;
  node.sig = old.sig;
  node.summary = old.summary;
}

async function summariseNode(
  node: Node,
  content: string,
  prompt: string,
  previous: Tree,
  ask: Ask,
  state: { calls: number; failed: number; budget: number },
  /**
   * The file's identity when the caller has a better one than the text being
   * summarised. Git's blob hash covers the whole file; `sigOf(content)` covers
   * only the head the prompt carries, so an edit past it moved nothing.
   */
  override: string | null = null,
): Promise<void> {
  const sig = override ?? sigOf(content);
  const old = previous[node.id];
  if (old?.sig === sig) {
    node.sig = sig;
    node.summary = old.summary;
    return;
  }
  // A node this pass cannot answer for keeps the last answer, under the signature
  // that produced it. Both ways out below used to leave the node blank, and a
  // directory's content *is* its children's summaries: one child blanked changed
  // the parent's signature, which needed a call, which the budget had already
  // gone on files — so the parent blanked too, and the emptiness climbed a level
  // per tick. Measured live: 822 nodes, 61 summarised down to 48 while the
  // indexer spent 2.9M tokens to 23.3M. Stale text still reads; a blank does not.
  carry(node, old);
  if (state.calls >= state.budget) return;
  state.calls++;
  const summary = oneLine(await ask(prompt));
  if (!summary) {
    state.failed++;
    return;
  }
  node.sig = sig;
  node.summary = summary;
}

const oneLine = (s: string) => s.trim().split("\n").findLast(Boolean)?.slice(0, 160) ?? "";

/**
 * Retrieval: the model walks the tree.
 *
 * At each level it sees ids and summaries and answers with the ids worth opening.
 * Nothing is embedded and nothing is ranked by similarity — which is the point of
 * the method: the reason a node was opened is a sentence you can read, and a node
 * whose summary says "this is where X lives" wins even when it shares no words
 * with the question.
 */
export async function search(tree: Tree, question: string, ask: Ask, walk: Config["pageindex"]): Promise<string[]> {
  // Required rather than defaulted: a literal here is a model bill the boss can
  // neither see nor change, and depth is serial calls per question.
  const { depth, width } = walk;
  let frontier = tree["/"]?.children ?? [];
  const opened: string[] = [];

  for (let level = 0; level < depth && frontier.length; level++) {
    const candidates = frontier;
    const menu = candidates.map((id) => menuLine(tree, id)).join("\n");
    const answer = await ask(
      `Question: ${question}\n\n` +
        `Which of these are worth opening to answer it? Reply with at most ${width} ids, one per line, ` +
        `nothing else. Reply NONE if none of them are relevant.\n\n${menu}`,
    );
    const picked = pickedIds(answer, candidates, width);
    // The model declining is an answer: nothing here is relevant, and handing back
    // the frontier anyway would turn "no" into a top-k guess, which is the failure
    // mode this method exists to avoid.
    if (picked.length === 0) return opened;

    frontier = openNodes(tree, picked, opened);
  }
  // Ran out of depth with directories still open: where to look is still an answer.
  if (opened.length === 0) return frontier.slice(0, width);
  return opened;
}

function menuLine(tree: Tree, id: string): string {
  const node = tree[id];
  return `${id} — ${node?.summary || (node?.kind === "dir" ? "(directory)" : "(file)")}`;
}

function pickedIds(answer: string, candidates: string[], width: number): string[] {
  return answer
    .split("\n")
    .map((line) => line.trim().replace(/^[-*\d.\s]+/, ""))
    .filter((line) => candidates.includes(line))
    .slice(0, width);
}

function openNodes(tree: Tree, picked: string[], opened: string[]): string[] {
  const next: string[] = [];
  for (const id of picked) {
    const node = tree[id];
    if (!node) continue;
    if (node.kind === "file") opened.push(id);
    else next.push(...node.children);
  }
  return next;
}

export function render(tree: Tree, ids: string[]): string {
  return ids.map((id) => `${id} — ${tree[id]?.summary ?? ""}`).join("\n");
}

/**
 * A real one-shot model call, cheapest tier, no tools.
 *
 * Not a role and not a turn: nothing here needs the blackboard, a session or a
 * sandbox — it reads one file head and answers one line. The turn machinery would
 * buy a session, a stable prefix and a cost row for a call that costs less than the
 * bookkeeping.
 */
/**
 * It is also the most frequent model call in the system — one per `orch ctx query`
 * plus one per changed file on a rebuild — and it is pure summarisation, so which
 * subscription pays is a config choice like any role's. `-s read-only` costs
 * nothing here: this prompt never runs a command, and codex's sandbox governs the
 * commands the model asks for, not codex's own API traffic.
 */
export type AskUsage = Usage;

export function modelAsk(
  ctx: Ctx,
  spec: { runtime?: string; model: string },
  scope: Scope,
  timeoutMs = 60_000,
  /**
   * Called once per call with what it cost.
   *
   * A callback rather than a change to `Ask`, because `summarise` and `search`
   * are pure and injectable and six tests depend on that. It is also the whole of
   * the cost fix: this is the most frequent model call in the system and it
   * appeared in no report at all, because it is not a turn and `cost.ts` reads
   * turns.
   */
  onUsage?: (u: AskUsage) => void,
): Ask {
  const provider = providerFor(spec.runtime);
  const breaker = breakerKey(scope, spec);
  return async (prompt) => {
    // Read per call, not once: signing the runtime in is what makes a tripped
    // breaker worth reopening, and a value resolved when the `Ask` was built
    // would be the state at boot for the life of the process.
    const stamp = await authStamp(ctx.db);
    if (await tripped(ctx, breaker, stamp)) return "";
    const answer = await call(prompt);
    await record(ctx, breaker, stamp, answer !== "", spec);
    return answer;
  };

  function call(prompt: string): Promise<string> {
    return (
      // Up to twelve of these per project on every heartbeat, each a full model
      // round trip inside a container, and the panel had no row for any of them.
      // `onUsage` above fixed the money; this fixes the clock.
      activeTracer().startActiveSpan("index.ask", { attributes: { "model.name": spec.model } }, async (span) => {
        try {
          const r = await provider
            .ask({
              model: spec.model,
              prompt,
              cwd: WORK,
              timeoutMs,
              runner: runnerFor(ctx, scope),
            })
            .catch(() => null);
          if (!r || r.code !== 0) {
            // The empty string is both a legitimate answer and the failure value,
            // and `summarise` counts it as `failed` without being able to tell
            // which. The span can tell, so it says — **and says what the CLI
            // said**. Measured over one 7-hour window: 36 of 36 calls failed,
            // 738.5s of wall clock, and the only record of any of it was the two
            // words `exit 1`. Scrubbed, because the CLI echoes its own arguments
            // on a bad flag.
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: r ? `exit ${r.code}: ${scrub(r.err).trim().slice(-400) || "said nothing"}` : "exec threw",
            });
            return "";
          }
          if (r.usage) onUsage?.(r.usage);
          // Exit 0 and nothing to show for it: the branch above is written for a
          // non-zero exit and this is the one it did not cover. Three calls came
          // back this way on a live installation, each leaving a span with
          // `unset` status and no message at all.
          if (!r.text.trim()) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: "exit 0 with no answer" });
          }
          return r.text;
        } finally {
          span.end();
        }
      })
    );
  }
}

/**
 * A call that has never worked here stops being made.
 *
 * ADR 040 measured this layer failing 36 times out of 36 in one seven-hour
 * window, 20.5 seconds each, while the lexical half it falls through to answers
 * in 0.32ms — so every `orch ctx query` in that window paid about a minute for
 * three calls that returned nothing. The ADR decided not to cut the layer, and
 * this does not: it stops **repeating** a failure, which is a different decision
 * and the one the wall clock was asking for.
 */
/** Keyed by the model and the runtime, so the boss changing either starts a fresh
 *  count — the two settings events in that window show both runtimes being tried,
 *  which is exactly the recovery this must not stand in the way of. Three, because
 *  one is a blip and two is a coincidence. */
const BREAKER_TRIPS = 3;

const breakerKey = (scope: Scope, spec: { runtime?: string; model: string }): string =>
  `index-fail:${scopeKey(scope)}:${spec.runtime ?? "claude"}:${spec.model}`;

/** The three shapes a scope has, as one string. */
const scopeKey = (scope: Scope): string =>
  "grp" in scope ? `g${scope.grp}` : "project" in scope ? `p${scope.project}` : "util";

/**
 * The count, and the credential state it was counted under.
 *
 * Stored together because a count on its own latches. `record` clears it only on
 * a success and `tripped` returns before the call that could produce one, so the
 * single thing that reopens the breaker sits behind the door it locks — the only
 * accidental way out was changing the model or the runtime, which changes the key.
 */
/**
 * Measured on a live installation: it tripped while codex had no credential,
 * codex was signed in at 14:04, and at 00:50 it was still returning an empty
 * string twelve times a tick without opening a span or leaving the process. The
 * grounds to try again are the ones `warnIndexUnconfigured` has stated in a
 * comment since it was written — nothing about a repository can make an
 * unauthenticated CLI authenticate, so a credential change is what counts.
 */
async function breakerAt(ctx: Ctx, key: string): Promise<{ stamp: number; failures: number }> {
  const [stamp, failures] = String((await readSetting(ctx.db, key)) ?? "").split(":");
  return { stamp: Number(stamp) || 0, failures: Number(failures) || 0 };
}

async function tripped(ctx: Ctx, key: string, stamp: number): Promise<boolean> {
  const at = await breakerAt(ctx, key);
  return at.stamp === stamp && at.failures >= BREAKER_TRIPS;
}

async function record(
  ctx: Ctx,
  key: string,
  stamp: number,
  ok: boolean,
  spec: { runtime?: string; model: string },
): Promise<void> {
  if (ok) {
    await writeSetting(ctx.db, key, null);
    return;
  }
  const at = await breakerAt(ctx, key);
  // A count under an older credential is a count for a state that no longer
  // exists, so it is replaced rather than added to — which also means the row
  // never accumulates one per rotation.
  const failures = (at.stamp === stamp ? at.failures : 0) + 1;
  await writeSetting(ctx.db, key, `${stamp}:${failures}`);
  // Once, on the way past the threshold. The boss was already told 43 times in
  // that window that the index would not build; what nobody was told is that the
  // asking had stopped being worth its clock.
  if (failures !== BREAKER_TRIPS) return;
  await ctx.bus.emit({
    author: "orchestrator",
    kind: "state_change",
    say: msg`the index navigator (${{ model: spec.model }}) failed ${{ n: BREAKER_TRIPS }} times in a row and is being skipped — retrieval falls back to the lexical index, and changing the model or runtime in Settings starts it again`,
    meta: { model: spec.model, runtime: spec.runtime ?? "claude" },
  });
}

/** `claude -p --output-format json`: one object, with the answer and the bill. */

/**
 * `codex exec --json`: one noisy stream, reduced once.
 *
 * Message and usage can arrive in either order. Keep the last valid record of
 * each independently; an empty final message must not erase an answer already
 * seen, and a banner or malformed line must not take retrieval down.
 */

/**
 * Charge an index call to the project's `indexer`.
 *
 * A row, not a role: `costReport` reads `agent.total_tokens` and the turn events,
 * so writing both is the whole of making this spend visible. Deliberately not
 * folded into the Librarian, whose turns carry a full cached prefix and a session
 * — one-shot calls in the same row would make "librarian took 4M" a number nobody
 * can act on.
 */
/**
 * Not a real role either. Retrieval is on the critical path of every turn, while
 * the scheduler runs one in-flight `agent_turn` per slot with every standing agent
 * sharing slot 0 — so a turn asking a question would wait for a slot it is itself
 * holding.
 *
 * Inert by construction: watchdog rule 2 needs `idle_turns >= 3` and rule 3 needs
 * a `loop_file`, and nothing here writes either.
 */
export async function chargeIndex(
  ctx: Ctx,
  projectId: number,
  spec: { runtime?: string; model: string },
  u: AskUsage,
  grpId?: number,
): Promise<void> {
  const runtime = spec.runtime ?? "claude";
  const total = u.input + u.output + u.cacheRead + u.cacheCreate;
  if (total === 0) return;
  const [row] = await ctx.db
    .select({ id: agent.id })
    .from(agent)
    .where(
      and(eq(agent.project_id, projectId), isNull(agent.grp_id), eq(agent.role, "indexer"), eq(agent.runtime, runtime)),
    );
  let id = row?.id;
  if (id === undefined) {
    const [made] = await ctx.db
      .insert(agent)
      .values({
        project_id: projectId,
        grp_id: null,
        role: "indexer",
        model: spec.model,
        runtime,
        // `state` carries a schema default of the same value and is still spelled
        // out, as the old INSERT spelled it. `created_at` uses `nowMs` so the row is
        // stamped by the database's clock, not this process's.
        state: "idle",
        created_at: nowMs,
      })
      .returning({ id: agent.id });
    id = made!.id;
  }
  await ctx.db
    .update(agent)
    .set({ total_tokens: sql`${agent.total_tokens} + ${total}`, model: spec.model })
    .where(eq(agent.id, id));
  // And onto the requirement that asked, when one did. This landed on the agent
  // row alone, so a group's budget could not see the retrieval its own turns
  // caused — `sliceBudgetTokens` is what stops a runaway, and the most frequent
  // model call in the system was invisible to it. The project-scoped calls (the
  // index rebuild) still belong to nobody, which is correct: no requirement asked.
  if (grpId)
    await ctx.db
      .update(grp)
      .set({ spent_tokens: sql`${grp.spent_tokens} + ${total}` })
      .where(eq(grp.id, grpId));
  // The same event shape `recordCost` emits, because that is what the hourly
  // burn chart reads — an event row has no agent to join back to, so the runtime
  // has to travel in the meta or the split guesses from the model name.
  await ctx.bus.emit({
    author: "indexer",
    kind: "tool_summary",
    say: msg`index call (${{ total }} tokens)`,
    // `cacheRatio` too, which the shape this imitates has always carried and
    // this one did not. Fifty index calls to a handful of turns is the ratio of
    // the sample `recentCacheRatio` reads, so the number the panel drew was an
    // average over the two rows that happened to be turns — beside a row saying
    // the indexer is the whole of the spend.
    meta: { usage: u, cacheRatio: cacheRatio(u), model: spec.model, runtime },
  });
}

/** The repo half of the corpus. */

/**
 * The blackboard half: every journal, retro, decision and fact, as leaves under
 * `notes/<scope>/<kind>/<id>`.
 *
 * Grouping by scope then kind is what makes the walk cheap — "what did that group
 * settle" is one directory, and the model never sees the other 200 notes. BM25 over
 * the whole table could only ever return whole notes and rank them by word overlap,
 * which is exactly what fails when the retro that matters calls it something else.
 */
export async function noteLeaves(db: DB, projectId: number | null): Promise<{ ids: string[]; read: Read }> {
  const rows = await db
    .select({ id: note.id, grp_id: note.grp_id, kind: note.kind, body: note.body })
    .from(note)
    .where(
      and(
        // `project_id IS ?` in the old text, so asking for the global scope has to
        // match the rows whose `project_id` is NULL. `eq()` is `=` and would match
        // none of them, which is the whole corpus when no project is in scope.
        or(projectId === null ? isNull(note.project_id) : eq(note.project_id, projectId), isNotNull(note.grp_id)),
        inArray(note.kind, ["decision", "retro", "journal", "fact", "lesson"]),
      ),
    )
    .orderBy(desc(note.id))
    .limit(500);
  const byId = new Map<string, string>();
  for (const r of rows) {
    byId.set(`${NOTE_PREFIX}${r.grp_id ? `grp-${r.grp_id}` : "project"}/${r.kind}/${r.id}`, r.body);
  }
  return { ids: [...byId.keys()], read: (id) => byId.get(id) ?? null };
}

/** Both halves, one reader. */

// ------------------------------------------------------------------ storage

export async function saveTree(db: DB, projectId: number, tree: Tree): Promise<void> {
  await saveSingletonNote(db, projectId, "pageindex", JSON.stringify(tree));
}

export async function loadTree(db: DB, projectId: number | null): Promise<Tree | null> {
  return jsonOr(await singletonNote(db, projectId, "pageindex"), TreeSchema.nullable(), null);
}
