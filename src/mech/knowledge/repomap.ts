import { z } from "zod";
import { jsonOr } from "../../contracts/json.ts";
import { projectConfig, saveSingletonNote, singletonNote } from "../util/rows.ts";
import type { DB } from "../../platform/persistence/database.ts";
import { symbolsIn } from "./symbols.ts";
import { terms } from "./terms.ts";

/**
 * One index of the repo, shared by every group.
 *
 * Seven groups were each grepping the same repository for the same answer, and
 * every one of those rounds re-reads the whole transcript, which is where the
 * token bill is. The map is built once per project, kept in a note, and handed out
 * by `orch ctx query`.
 */
/**
 * PageIndex-shaped: a tree with a path at every node, navigated by the question
 * rather than embedded and cosine-matched. Not a preference — the nodes are file
 * paths and exported names, exactly the words a question already contains, so
 * lexical navigation hits and an embedding would add an API call and an index.
 *
 * ponytail: node summaries are exported names, not prose. A sentence per file costs
 * a model pass; do that when a question needs "what does this do".
 */

/** How many names a single file contributes to the map. */
const MAX_SYMBOLS = 12;

/**
 * What belongs in an index of a repository — by exclusion, not by allow-list.
 *
 * An allow-list of source extensions cannot be finished (documentation alone is
 * md, txt, mdx, rmd, rst, adoc) while the set of things that are *not* text a
 * model can summarise is stable and language-independent. `git ls-files` has
 * already dropped build output and everything gitignored, so what is left to
 * remove is binaries, lockfiles and vendored trees.
 */
/**
 * Both indexes used to carry their own list, and both were wrong in the same
 * direction: point either at a Go, Python or Rust project and the source was
 * simply invisible. Whatever this still gets wrong is correctable per project
 * rather than guessed at again — `project.config_json.index.exclude`, the same
 * arrangement `detect.ts` uses for gates.
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

export function indexable(rel: string, exclude: string[] = []): boolean {
  if (!rel || BINARY.test(rel)) return false;
  if (GENERATED.some((re) => re.test(rel))) return false;
  // `Bun.Glob`, for the reason ownership.ts already gives: the hand-written
  // glob-to-regex this replaces compiled `**` to `.*` between two literal
  // slashes, so `**/*.ts` needed a directory to exist and did not match `a.ts`,
  // and `docs/**/*.md` skipped every file directly in `docs/`. Both are the
  // shape a boss writes, and both failed open — the file the exclude named got
  // indexed anyway, and nothing said so.
  return !exclude.some((g) => new Bun.Glob(g).match(rel));
}

/**
 * Per-project excludes for the index, on top of the built-in ones.
 *
 * Whatever `indexable` still gets wrong is the boss's to correct rather than
 * ours to keep guessing at — the same arrangement `detect.ts` uses for gates:
 * best-effort detection, written where it can be edited.
 */
export async function indexExcludes(db: DB, projectId: number): Promise<string[]> {
  return (await projectConfig(db, projectId)).index?.exclude ?? [];
}

export interface MapNode {
  dir: string;
  files: { name: string; symbols: string[] }[];
}

/**
 * The stored shape, which is not the rendered one.
 *
 * The map used to be persisted as the text a prompt sees and parsed back by
 * splitting on `" — "` and `", "` — so a file named `a — b.ts`, or a symbol with
 * a comma in it, came back as a different file with different symbols, silently.
 * The render is for reading; storage is JSON, which is what `saveTree` next door
 * has always done for the same kind of value.
 */
const MapNodeSchema = z.object({
  dir: z.string(),
  files: z.array(z.object({ name: z.string(), symbols: z.array(z.string()) })),
});

/**
 * Tracked files only: build output and node_modules are noise, and git knows.
 *
 * `read` is a parameter because there is no answer this module can work out for
 * itself. It used to be `readFileSync(join(repoPath, rel))` — and since ADR 007
 * made `repo_path` an `owner/name` rather than a directory, that path has not
 * existed on this machine. Every read threw, every throw was caught, and the map
 * has been **paths with no symbols** ever since, while still rendering as a map.
 */
/**
 * Async because parsing is: a tree-sitter grammar is a WebAssembly module and
 * there is no synchronous way to instantiate one. The cost is one-time and
 * per-process — 6ms for the runtime, then 0.6ms (Go) to 3.6ms (TypeScript) per
 * grammar, cached in `symbols.ts` — so a rebuild pays it on the first tick rather
 * than once per file.
 */
export async function buildMap(
  repoPath: string,
  list: (repo: string) => string[],
  exclude: string[] = [],
  read?: (rel: string) => string | undefined,
): Promise<MapNode[]> {
  const byDir = new Map<string, MapNode>();
  for (const rel of list(repoPath)) {
    // Symbols are still opportunistic — a language with no grammar gets a path
    // and no names, which is a useful map entry, because "where does X live" is
    // answered by the path. What changed is which languages those are: Go,
    // Python and Rust have left that set.
    if (!indexable(rel, exclude)) continue;
    const cut = rel.lastIndexOf("/");
    const dir = cut < 0 ? "." : rel.slice(0, cut);
    const name = cut < 0 ? rel : rel.slice(cut + 1);
    const src = read?.(rel);
    const symbols = src ? await symbolsIn(rel, src, MAX_SYMBOLS) : [];
    if (!byDir.has(dir)) byDir.set(dir, { dir, files: [] });
    byDir.get(dir)!.files.push({ name, symbols });
  }
  return [...byDir.values()].sort((a, b) => a.dir.localeCompare(b.dir));
}

function renderMap(nodes: MapNode[]): string {
  return nodes
    .map(
      (n) =>
        `${n.dir}/\n` +
        n.files.map((f) => `  ${f.name}${f.symbols.length ? ` — ${f.symbols.join(", ")}` : ""}`).join("\n"),
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
  // The tokenizer the note index uses, not a second one. Its own regex made stop
  // words into query terms — and scoring is substring containment, so `the`
  // matched `theme.ts` — while dropping everything shorter than three characters,
  // which is `db`, `mw`, `ui` and `id`. ICU also splits a path into components, so
  // the leading-`./` trim it used to need is gone.
  const words = terms(question);
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
export async function saveMap(db: DB, projectId: number, nodes: MapNode[]): Promise<boolean> {
  return saveSingletonNote(db, projectId, "map", JSON.stringify(nodes));
}

/**
 * A map written by an older build is text, not JSON, and reads back as no map at
 * all rather than as a corrupt one — the rule refreshes it on the next tick.
 */
export async function loadMap(db: DB, projectId: number | null): Promise<MapNode[]> {
  if (!projectId) return [];
  return jsonOr(await singletonNote(db, projectId, "map"), z.array(MapNodeSchema), []);
}
