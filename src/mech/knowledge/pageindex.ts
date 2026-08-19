import { jsonOr } from "../../contracts/json.ts";
import { saveSingletonNote, singletonNote } from "../util/rows.ts";
import type { DB } from "../../platform/persistence/database.ts";
import type { Ctx } from "../../mech/ctx.ts";
import type { Config } from "../../platform/config/load.ts";
import { execIn, putFile, WORK, type Scope } from "../sandbox/sandbox.ts";
import { claudeUsage, promptPath, UsageSchema, type Usage } from "../../runtime/claude.ts";
import { codexUsage } from "../../runtime/codex.ts";
import { shq } from "../../platform/process/shell.ts";
import { SpanStatusCode } from "@opentelemetry/api";
import { activeTracer } from "../../platform/observability/traces.ts";
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

/** How much of a file the signature and the summary are computed from. */
export const HEAD_CHARS = 1800;

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
  opts: { maxCalls?: number; previous?: Tree } = {},
): Promise<{ tree: Tree; calls: number; failed: number }> {
  const prev = opts.previous ?? {};
  const state = { calls: 0, failed: 0, budget: opts.maxCalls ?? 40 };

  const files = Object.values(tree).filter((n) => n.kind === "file");
  for (const node of files) {
    const head = read(node.id)?.slice(0, HEAD_CHARS);
    if (!head) continue;
    await summariseNode(node, head, filePrompt(node.id, head), prev, ask, state);
  }

  const dirs = Object.values(tree)
    .filter((n) => n.kind === "dir" && n.id !== "/")
    .sort((a, b) => b.id.split("/").length - a.id.split("/").length);
  for (const node of dirs) {
    const children = node.children.map((id) => `${id}: ${tree[id]?.summary ?? ""}`).join("\n");
    await summariseNode(
      node,
      children,
      `One line in English, under 20 words: what does ${node.id} hold, as a whole?\n\n${children.slice(0, 4000)}`,
      prev,
      ask,
      state,
    );
  }
  return { tree, calls: state.calls, failed: state.failed };
}

function filePrompt(id: string, head: string): string {
  const instruction = id.startsWith(NOTE_PREFIX)
    ? "One line in English, under 20 words: what does this note establish? Name the decision or fact, not the format."
    : `One line in English, under 20 words: what is ${id} for? Name the thing it owns, not its language.`;
  return `${instruction}\n\n----\n${head}\n----`;
}

async function summariseNode(
  node: Node,
  content: string,
  prompt: string,
  previous: Tree,
  ask: Ask,
  state: { calls: number; failed: number; budget: number },
): Promise<void> {
  const sig = sigOf(content);
  const old = previous[node.id];
  if (old?.sig === sig) {
    node.sig = sig;
    node.summary = old.summary;
    return;
  }
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
  const codex = spec.runtime === "codex";
  // Both take the prompt on stdin, redirected from a file: the exec API has no
  // stdin, and this is the same route a turn's prompt takes. No `--max-turns 1`
  // on the claude side: measured, it makes `claude -p` exit 0 with the body
  // "Error: Reached max turns (1)", so every summary in the index became that
  // sentence and nothing noticed because the exit code said fine.
  //
  // No `--ignore-user-config` needed any more either. It was there because this
  // ran on the host with the boss's own `~/.claude` and `~/.codex` in scope;
  // inside the container HOME is `/root` and holds only what we put there.
  const argv = codex
    ? ["codex", "exec", "--json", "--skip-git-repo-check", "-s", "read-only", "-m", spec.model]
    : // `--output-format json` so the call reports what it spent. Plain text says
      // nothing, and this was the reason the index was invisible in every cost
      // total while being the most frequent model call there is.
      ["claude", "-p", "--output-format", "json", "--model", spec.model];
  return async (prompt) =>
    // The same sentence the `onUsage` comment above makes, about the other half
    // of the bill: this is the most frequent model call in the system and it
    // appeared in no report. `onUsage` fixed the money; this fixes the clock.
    // Up to twelve of these per project on every heartbeat, each a full model
    // round trip inside a container, and the panel had no row for any of them.
    activeTracer().startActiveSpan("index.ask", { attributes: { "model.name": spec.model } }, async (span) => {
      try {
        const file = promptPath();
        await putFile(ctx, scope, file, prompt);
        const cmd = `${argv.map(shq).join(" ")} < ${file}; rc=$?; rm -f ${file}; exit $rc`;
        const r = await execIn(ctx, scope, cmd, { cwd: WORK, timeoutMs }).catch(() => null);
        if (!r || r.code !== 0) {
          // The empty string is both a legitimate answer and the failure value,
          // and `summarise` counts it as `failed` without being able to tell
          // which. The span can tell, so it says.
          span.setStatus({ code: SpanStatusCode.ERROR, message: r ? `exit ${r.code}` : "exec threw" });
          return "";
        }
        const { text, usage } = codex ? readCodex(r.out) : readClaude(r.out);
        if (usage) onUsage?.(usage);
        return text;
      } finally {
        span.end();
      }
    });
}

