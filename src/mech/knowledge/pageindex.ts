import { jsonOr } from "../util/text.ts";
import { saveSingletonNote, singletonNote } from "../util/rows.ts";
import type { DB } from "../../db.ts";
import type { Ctx } from "../../ctx.ts";
import { execIn, putFile, WORK, type Scope } from "../sandbox/sandbox.ts";
import { claudeUsage, promptPath, type Usage } from "../../runtime/claude.ts";
import { codexUsage } from "../../runtime/codex.ts";
import { shq } from "../util/shq.ts";

/**
 * PageIndex over this repo: a summary tree, navigated by reasoning.
 *
 * The method is VectifyAI's (github.com/VectifyAI/PageIndex): build a
 * table-of-contents tree where every node carries an LLM-written summary, then
 * retrieve by letting a model walk that tree — expand what looks relevant, ignore
 * the rest — instead of embedding chunks and taking a cosine top-k. Their
 * implementation is Python and takes PDFs page by page; the method is what
 * transfers, so this is that method over `git ls-files`.
 *
 * Why it is worth a model call per query here. Seven groups were each grepping
 * the same repository to find the same file, and a grep round is not cheap: every
 * round re-reads the whole transcript, and turns above 60 rounds ate 59% of the
 * measured cache-read bill. One haiku call that answers "it is in
 * src/mech/notify.ts, here is why" removes several of those rounds.
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
  let calls = 0;
  let failed = 0;
  const budget = opts.maxCalls ?? 40;

  const files = Object.values(tree).filter((n) => n.kind === "file");
  for (const n of files) {
    const head = read(n.id)?.slice(0, HEAD_CHARS);
    if (!head) continue;
    const sig = sigOf(head);
    const old = prev[n.id];
    if (old && old.sig === sig) {
      n.sig = sig;
      n.summary = old.summary;
      continue;
    }
    if (calls >= budget) continue; // Next tick takes the rest; a partial tree still works.
    calls++;
    const summary = oneLine(
      await ask(
        (n.id.startsWith(NOTE_PREFIX)
          ? `One line, under 20 words: what does this note establish? Name the decision or fact, not the format.\n\n`
          : `One line, under 20 words: what is ${n.id} for? Name the thing it owns, not its language.\n\n`) +
          `----\n${head}\n----`,
      ),
    );
    // The signature is written only on an answer.
    //
    // It used to be stamped before the call and kept whatever came back, `""`
    // included, so that a broken model would not be retried every thirty seconds
    // forever. That traded a retry loop for something worse: on a machine where
    // the ask could not work at all, every node got an empty summary *and* a
    // signature, the next tick matched it, and the index was permanently empty
    // while reporting itself built. Cost is bounded by `maxCalls` per tick
    // already; nothing needs a failure cached as if it were a success.
    if (!summary) {
      failed++;
      continue;
    }
    n.sig = sig;
    n.summary = summary;
  }

  // The root is never shown in a menu — search starts from its children — so a
  // summary of "the whole repo" would be a model call nobody reads.
  const dirs = Object.values(tree)
    .filter((n) => n.kind === "dir" && n.id !== "/")
    .sort((a, b) => b.id.split("/").length - a.id.split("/").length);
  for (const d of dirs) {
    const kids = d.children.map((c) => `${c}: ${tree[c]?.summary ?? ""}`).join("\n");
    const sig = sigOf(kids);
    const old = prev[d.id];
    if (old && old.sig === sig) {
      d.sig = sig;
      d.summary = old.summary;
      continue;
    }
    if (calls >= budget) continue;
    calls++;
    const summary = oneLine(
      await ask(`One line, under 20 words: what does ${d.id} hold, as a whole?\n\n${kids.slice(0, 4000)}`),
    );
    if (!summary) {
      failed++;
      continue;
    }
    d.sig = sig;
    d.summary = summary;
  }
  return { tree, calls, failed };
}

const oneLine = (s: string) => s.trim().split("\n").filter(Boolean).pop()?.slice(0, 160) ?? "";

/**
 * Retrieval: the model walks the tree.
 *
 * At each level it sees ids and summaries and answers with the ids worth opening.
 * Nothing is embedded and nothing is ranked by similarity — which is the point of
 * the method: the reason a node was opened is a sentence you can read, and a node
 * whose summary says "this is where X lives" wins even when it shares no words
 * with the question.
 */
