import { expect, test } from "bun:test";
import { areaOf, areaOfImport, edge, edgesIn } from "../../src/mech/knowledge/edges.ts";

const dirs = new Set(["src", "src/mech", "src/mech/flow", "src/api", "web/src", "web/src/features", "mypkg", "mypkg/sub"]);

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
  expect(await edgesIn("app/Main.kt", 'import mypkg.sub.Thing', dirs)).toEqual([]);
});
