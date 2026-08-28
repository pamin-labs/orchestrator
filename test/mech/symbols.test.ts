import { expect, test } from "bun:test";
import { join } from "node:path";
import { importsIn, symbolsIn } from "../../src/mech/knowledge/symbols.ts";
import { tempDir } from "../support/temp.ts";

const GO = `package main

import "fmt"

type Server struct{ Addr string }
type Handler interface{ Serve() }

func (s *Server) Listen() error { return nil }
func NewServer(addr string) *Server { return nil }

const DefaultPort = 8080
var Registry = map[string]int{}
`;

const PY = `import os
from typing import Any

class Widget:
    def draw(self): pass

def render(w): pass
async def fetch(u): pass
`;

const RS = `use std::io;

pub struct Server { addr: String }
impl Server { pub fn listen(&self) {} }
pub fn new_server(a: &str) -> Server { todo!() }
pub enum Mode { A, B }
pub trait Draw { fn draw(&self); }
pub const PORT: u16 = 8080;
type Alias = u32;
`;

const TS = `import { x } from "./x.ts";

export function alpha() {}
export const beta = 1;
export default class Gamma {}
export interface Delta {}
export type Eps = number;
export { zeta } from "./z.ts";
export enum Iota { A }

function hidden() {}
const alsoHidden = 2;
`;

/**
 * Every language the map can read, and what "a symbol" means in each.
 *
 * The whole extractor used to be one regex over `export function|const|class|…`,
 * which is JS/TS syntax. A Go file entered the map and came back out with a path and
 * no names — and since Orchestrator indexes the boss's repositories rather than this
 * one, that was the normal case.
 */
/**
 * JS/TS lists exported names only and the others list top-level ones, because that
 * is the cut each language gives you: a Go or Rust or Python module has no `export`
 * keyword, and a JS module's private helpers would push its public names past the
 * cap.
 */
test.each([
  [
    "server.go",
    GO,
    // `fmt` is not a declaration, and `type_declaration → type_spec` is where Go
    // keeps the name. The method comes back as `Listen`, not as the receiver.
    ["Server", "Handler", "Listen", "NewServer", "DefaultPort", "Registry"],
  ],
  [
    "widget.py",
    PY,
    // `import os` carries a `name` field of its own, so without a rule against it
    // the first symbol of every Python file is whatever it imported first. The
    // class's methods stay out: the class already named itself.
    ["Widget", "render", "fetch"],
  ],
  [
    "server.rs",
    RS,
    // `impl` names nothing, so its methods surface one level down — which is the
    // same answer Go gives for the same code shape.
    ["Server", "listen", "new_server", "Mode", "Draw", "PORT", "Alias"],
  ],
  [
    "mod.ts",
    TS,
    // `export const beta = 1` is the deepest of the six shapes:
    // `export_statement → lexical_declaration → variable_declarator`. A re-export
    // is included because in a barrel file it is the only thing there is.
    ["alpha", "beta", "Gamma", "Delta", "Eps", "zeta", "Iota"],
  ],
  ["app.jsx", "export const App = () => <div />;\nconst Private = 1;\n", ["App"]],
  ["view.tsx", "export function View(): JSX.Element { return <p />; }\n", ["View"]],
  // No grammar is not a failure. A path still answers "where does X live", which
  // is what every language got before this module existed.
  ["notes.md", "# Title\n\nexport function notCode() {}\n", []],
  ["Makefile", "all:\n\tgo build ./...\n", []],
])("%s declares the names the map lists", async (rel, src, want) => {
  expect(await symbolsIn(rel, src, 12)).toEqual(want);
});

test("a keyword inside a string or a comment is not a declaration", async () => {
  // The reason this is a parser and not six more regexes. The old
  // `/^\s*export\s+(?:...)(?:function|const|...)\s+(\w+)/gm` had no idea what a
  // string was, so a file documenting its own API in a comment listed the
  // documentation, and a template literal holding generated code listed the
  // code it was generating.
  const src = [
    "// Call `export function ghost() {}` to register a handler.",
    "const doc = `export const phantom = 1;`;",
    "/** export class Spectre {} */",
    "export function real() {}",
  ].join("\n");
  expect(await symbolsIn("api.ts", src, 12)).toEqual(["real"]);
});

test("a file contributes at most the cap, and the cap is the caller's", async () => {
  const src = Array.from({ length: 40 }, (_, i) => `func F${i}() {}`).join("\n");
  expect(await symbolsIn("many.go", src, 12)).toHaveLength(12);
  expect(await symbolsIn("many.go", src, 3)).toEqual(["F0", "F1", "F2"]);
});

