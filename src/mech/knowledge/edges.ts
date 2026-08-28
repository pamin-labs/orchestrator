import { z } from "zod";
import { importsIn } from "./symbols.ts";
import { jsonOr } from "../../contracts/json.ts";
import { saveSingletonNote, singletonNote } from "../util/rows.ts";
import type { DB } from "../../platform/persistence/database.ts";

/**
 * Which directory imports which, as the repository has been so far.
 *
 * The architecture rule this repository enforces on itself — invariants 1–6, and
 * `fallow` — has no equivalent for the projects orchestrator drives. Authoring
 * one per project needs somebody to write it, a channel to propose it and a tier
 * to approve it.
 */
/** The edges are derivable, so the cheaper question is whether a slice introduces
 *  a dependency **the repository has never had**, which needs no configuration at
 *  all. Same shape as the Chinese-literal ratchet this repository already trusts:
 *  not "is this right", but "is this new". */
/** Directory granularity, two segments deep, because that is the altitude an
 *  architecture rule is written at — `src/mech` may not import `web/src`. Per
 *  file would flag every ordinary refactor; per top-level directory would miss
 *  everything inside `src/`. */
/**
 * Where a language keeps its code. Not a language table — the same four cover
 * Java's `src/main/java`, Ruby's `app` and `lib`, and everything that puts its
 * modules at the root.
 */
const SOURCE_ROOTS = ["", "src", "src/main/java", "app", "lib"];

export function areaOf(path: string): string {
  // The file's directory, capped at two segments. Always a file path in, which
  // is why the callers that hold a directory append a name to it.
  const dir = withoutBuildRoot(
    path
      .split("/")
      .filter((p) => p && p !== ".")
      .slice(0, -1),
  );
  // A file at the root belongs to no area: `README.md` is not a module.
  return dir.length === 0 ? "." : dir.slice(0, 2).join("/");
}

/**
 * An area is measured from where the code starts, not from where the build tool
 * puts it.
 *
 * Only roots of more than one segment: `src/main/java` is Maven's ceremony and
 * without stripping it every Java package in a repository shares one area, while
 * a bare `src` is already the top of a tree and stripping that would rename every
 * area this repository has.
 */
function withoutBuildRoot(parts: string[]): string[] {
  for (const root of SOURCE_ROOTS) {
    const segments = root.split("/").filter(Boolean);
    if (segments.length > 1 && segments.every((segment, i) => parts[i] === segment)) return parts.slice(segments.length);
  }
  return parts;
}

/** `from|to`, the pair as it is stored and compared. */
export const edge = (from: string, to: string) => `${from}|${to}`;

/**
 * Where an import string points, as a directory in this repository, or null for
 * anything that is not one.
 *
 * Three spellings, in the order they are cheap: a relative path from the
 * importing file, a dotted or `::`-separated module read as a path from the root,
 * and the same from `src/`. Anything that resolves to no known directory is
 * somebody else's package, and an unresolvable import is **ignored** rather than
 * guessed at — this decides whether work is blocked.
 */
export function areaOfImport(from: string, target: string, dirs: ReadonlySet<string>): string | null {
  const here = areaOf(from);
  // A relative import is a path, so its directory is the longest known prefix —
  // the last segment is a file, and a deeper file still lands in an area.
  if (target.startsWith(".")) {
    const found = longestKnown(resolve(from, target), dirs);
    const dir = found === null ? null : areaOf(`${found}/x`);
    return dir && dir !== here ? dir : null;
  }
  // A module name is not a path, so it has to match a directory outright. A
  // prefix walk here answered `src` for `zod`, on the strength of `src` existing:
  // every third-party package in the repository would have been an edge.
  //
  // `crate::` is Rust for this crate's root, which on disk is `src/`.
  const path = asPath(target);
  for (const root of SOURCE_ROOTS) {
    const found = under(root ? `${root}/${path}` : path, path, dirs);
    if (found && areaOf(`${found}/x`) !== here) return areaOf(`${found}/x`);
  }
  return null;
}

/**
 * A module name as a path. Eleven grammars spell the separator four ways —
 * `a.b.c` (Java, C#, Python), `a::b::c` (Rust), `A\B\C` (PHP), `a/b/c` (Ruby,
 * C++, Go) — and the last of those is already a path, so splitting its dots would
 * turn `core/gate.h` into `core/gate/h`.
 */
function asPath(target: string): string {
  const cleaned = target.replace(/^crate::/, "").replace(/\\/g, "/");
  if (cleaned.includes("/")) return cleaned.replace(/\.[A-Za-z0-9]+$/, "");
  return cleaned.replace(/::|\./g, "/");
}

/**
 * The candidate as a directory, or the directory holding it.
 *
 * The second half is what makes `com.example.core.Gate` resolve: the last segment
 * is a class, not a folder. It is allowed only when the path is at least two
 * segments deep, which is the guarantee that kept `zod` from matching `src` on
 * the strength of `src` existing — every third-party package would have been an
 * edge.
 */
function under(candidate: string, path: string, dirs: ReadonlySet<string>): string | null {
  if (dirs.has(candidate)) return candidate;
  if (path.split("/").filter(Boolean).length < 2) return null;
  const parent = candidate.split("/").slice(0, -1).join("/");
  return parent && dirs.has(parent) ? parent : null;
}

function longestKnown(candidate: string, dirs: ReadonlySet<string>): string | null {
  const parts = candidate.split("/").filter((p) => p && p !== ".");
  for (let take = Math.min(parts.length, 3); take > 0; take--) {
    const dir = parts.slice(0, take).join("/");
    if (dirs.has(dir)) return dir;
  }
  return null;
}

/** `../gate.ts` from `src/mech/flow/review.ts`, without a filesystem. */
function resolve(from: string, target: string): string {
  const out = from.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/** Every edge in one file, for the directories this repository has. */
export async function edgesIn(rel: string, src: string, dirs: ReadonlySet<string>): Promise<string[]> {
  const from = areaOf(rel);
  const out = new Set<string>();
  for (const target of await importsIn(rel, src)) {
    const to = areaOfImport(rel, target, dirs);
    if (to) out.add(edge(from, to));
  }
  return [...out];
}

/**
 * The edges, and which areas were actually read to find them.
 *
 * The second half is not bookkeeping. The baseline is built from the files the
 * indexer read, which is a budget rather than the whole repository — so an area
 * nobody read has no edges *recorded*, which is not the same as having none. A
 * check that cannot tell those apart reports every import out of an unread area
 * as new, and evidence that is mostly noise is evidence nobody reads.
 */
const Baseline = z.object({ edges: z.array(z.string()), areas: z.array(z.string()) });
export type Baseline = z.infer<typeof Baseline>;

export async function saveEdges(db: DB, projectId: number, edges: string[], areas: string[]): Promise<boolean> {
  const value: Baseline = { edges: [...new Set(edges)].sort(), areas: [...new Set(areas)].sort() };
  return saveSingletonNote(db, projectId, "edges", JSON.stringify(value));
}

export async function loadEdges(db: DB, projectId: number | null): Promise<Baseline> {
  if (!projectId) return { edges: [], areas: [] };
  return jsonOr(await singletonNote(db, projectId, "edges"), Baseline, { edges: [], areas: [] });
}
