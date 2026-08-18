import { Language, Parser, type Node } from "web-tree-sitter";
import goWasm from "@vscode/tree-sitter-wasm/wasm/tree-sitter-go.wasm" with { type: "file" };
import jsWasm from "@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm" with { type: "file" };
import pyWasm from "@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm" with { type: "file" };
import rsWasm from "@vscode/tree-sitter-wasm/wasm/tree-sitter-rust.wasm" with { type: "file" };
import tsxWasm from "@vscode/tree-sitter-wasm/wasm/tree-sitter-tsx.wasm" with { type: "file" };
import tsWasm from "@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm" with { type: "file" };
import runtimeWasm from "web-tree-sitter/web-tree-sitter.wasm" with { type: "file" };
import { activeTracer } from "../../platform/observability/traces.ts";

/**
 * The names a source file declares, for whatever language it is written in.
 *
 * This used to be one regex over `export function|const|class|…`, which is JS/TS
 * syntax, so a Go file entered the repo map and came back out with a path and no
 * names. Orchestrator indexes *the boss's* repositories, not this one, so "the
 * source is simply invisible" was the normal case rather than the exotic one.
 *
 * Real grammars rather than more regexes, because the regex was not merely
 * incomplete — it matched `export function` inside a string or a comment, and it
 * could not tell `func (s *Server) Listen()` from `func NewServer()`. Six
 * languages of that, hand-written, is the thing tree-sitter is.
 */

/**
 * Extension to grammar, and the grammar files are imported rather than vendored.
 *
 * `@vscode/tree-sitter-wasm` ships pre-built `.wasm` for sixteen languages; only
 * the ones imported here end up in the binary (4.6 MiB of the 21 MB installed).
 * A vendored copy under this directory would need a header saying where it came
 * from and how to refresh it — which is what a lockfile entry already is, kept
 * current by the same tooling as every other dependency.
 */
const GRAMMAR: Record<string, string> = {
  cjs: jsWasm,
  cts: tsWasm,
  go: goWasm,
  js: jsWasm,
  jsx: jsWasm,
  mjs: jsWasm,
  mts: tsWasm,
  py: pyWasm,
  pyi: pyWasm,
  rs: rsWasm,
  ts: tsWasm,
  tsx: tsxWasm,
};

/**
 * Where `export` is the thing that makes a name worth listing.
 *
 * The old regex listed exported names only, and for JS/TS that is the right cut:
 * a module's private helpers are not what "where does X live" is asking about,
 * and a file with thirty of them would push its public names past the cap. Go,
 * Python and Rust have no such keyword — visibility is capitalisation, an
 * underscore, or `pub` — so for those, top-level *is* the cut.
 */
const EXPORTS_ONLY = new Set([jsWasm, tsWasm, tsxWasm]);

/**
 * Top-level nodes that declare nothing, and would otherwise contribute a name.
 *
 * `import os` in Python carries a `name` field, so without this the first symbol
 * of every Python file is whatever it imported first.
 */
const NOT_A_DECLARATION = /^(import|package|use_declaration|extern_crate|expression_statement|comment)/;

/**
 * How deep a name hides under the node that declares it.
 *
 * Two levels, and the number comes from the languages rather than from taste.
 * Go's `type Server struct{}` is `type_declaration → type_spec(name)`; TypeScript's
 * `export const beta = 1` is `export_statement → lexical_declaration →
 * variable_declarator(name)`, which is the deepest of the six. Stopping there is
 * also what keeps a Python class's methods out of the list while a Rust `impl`
 * block's do get in — the class carries its own name and the `impl` does not.
 */
const DEPTH = 2;

const parsers = new Map<string, Parser>();
let runtime: Promise<void> | undefined;

/**
 * Load the runtime and one grammar, once per process.
 *
 * `Parser.init()` with no arguments is what the README shows, and it works under
 * `bun run` and fails inside `bun build --compile`: Emscripten resolves its own
 * `web-tree-sitter.wasm` as a sibling of the script, and a compiled binary has no
 * siblings — `ENOENT /$bunfs/root/web-tree-sitter.wasm`. Handing over the bytes
 * through the documented `wasmBinary` module option is what makes the compiled
 * artefact work, and it is measured in `test/mech/symbols.test.ts` rather than
 * reasoned about, because the source and the artefact disagreed here.
 *
 * A rejection is cached along with everything else. Neither wasm can be missing
 * unless the binary was built wrong, and retrying a packaging fault once per file
 * per tick would bury the one line that says what happened.
 */
async function parserFor(wasm: string): Promise<Parser> {
  const cached = parsers.get(wasm);
  if (cached) return cached;
  return activeTracer().startActiveSpan(
    "symbols.grammar.load",
    { attributes: { "symbols.grammar": wasm } },
    async (span) => {
      try {
        // Do not "simplify" this to `Parser.init()`. Every example online is the
        // no-argument form, it passes every gate in this repository, and it dies
        // in the binary `release.yml` ships with `ENOENT
        // /$bunfs/root/web-tree-sitter.wasm` — Emscripten looks for its runtime
        // beside the script and `/$bunfs` has no siblings. Guarded by the
        // compiled-binary test in `test/mech/symbols.test.ts`, which is the only
        // thing here that can tell the two apart.
        runtime ??= Parser.init({ wasmBinary: new Uint8Array(await Bun.file(runtimeWasm).arrayBuffer()) });
        await runtime;
        const parser = new Parser();
        parser.setLanguage(await Language.load(new Uint8Array(await Bun.file(wasm).arrayBuffer())));
        parsers.set(wasm, parser);
        return parser;
      } finally {
        span.end();
      }
    },
  );
}

function collect(node: Node, out: string[], depth: number, max: number): void {
  if (out.length >= max || NOT_A_DECLARATION.test(node.type)) return;
  const name = node.childForFieldName("name");
  if (name) {
    out.push(name.text);
    return;
  }
  if (depth > 0) for (const child of node.namedChildren) collect(child, out, depth - 1, max);
}

/**
 * Up to `max` names declared by `src`, or none for a language we cannot parse.
 *
 * None is still a useful map entry — the path answers "where does X live" — and
 * it is what every language got before this module existed.
 */
export async function symbolsIn(rel: string, src: string, max: number): Promise<string[]> {
  const dot = rel.lastIndexOf(".");
  const wasm = dot < 0 ? undefined : GRAMMAR[rel.slice(dot + 1).toLowerCase()];
  if (!wasm) return [];
  const parser = await parserFor(wasm);
  const tree = parser.parse(src);
  if (!tree) return [];
  try {
    const out: string[] = [];
    const exportsOnly = EXPORTS_ONLY.has(wasm);
    for (const top of tree.rootNode.namedChildren) {
      if (exportsOnly && top.type !== "export_statement") continue;
      collect(top, out, DEPTH, max);
    }
    return out;
  } finally {
    // The tree is wasm memory the GC cannot see. The repo map is rebuilt every
    // watchdog tick over every tracked file, so a leak here is measured in
    // repositories rather than in files.
    tree.delete();
  }
}
