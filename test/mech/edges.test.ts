import { expect, test } from "bun:test";
import { areaOf, areaOfImport, edge, edgesIn } from "../../src/mech/knowledge/edges.ts";

const dirs = new Set([
  "src",
  "src/mech",
  "src/mech/flow",
  "src/api",
  "web/src",
  "web/src/features",
  "mypkg",
  "mypkg/sub",
]);

/**
 * The altitude an architecture rule is written at. Per file would flag every
 * ordinary refactor; per top-level directory would put all of `src/` in one area
 * and see nothing inside it.
 */
test("an area is two segments, or one for a file at the root", () => {
  expect(areaOf("src/mech/flow/review.ts")).toBe("src/mech");
  expect(areaOf("src/gate.ts")).toBe("src");
  expect(areaOf("README.md")).toBe(".");
});

test("an import points at an area, or at nobody this repository knows", () => {
  // Relative, resolved against the importing file.
  expect(areaOfImport("src/mech/flow/review.ts", "../../api/orch.ts", dirs)).toBe("src/api");
  // A dotted or `::` module read as a path, from the root and from `src/`.
  expect(areaOfImport("app/main.py", "mypkg.sub", dirs)).toBe("mypkg/sub");
  expect(areaOfImport("src/main.rs", "crate::mech::gate", dirs)).toBe("src/mech");
  // Somebody else's package resolves to no directory here, and is ignored rather
  // than guessed at — this decides whether work is blocked.
  expect(areaOfImport("src/mech/gate.ts", "zod", dirs)).toBeNull();
  expect(areaOfImport("src/mech/gate.ts", "node:fs", dirs)).toBeNull();
  // Inside its own area is not an edge.
  expect(areaOfImport("src/mech/flow/review.ts", "./reconcile.ts", dirs)).toBeNull();
});

test("a file's edges are what it imports, deduplicated", async () => {
  const edges = await edgesIn(
    "src/mech/flow/review.ts",
    `import { a } from "../../api/orch.ts";
     import { b } from "../../api/panel.ts";
     import { c } from "./reconcile.ts";
     import { z } from "zod";`,
    dirs,
  );
  expect(edges).toEqual([edge("src/mech", "src/api")]);
});

/** A language with no grammar in this binary yields nothing, and nothing must
 *  read as "no opinion" rather than "no imports". */
test("a language this binary cannot parse contributes no edges", async () => {
  expect(await edgesIn("app/Main.kt", "import mypkg.sub.Thing", dirs)).toEqual([]);
});

/**
 * Eleven grammars spell a module reference four ways, and one of them is already
 * a path — which is why `core/gate.h` must not become `core/gate/h`.
 */
test("every spelling of a module name resolves to the same kind of answer", () => {
  const wide = new Set([
    "src",
    "src/mech",
    "src/main/java",
    "src/main/java/com/example/core",
    "src/main/java/org/other/thing",
    "src/Example/Core",
    "core",
    "app",
    "app/core",
    "App/Core",
    "lib",
  ]);
  // Java: the last segment is a class, not a folder, and `src/main/java` is
  // Maven's ceremony rather than structure — without stripping it every package
  // in the repository shares one area.
  expect(areaOfImport("src/main/java/com/example/app/A.java", "org.other.thing.T", wide)).toBe("org/other");
  // And a class in the importer's own area is not an edge, the same way
  // `src/mech/flow` reaching `src/mech/git` is not one.
  expect(areaOfImport("src/main/java/com/example/app/A.java", "com.example.core.Gate", wide)).toBeNull();
  // C#: a qualified name from the root, the alias already discarded upstream.
  expect(areaOfImport("src/App/A.cs", "Example.Core.Gate", wide)).toBe("src/Example");
  // C++: a path with a file extension on the end, which must not be split on the dot.
  expect(areaOfImport("app/main.cpp", "core/gate.h", wide)).toBe("core");
  // PHP: backslashes, and the namespace spelled as the directory is. A project
  // whose PSR-4 map says otherwise resolves to nothing here — composer's autoload
  // is a config nobody reads, and no edge is the right answer to a question this
  // cannot see.
  expect(areaOfImport("app/Http/A.php", "App\\Core\\Gate", wide)).toBe("App/Core");
  expect(areaOfImport("app/Http/A.php", "Vendor\\Sdk\\Client", wide)).toBeNull();
  // Ruby: already a path.
  expect(areaOfImport("lib/boot.rb", "app/core/gate", wide)).toBe("app/core");
  // And the guarantee that survived all of it: a package this repository does not
  // contain is nobody's edge, however many source roots are tried.
  expect(areaOfImport("src/mech/gate.ts", "zod", wide)).toBeNull();
  expect(areaOfImport("src/App/A.cs", "System.IO", wide)).toBeNull();
});
