import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DB } from "../db.ts";

/**
 * One index of the repo, shared by every group.
 *
 * Seven groups were each grepping the same repository to answer the same
 * question — where does X live — and every one of those rounds re-reads the whole
 * transcript, which is where the token bill actually is. The map is built once per
 * project, kept in a note, and handed out by `orch ctx query`.
 *
 * PageIndex-shaped: a tree with a path at every node, navigated by the question
 * rather than embedded and cosine-matched. That choice is not a preference — the
 * nodes here are file paths and exported names, which are exactly the words an
 * agent's question already contains, so lexical navigation hits and an embedding
 * would only add an API call and an index to keep fresh.
 *
 * ponytail: node summaries are the file's exported names, not prose. A sentence
 * per file would be better and costs a model pass over the repo; do that when a
 * question turns out to need "what does this do" rather than "where is this".
 */

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|c|h|cc|cpp|cs)$/;
const EXPORTED = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|const|class|type|interface|enum)\s+(\w+)/gm;

export interface MapNode {
  dir: string;
  files: { name: string; symbols: string[] }[];
}

/** Tracked files only: build output and node_modules are noise, and git already knows. */
export function buildMap(repoPath: string, list: (repo: string) => string[]): MapNode[] {
  const byDir = new Map<string, MapNode>();
  for (const rel of list(repoPath)) {
    if (!CODE.test(rel)) continue;
    const cut = rel.lastIndexOf("/");
    const dir = cut < 0 ? "." : rel.slice(0, cut);
    const name = cut < 0 ? rel : rel.slice(cut + 1);
    let symbols: string[] = [];
    try {
      const src = readFileSync(join(repoPath, rel), "utf8");
      symbols = [...src.matchAll(EXPORTED)].map((m) => m[1]!).slice(0, 12);
    } catch {
      // A file git knows about and the disk does not is not worth failing over.
    }
    if (!byDir.has(dir)) byDir.set(dir, { dir, files: [] });
    byDir.get(dir)!.files.push({ name, symbols });
  }
  return [...byDir.values()].sort((a, b) => a.dir.localeCompare(b.dir));
}

export function renderMap(nodes: MapNode[]): string {
  return nodes
    .map(
      (n) =>
        `${n.dir}/\n` +
        n.files
          .map((f) => `  ${f.name}${f.symbols.length ? ` — ${f.symbols.join(", ")}` : ""}`)
          .join("\n"),
    )
    .join("\n");
}

/**
 * The part of the map a question is about.
 *
 * Whole-map injection is the thing to avoid: it is a few thousand tokens on every
 * turn of every agent, most of it irrelevant, and it would sit in the delta where
 * it is paid for fresh each time. Matching on the question's own words keeps it to
 * the directories that were asked about.
 */
export function mapFor(nodes: MapNode[], question: string, maxChars: number): string {
  const words = (question.toLowerCase().match(/[a-z0-9_./-]{3,}/g) ?? []).map((w) => w.replace(/^\.*\/*/, ""));
  if (words.length === 0) return "";
  const score = (n: MapNode) => {
    const hay = `${n.dir} ${n.files.map((f) => `${f.name} ${f.symbols.join(" ")}`).join(" ")}`.toLowerCase();
    return words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0);
  };
  const hits = nodes
    .map((n) => ({ n, s: score(n) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 4)
    .map((x) => x.n);
  if (hits.length === 0) return "";
  const text = renderMap(hits);
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (truncated)` : text;
}

/** Store the map as a project note, and only when it actually changed. */
export function saveMap(db: DB, projectId: number, rendered: string): boolean {
  const prev = db
    .query<{ id: number; body: string }, [number]>(
      "SELECT id, body FROM note WHERE project_id = ? AND kind = 'map' ORDER BY id DESC LIMIT 1",
    )
    .get(projectId);
  if (prev?.body === rendered) return false;
  if (prev) db.run("DELETE FROM note WHERE id = ?", [prev.id]);
  db.run("INSERT INTO note (project_id, kind, body, at) VALUES (?, 'map', ?, unixepoch() * 1000)", [
    projectId,
    rendered,
  ]);
  return true;
}

export function loadMap(db: DB, projectId: number | null): MapNode[] {
  if (!projectId) return [];
  const row = db
    .query<{ body: string }, [number]>(
      "SELECT body FROM note WHERE project_id = ? AND kind = 'map' ORDER BY id DESC LIMIT 1",
    )
    .get(projectId);
  if (!row) return [];
  const nodes: MapNode[] = [];
  for (const line of row.body.split("\n")) {
    if (line.endsWith("/")) nodes.push({ dir: line.slice(0, -1), files: [] });
    else if (nodes.length) {
      const [name, syms] = line.trim().split(" — ");
      nodes[nodes.length - 1]!.files.push({ name: name!, symbols: syms ? syms.split(", ") : [] });
    }
  }
  return nodes;
}
