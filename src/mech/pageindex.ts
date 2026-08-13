import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DB } from "../db.ts";

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

const HEAD_CHARS = 1800;

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
): Promise<{ tree: Tree; calls: number }> {
  const prev = opts.previous ?? {};
  let calls = 0;
  const budget = opts.maxCalls ?? 40;

  const files = Object.values(tree).filter((n) => n.kind === "file");
  for (const n of files) {
    const head = read(n.id)?.slice(0, HEAD_CHARS);
    if (!head) continue;
    n.sig = sigOf(head);
    const old = prev[n.id];
    if (old && old.sig === n.sig && old.summary) {
      n.summary = old.summary;
      continue;
    }
    if (calls >= budget) continue; // Next tick takes the rest; a partial tree still works.
    calls++;
    n.summary = oneLine(
      await ask(
        (n.id.startsWith(NOTE_PREFIX)
          ? `One line, under 20 words: what does this note establish? Name the decision or fact, not the format.\n\n`
          : `One line, under 20 words: what is ${n.id} for? Name the thing it owns, not its language.\n\n`) +
          `----\n${head}\n----`,
      ),
    );
  }

  // The root is never shown in a menu — search starts from its children — so a
  // summary of "the whole repo" would be a model call nobody reads.
  const dirs = Object.values(tree)
    .filter((n) => n.kind === "dir" && n.id !== "/")
    .sort((a, b) => b.id.split("/").length - a.id.split("/").length);
  for (const d of dirs) {
    const kids = d.children.map((c) => `${c}: ${tree[c]?.summary ?? ""}`).join("\n");
    d.sig = sigOf(kids);
    const old = prev[d.id];
    if (old && old.sig === d.sig && old.summary) {
      d.summary = old.summary;
      continue;
    }
    if (calls >= budget) continue;
    calls++;
    d.summary = oneLine(
      await ask(`One line, under 20 words: what does ${d.id} hold, as a whole?\n\n${kids.slice(0, 4000)}`),
    );
  }
  return { tree, calls };
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
 */
export function modelAsk(model: string, cwd: string, timeoutMs = 60_000): Ask {
  return async (prompt) => {
    const p = Bun.spawn(["claude", "-p", prompt, "--model", model, "--max-turns", "1"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    try {
      const out = await new Response(p.stdout).text();
      return (await p.exited) === 0 ? out : "";
    } finally {
      clearTimeout(timer);
    }
  };
}

/** The repo half of the corpus. */
export function fileRead(repoPath: string): Read {
  return (id) => {
    if (id.startsWith(NOTE_PREFIX)) return null;
    try {
      return readFileSync(join(repoPath, id), "utf8");
    } catch {
      return null;
    }
  };
}

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
export function bothRead(repoPath: string, notes: Read): Read {
  const files = fileRead(repoPath);
  return (id) => (id.startsWith(NOTE_PREFIX) ? notes(id) : files(id));
}

// ------------------------------------------------------------------ storage

export function saveTree(db: DB, projectId: number, tree: Tree): void {
  const body = JSON.stringify(tree);
  const prev = db
    .query<{ id: number; body: string }, [number]>(
      "SELECT id, body FROM note WHERE project_id = ? AND kind = 'pageindex' ORDER BY id DESC LIMIT 1",
    )
    .get(projectId);
  if (prev?.body === body) return;
  if (prev) db.run("DELETE FROM note WHERE id = ?", [prev.id]);
  db.run("INSERT INTO note (project_id, kind, body, at) VALUES (?, 'pageindex', ?, unixepoch() * 1000)", [
    projectId,
    body,
  ]);
}

export function loadTree(db: DB, projectId: number | null): Tree | null {
  if (!projectId) return null;
  const row = db
    .query<{ body: string }, [number]>(
      "SELECT body FROM note WHERE project_id = ? AND kind = 'pageindex' ORDER BY id DESC LIMIT 1",
    )
    .get(projectId);
  if (!row) return null;
  try {
    return JSON.parse(row.body) as Tree;
  } catch {
    return null;
  }
}