/** `claude -p --output-format json`: one object, with the answer and the bill. */
export function readClaude(out: string): { text: string; usage?: AskUsage } {
  try {
    const parsed = ClaudeReply.safeParse(JSON.parse(out));
    if (!parsed.success) return { text: "" };
    const o = parsed.data;
    if (o.is_error) return { text: "" };
    return {
      text: typeof o.result === "string" ? o.result : "",
      usage: claudeUsage(o.usage),
    };
  } catch {
    // Not JSON: the CLI reports some of its own failures as plain text on stdout
    // with exit 0, so the exit code is not the check and neither is the parse.
    return { text: /^\s*Error:/.test(out) ? "" : out };
  }
}

/**
 * `codex exec --json`: one noisy stream, reduced once.
 *
 * Message and usage can arrive in either order. Keep the last valid record of
 * each independently; an empty final message must not erase an answer already
 * seen, and a banner or malformed line must not take retrieval down.
 */
export function readCodex(out: string): { text: string; usage?: AskUsage } {
  let text = "";
  let usage: AskUsage | undefined;
  for (const line of out.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const parsed = CodexReply.safeParse(JSON.parse(line));
      if (!parsed.success) continue;
      const l = parsed.data;
      if (
        l.type === "item.completed" &&
        l.item?.type === "agent_message" &&
        typeof l.item.text === "string" &&
        l.item.text.trim()
      ) {
        text = l.item.text;
      }
      if (l.type === "turn.completed" && l.usage && typeof l.usage === "object" && !Array.isArray(l.usage)) {
        usage = codexUsage(l.usage);
      }
    } catch {}
  }
  return { text, ...(usage ? { usage } : {}) };
}

const ClaudeReply = z.looseObject({
  result: z.string().optional(),
  is_error: z.boolean().optional(),
  usage: UsageSchema.optional(),
});
const CodexReply = z.looseObject({
  type: z.string().optional(),
  item: z.object({ type: z.string().optional(), text: z.string().optional() }).optional(),
  usage: z.record(z.string(), z.number()).optional(),
});

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
export function chargeIndex(ctx: Ctx, projectId: number, spec: { runtime?: string; model: string }, u: AskUsage): void {
  const runtime = spec.runtime ?? "claude";
  const total = u.input + u.output + u.cacheRead + u.cacheCreate;
  if (total === 0) return;
  const row = ctx.db
    .query<{ id: number }, [number, string]>(
      "SELECT id FROM agent WHERE project_id = ? AND grp_id IS NULL AND role = 'indexer' AND runtime = ?",
    )
    .get(projectId, runtime);
  const id =
    row?.id ??
    ctx.db
      .query<{ id: number }, [number, string, string]>(
        `INSERT INTO agent (project_id, grp_id, role, model, runtime, state, created_at)
         VALUES (?, NULL, 'indexer', ?, ?, 'idle', unixepoch() * 1000) RETURNING id`,
      )
      .get(projectId, spec.model, runtime)!.id;
  ctx.db.run("UPDATE agent SET total_tokens = total_tokens + ?, model = ? WHERE id = ?", [total, spec.model, id]);
  // The same event shape `recordCost` emits, because that is what the hourly
  // burn chart reads — an event row has no agent to join back to, so the runtime
  // has to travel in the meta or the split guesses from the model name.
  ctx.bus.emit({
    author: "indexer",
    kind: "tool_summary",
    body: `index call (${total} tokens)`,
    meta: { usage: u, model: spec.model, runtime },
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
export function noteLeaves(db: DB, projectId: number | null): { ids: string[]; read: Read } {
  const rows = db
    .query<{ id: number; grp_id: number | null; kind: string; body: string }, [number | null]>(
      `SELECT id, grp_id, kind, body FROM note
       WHERE (project_id IS ? OR grp_id IS NOT NULL) AND kind IN ('decision','retro','journal','fact','lesson')
       ORDER BY id DESC LIMIT 500`,
    )
    .all(projectId);
  const byId = new Map<string, string>();
  for (const r of rows) {
    byId.set(`${NOTE_PREFIX}${r.grp_id ? `grp-${r.grp_id}` : "project"}/${r.kind}/${r.id}`, r.body);
  }
  return { ids: [...byId.keys()], read: (id) => byId.get(id) ?? null };
}

/** Both halves, one reader. */

// ------------------------------------------------------------------ storage

export function saveTree(db: DB, projectId: number, tree: Tree): void {
  saveSingletonNote(db, projectId, "pageindex", JSON.stringify(tree));
}

export function loadTree(db: DB, projectId: number | null): Tree | null {
  return jsonOr(singletonNote(db, projectId, "pageindex"), TreeSchema.nullable(), null);
}