test("a grammar loads from inside a compiled binary, which is not the same claim as loading under `bun run`", async () => {
  // The finding that made this test exist, and it is a shipping bug rather than a
  // theoretical one. `await Parser.init()` — the call the web-tree-sitter README
  // shows — passes every gate here and dies in the artefact `release.yml` builds:
  //
  //   RuntimeError: Aborted(Error: ENOENT: no such file or directory,
  //                 open '/$bunfs/root/web-tree-sitter.wasm')
  //
  // Emscripten resolves its own runtime `.wasm` as a sibling of the script, and
  // inside `/$bunfs` there are no siblings. `symbols.ts` therefore embeds that
  // file and hands over the bytes through the documented `wasmBinary` option.
  // Nothing about running this repository's source can tell you whether that is
  // still true, so the test compiles a binary and runs it — the same reason
  // `docs/standards/testing.md` gives for measuring the artefact.
  const dir = tempDir("symbols-compile-");
  const entry = join(dir, "entry.ts");
  const bin = join(dir, "probe");
  await Bun.write(
    entry,
    `import { symbolsIn } from ${JSON.stringify(join(import.meta.dir, "../../src/mech/knowledge/symbols.ts"))};\n` +
      `console.log(JSON.stringify(await symbolsIn("x.go", "package main\\nfunc Gamma() {}\\n", 12)));\n`,
  );

  const built = Bun.spawnSync(["bun", "build", "--compile", entry, "--outfile", bin], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect({ compiled: built.exitCode, err: built.exitCode === 0 ? "" : built.stderr.toString() }).toEqual({
    compiled: 0,
    err: "",
  });

  // From a directory that is not the repository, so a grammar found on disk
  // rather than inside the binary would be found by accident and pass.
  const ran = Bun.spawnSync([bin], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  expect({ exit: ran.exitCode, out: ran.stdout.toString().trim(), err: ran.stderr.toString() }).toEqual({
    exit: 0,
    out: '["Gamma"]',
    err: "",
  });
  // 30s, because this test writes a 69 MB executable and Bun's default is 5s.
  // Alone it takes 1.5s; sharing a machine with the other 159 files under
  // `--parallel` it has been measured at 6.7s, which is a flake rather than a
  // finding. The budget is a ceiling on the disk write, not on the parse.
}, 30_000);

/**
 * Where a file imports from, in each of the six grammars this binary carries.
 *
 * Every one of these was measured before it was written down, and three came back
 * wrong: Go returned its whole `import (…)` block *and* each path with the quotes
 * still on, because it spells its string node `interpreted_string_literal` and a
 * generic `string` lookup never matched; Python turned `from mypkg.sub import
 * thing` into one string. One branch per node type, using the field each grammar
 * gives, is what those two cost.
 */
test("an import is the module it names, in every grammar here", async () => {
  expect(
    await importsIn(
      "a.ts",
      `import { x } from "../gate.ts";\nimport type { Y } from "./y";\nconst z = require("node:fs");`,
    ),
  ).toEqual(["../gate.ts", "./y", "node:fs"]);
  expect(await importsIn("a.tsx", `import React from "react";`)).toEqual(["react"]);
  expect(await importsIn("a.js", `const a = require("./a");\nimport b from "b";`)).toEqual(["./a", "b"]);
  // Go: the block holds one spec per line, and the block itself names nothing.
  expect(await importsIn("a.go", `package main\n\nimport (\n\t"fmt"\n\t"example.com/x/y"\n)\n`)).toEqual([
    "fmt",
    "example.com/x/y",
  ]);
  // Python: `import` inside a function is still an import, which is why the walk
  // descends instead of reading top-level nodes.
  expect(await importsIn("a.py", `import os.path\nfrom mypkg.sub import thing\n\ndef f():\n    import json\n`)).toEqual(
    ["os.path", "mypkg.sub", "json"],
  );
  expect(await importsIn("a.rs", `use crate::mech::gate;\nuse std::fs::File;\nextern crate serde;`)).toEqual([
    "crate::mech::gate",
    "std::fs::File",
    "serde",
  ]);
});

/**
 * A call that is not `require`, and a language with no grammar in this binary.
 * Both must answer nothing — a caller reads that as "no opinion", and failing
 * open is the only safe direction for a check that can block work.
 */
test("what is not an import contributes nothing", async () => {
  expect(await importsIn("a.js", `fetch("https://example.com");\nconsole.log("./not-an-import");`)).toEqual([]);
  expect(await importsIn("Main.kt", `import kotlin.io.println`)).toEqual([]);
  expect(await importsIn("README.md", `import x from "y"`)).toEqual([]);
});

/**
 * The five grammars added after the first six, each with the shape it actually
 * has — measured before it was written down, the same way the first six were.
 *
 * Java and Go both call their node `import_declaration` and mean opposite things:
 * Java's *is* the import and holds a `scoped_identifier`, Go's is a block that
 * names nothing itself and holds one `import_spec` per line.
 */
test("java, c#, c++, php and ruby each name their imports differently", async () => {
  expect(await importsIn("A.java", `package com.example.app;\nimport com.example.core.Gate;`)).toEqual([
    "com.example.core.Gate",
  ]);
  // The alias is not the module: `using Core = Example.Core.Gate` imports the
  // qualified name and calls it something else here.
  expect(await importsIn("A.cs", `using System.IO;\nusing Core = Example.Core.Gate;`)).toEqual([
    "System.IO",
    "Example.Core.Gate",
  ]);
  // `"core/gate.h"` is this repository's; `<vector>` is the toolchain's.
  expect(await importsIn("a.cpp", `#include "core/gate.h"\n#include <vector>`)).toEqual(["core/gate.h"]);
  expect(await importsIn("a.php", `<?php\nuse App\\Core\\Gate;\nrequire_once "lib/boot.php";`)).toEqual([
    "App\\Core\\Gate",
    "lib/boot.php",
  ]);
  // Ruby's imports are calls, and so is everything else it does — only the four
  // names that mean "load this" count.
  expect(await importsIn("a.rb", `require "app/core/gate"\nrequire_relative "../boot"\nputs "not an import"`)).toEqual([
    "app/core/gate",
    "../boot",
  ]);
});
