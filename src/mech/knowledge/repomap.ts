import type { DB } from "../../db.ts";

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

const EXPORTED = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|const|class|type|interface|enum)\s+(\w+)/gm;

/**
 * What belongs in an index of a repository — by exclusion, not by allow-list.
 *
 * Both indexes used to carry their own extension allow-list. This one named
 * eighteen languages while `EXPORTED` above parses JS/TS syntax only, so a Go
 * file entered the map and never got a symbol; PageIndex's named seven and, on
 * this repo, its whole effect was to exclude eight files (a lockfile and seven
 * things an agent would reasonably ask about). Point either at a Go, Python or
 * Rust project and the source is simply invisible.
 *
 * An allow-list of source extensions cannot be finished — documentation alone is
 * md, txt, mdx, rmd, rst, adoc — while the set of things that are *not* text a
 * model can summarise is stable and language-independent. `git ls-files` has
 * already excluded build output and everything gitignored, so what is left to
 * remove is binaries, lockfiles and vendored trees.
 *
 * Whatever this still gets wrong is correctable per project rather than guessed
 * at again: `project.config_json.index.exclude`, the same arrangement
 * `detect.ts` uses for gates.
 */
const BINARY =
  /\.(png|jpe?g|gif|bmp|ico|webp|avif|svgz|tiff?|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|so|dylib|dll|exe|bin|o|a|wasm|woff2?|ttf|otf|eot|mp[34]|m4a|wav|ogg|mov|mp4|avi|mkv|db|sqlite3?|pyc|pack|idx)$/i;

const GENERATED = [
  /(^|\/)vendor\//,
  /(^|\/)third_party\//,
  /(^|\/)node_modules\//,
  /(^|\/)\.min\./,
  /\.min\.(js|css)$/,
  /\.map$/,
  /(^|\/)[^/]*lock(file)?$/i,
  /(-|\.)lock\.(json|ya?ml|toml)$/i,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|go\.sum|composer\.lock|Gemfile\.lock)$/,
];

/** Very small glob: `*` within a segment, `**` across them. Enough for excludes. */
function globToRe(glob: string): RegExp {
  const src = glob
    .split("**")
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "."))
    .join(".*");
  return new RegExp(`^${src}$`);
}

export function indexable(rel: string, exclude: string[] = []): boolean {
  if (!rel || BINARY.test(rel)) return false;
  if (GENERATED.some((re) => re.test(rel))) return false;
  return !exclude.some((g) => globToRe(g).test(rel));
}

/**
 * Per-project excludes for the index, on top of the built-in ones.
 *
 * Whatever `indexable` still gets wrong is the boss's to correct rather than
 * ours to keep guessing at — the same arrangement `detect.ts` uses for gates:
 * best-effort detection, written where it can be edited.
 */
export function indexExcludes(db: DB, projectId: number): string[] {
  const row = db
    .query<{ config_json: string | null }, [number]>("SELECT config_json FROM project WHERE id = ?")
    .get(projectId);
  try {
    const globs = JSON.parse(row?.config_json ?? "{}")?.index?.exclude;
    return Array.isArray(globs) ? globs.filter((g: unknown) => typeof g === "string") : [];
  } catch {
    return [];
  }
}

export interface MapNode {
  dir: string;
  files: { name: string; symbols: string[] }[];
}

/**
 * Tracked files only: build output and node_modules are noise, and git already knows.
 *
 * `read` is how the file's text arrives, and it is a parameter because there is
 * no answer this module can work out for itself. It used to be
 * `readFileSync(join(repoPath, rel))` — and since 007 made `repo_path` an
 * `owner/name` rather than a directory, that path has not existed on this
 * machine. Every read threw, every throw was caught, and the map has been
 * **paths with no symbols** ever since, while still rendering as a map and still
 * being written only when it "changed". A caller now has to say where the text
 * comes from, and one that has none says so by passing nothing.
 */
export function buildMap(
  repoPath: string,
  list: (repo: string) => string[],
  exclude: string[] = [],
  read?: (rel: string) => string | undefined,
): MapNode[] {
  const byDir = new Map<string, MapNode>();
  for (const rel of list(repoPath)) {
    // Symbols are opportunistic: `EXPORTED` is JS/TS syntax, so a Go file gets a
    // path and no names. That is still a useful map entry — "where does X live"
    // is answered by the path — and it is strictly better than the old
    // allow-list, which claimed thirteen more languages than it could parse.
    if (!indexable(rel, exclude)) continue;
    const cut = rel.lastIndexOf("/");
    const dir = cut < 0 ? "." : rel.slice(0, cut);
    const name = cut < 0 ? rel : rel.slice(cut + 1);
    const src = read?.(rel);
    const symbols = src ? [...src.matchAll(EXPORTED)].map((m) => m[1]!).slice(0, 12) : [];
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