export async function search(
  tree: Tree,
  question: string,
  ask: Ask,
  opts: { depth?: number; width?: number } = {},
): Promise<string[]> {
  const depth = opts.depth ?? 3;
  const width = opts.width ?? 4;
  let frontier = tree["/"]?.children ?? [];
  const opened: string[] = [];

  for (let level = 0; level < depth && frontier.length; level++) {
    const menu = frontier
      .map((id) => `${id} — ${tree[id]?.summary || (tree[id]?.kind === "dir" ? "(directory)" : "(file)")}`)
      .join("\n");
    const answer = await ask(
      `Question: ${question}\n\n` +
        `Which of these are worth opening to answer it? Reply with at most ${width} ids, one per line, ` +
        `nothing else. Reply NONE if none of them are relevant.\n\n${menu}`,
    );
    const picked = answer
      .split("\n")
      .map((l) => l.trim().replace(/^[-*\d.\s]+/, ""))
      .filter((l) => frontier.includes(l))
      .slice(0, width);
    // The model declining is an answer: nothing here is relevant, and handing back
    // the frontier anyway would turn "no" into a top-k guess, which is the failure
    // mode this method exists to avoid.
    if (picked.length === 0) return opened;

    const next: string[] = [];
    for (const id of picked) {
      const n = tree[id];
      if (!n) continue;
      if (n.kind === "file") opened.push(id);
      else next.push(...n.children);
    }
    frontier = next;
  }
  // Ran out of depth with directories still open: where to look is still an answer.
  if (opened.length === 0) return frontier.slice(0, width);
  return opened;
}

export function render(tree: Tree, ids: string[]): string {
  return ids.map((id) => `${id} — ${tree[id]?.summary ?? ""}`).join("\n");
}

/**
 * A real one-shot model call, cheapest tier, no tools.
 *
 * Not a role and not a turn: nothing here needs the blackboard, a session, or a
 * sandbox — it reads one file head and answers one line. Going through the turn
 * machinery would buy a session, a stable prefix and a cost row for a call that
 * costs less than the bookkeeping.
 *
 * It is also the most frequent model call in the system — one per `orch ctx
 * query` plus one per changed file when the index is rebuilt — and it is pure
 * summarisation, so which subscription pays for it is a config choice like any
 * other role's. `-s read-only` costs nothing here: this prompt never runs a
 * command, and codex's sandbox governs the commands the model asks for, not
 * codex's own API traffic.
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
  return async (prompt) => {
    const file = promptPath();
    await putFile(ctx, scope, file, prompt);
    const cmd = `${argv.map(shq).join(" ")} < ${file}; rc=$?; rm -f ${file}; exit $rc`;
    const r = await execIn(ctx, scope, cmd, { cwd: WORK, timeoutMs }).catch(() => null);
    if (!r || r.code !== 0) return "";
    const { text, usage } = codex ? readCodex(r.out) : readClaude(r.out);
    if (usage) onUsage?.(usage);
    return text;
  };
}

/** `claude -p --output-format json`: one object, with the answer and the bill. */
export function readClaude(out: string): { text: string; usage?: AskUsage } {
  try {
    const o = JSON.parse(out) as { result?: string; is_error?: boolean; usage?: Record<string, any> };
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

/** `codex exec --json`: a stream, whose `turn.completed` carries the usage. */
export function readCodex(out: string): { text: string; usage?: AskUsage } {
  let usage: AskUsage | undefined;
  for (const line of out.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const l = JSON.parse(line) as { type?: string; usage?: Record<string, any> };
      if (l.type === "turn.completed" && l.usage) {
        usage = codexUsage(l.usage);
      }
    } catch {}
  }
  return { text: lastAgentMessage(out), usage };
}

/** `codex exec --json` prints a banner and a stream; the answer is the last agent_message. */
function lastAgentMessage(out: string): string {
  let text = "";
  for (const line of out.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const l = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string } };
      if (l.type === "item.completed" && l.item?.type === "agent_message" && l.item.text) {
        text = l.item.text;
      }
    } catch {}
  }
  return text;
}

/**
 * Charge an index call to the project's `indexer`.
 *
 * A row, not a role: `costReport` reads `agent.total_tokens` and the turn events,
 * so writing both is the whole of making this spend visible — no panel change, no
 * new table. It is deliberately not folded into the Librarian, whose turns carry
 * a full cached prefix and a session; putting one-shot calls in the same row
 * would make "librarian took 4M" a number nobody can act on.
 *
 * And it is not made into a real role either. Retrieval is on the critical path
 * of every agent's turn (`assemble.ts` says ALWAYS FIRST), while the scheduler
 * runs one in-flight `agent_turn` per slot with every standing agent sharing slot
 * 0 — so a turn asking a question would wait for a slot it is itself holding.
 *
 * Inert by construction: watchdog rule 2 needs `idle_turns >= 3` and rule 3 needs
 * a `loop_file`, and nothing here writes either; the scheduler only ever looks at
 * agents a job points to.
 */
export function chargeIndex(
  ctx: Ctx,
  projectId: number,
  spec: { runtime?: string; model: string },
  u: AskUsage,
): void {
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
  return jsonOr<Tree | null>(singletonNote(db, projectId, "pageindex"), null);
}
