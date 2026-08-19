import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

/**
 * The panel's own import graph, read off the source: two shapes that were both in
 * the tree and neither of which is visible from any single file.
 *
 * A **cycle between features** — `requirement/view` → `telemetry/view` →
 * `requirement/accordion` — costs the ability to read one feature without the
 * other, and no file-level check sees it. The giveaway was the accordion: a
 * generic Radix wrapper filed under a domain, which is how a shared control ends
 * up owned by the first feature that needed it.
 */
/**
 * A **model importing a view**: `navigation/model.ts` reached into a 700-line
 * component for a Zod enum, so parsing a URL hash pulled in every Radix primitive
 * that component imports. Type-only edges are allowed — `import type` is erased
 * before it reaches a bundle.
 *
 * Regex over the source, not a bundler pass: these are the project's own relative
 * imports, all string literals, and the alternative is a second module resolver
 * to maintain beside Bun's.
 */
const ROOT = new URL("../../web/src/", import.meta.url).pathname;

const files = [...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: ROOT })].filter((f) => !f.endsWith(".d.ts"));

/** Where a relative specifier lands, given the extension-less style used here. */
function resolve(from: string, spec: string): string | null {
  const base = normalize(join(dirname(from), spec));
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  return candidates.find((c) => files.includes(c)) ?? null;
}

/** `import type { X } from "…"` and `import { type X } from "…"` are erased; the rest are edges. */
const IMPORT = /\bimport\s+(type\s+)?([\s\S]*?)\bfrom\s+"(\.[^"]*)"/g;
const VALUE_ONLY = (clause: string) => clause.replace(/\btype\s+[\w$]+(\s+as\s+[\w$]+)?\s*,?/g, "").trim();

interface Edge {
  to: string;
  typeOnly: boolean;
}

const graph = new Map<string, Edge[]>(
  files.map((file) => {
    const source = readFileSync(join(ROOT, file), "utf8");
    const edges = [...source.matchAll(IMPORT)].flatMap(([, typeKeyword, clause = "", spec]): Edge[] => {
      const to = resolve(file, spec!);
      if (!to) return [];
      const remaining = VALUE_ONLY(clause);
      const typeOnly = Boolean(typeKeyword) || remaining === "" || remaining === "{}" || remaining === "{ }";
      return [{ to, typeOnly }];
    });
    return [file, edges];
  }),
);

/**
 * The unit a reader moves, deletes or reasons about in one go.
 *
 * `features/*` splits one level deeper because each feature is its own such
 * unit; `ui`, `shared` and `app` are each a single layer, so grouping them by
 * their top directory is what makes "a layer imported backwards" visible at all.
 */
const featureOf = (file: string): string => {
  const parts = file.split("/");
  return parts[0] === "features" ? parts.slice(0, 2).join("/") : parts[0]!;
};

/** Every cycle in a graph given as adjacency, reported as the path that closes it. */
function cycles(edges: Map<string, string[]>): string[][] {
  const found: string[][] = [];
  const state = new Map<string, "open" | "done">();
  const walk = (node: string, path: string[]): void => {
    if (state.get(node) === "open") {
      found.push([...path.slice(path.indexOf(node)), node]);
      return;
    }
    if (state.get(node) === "done") return;
    state.set(node, "open");
    for (const next of edges.get(node) ?? []) walk(next, [...path, node]);
    state.set(node, "done");
  };
  for (const node of edges.keys()) walk(node, []);
  return found;
}

test("no feature in the panel imports its way back to itself", () => {
  const byFeature = new Map<string, Set<string>>();
  for (const [file, edges] of graph) {
    const from = featureOf(file);
    const set = byFeature.get(from) ?? new Set<string>();
    for (const edge of edges) {
      const to = featureOf(edge.to);
      if (to !== from) set.add(to);
    }
    byFeature.set(from, set);
  }
  const adjacency = new Map([...byFeature].map(([k, v]) => [k, [...v]]));
  expect(cycles(adjacency).map((c) => c.join(" -> "))).toEqual([]);
});

test("no module imports its way back to itself", () => {
  const adjacency = new Map([...graph].map(([file, edges]) => [file, [...new Set(edges.map((e) => e.to))]]));
  expect(cycles(adjacency).map((c) => c.join(" -> "))).toEqual([]);
});

test("a model never imports a view for anything but a type", () => {
  // A `model.ts` is the part a test can call without a document. A value import
  // from a `.tsx` puts React, Radix and the whole component tree behind a
  // function that parses a string, and makes the view the owner of a contract
  // the model is named after.
  const offenders = [...graph]
    .filter(([file]) => /models?\.ts$/.test(file))
    .flatMap(([file, edges]) =>
      edges.filter((e) => e.to.endsWith(".tsx") && !e.typeOnly).map((e) => `${file} -> ${e.to}`),
    );
  expect(offenders).toEqual([]);
});
