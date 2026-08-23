import { areaOf, areaOfImport, edge, type Baseline } from "../knowledge/edges.ts";
import { importsIn } from "../knowledge/symbols.ts";

/**
 * Which dependencies this slice introduced that the repository has never had.
 *
 * Not "is this edge right" — nobody wrote down what right is, and asking a
 * project to author its architecture before orchestrator will work on it is the
 * proposal channel and approval tier this round already decided against. "Is this
 * new" needs no configuration: the repository's own history is the statement, the
 * same way the Chinese-literal ratchet works here.
 */
/** Evidence, not a verdict, and three reasons why. The baseline is built from the
 *  files an indexing budget read, so an area it never reached has no edges
 *  *recorded* rather than none. A language with no grammar in this binary
 *  contributes nothing. And a new edge is often simply correct — the point is
 *  that somebody sees it, not that work stops. */
export interface NewEdges {
  /** `from → to`, as a person reads them. */
  edges: string[];
}

export interface BoundaryScan {
  baseline: Baseline;
  /** The directories this repository has, from the stored map. */
  dirs: ReadonlySet<string>;
  /** The changed files, with their contents as of this slice. */
  files: { rel: string; src: string }[];
}

export async function newEdges(scan: BoundaryScan): Promise<NewEdges> {
  const known = new Set(scan.baseline.edges);
  const covered = new Set(scan.baseline.areas);
  const found = new Set<string>();
  for (const file of scan.files) {
    const from = areaOf(file.rel);
    // An area the baseline never read cannot say what is new in it.
    if (!covered.has(from)) continue;
    for (const target of await importsIn(file.rel, file.src)) {
      const to = areaOfImport(file.rel, target, scan.dirs);
      if (!to || known.has(edge(from, to))) continue;
      found.add(`${from} → ${to}`);
    }
  }
  return { edges: [...found].sort() };
}
