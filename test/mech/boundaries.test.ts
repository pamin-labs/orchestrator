import { expect, test } from "bun:test";
import { newEdges } from "../../src/mech/flow/boundaries.ts";

const dirs = new Set(["src", "src/mech", "src/api", "web/src"]);
const baseline = {
  edges: ["src/mech|src/api"],
  areas: ["src/mech", "src/api"],
};

/**
 * The repository's own history is the statement of what its architecture is, so
 * the question is "is this new" rather than "is this right" — which needs nobody
 * to author anything.
 */
test("an edge the repository has never had is what this reports", async () => {
  const out = await newEdges({
    baseline,
    dirs,
    files: [
      {
        rel: "src/mech/flow/review.ts",
        // One edge it has always had, one it has not.
        src: `import { a } from "../../api/orch.ts";\nimport { b } from "../../../web/src/panel.ts";`,
      },
    ],
  });
  expect(out.edges).toEqual(["src/mech → web/src"]);
});

/**
 * The baseline is built from the files an indexing budget read, so an area it
 * never reached has no edges *recorded* rather than none — and reporting every
 * import out of an unread area as new is evidence nobody would read.
 */
test("an area the baseline never read is not an area this has an opinion about", async () => {
  const out = await newEdges({
    baseline,
    dirs,
    files: [{ rel: "web/src/app.tsx", src: `import { z } from "../../src/mech/gate.ts";` }],
  });
  expect(out.edges).toEqual([]);
});

test("a language with no grammar here contributes nothing either way", async () => {
  const out = await newEdges({
    baseline,
    dirs,
    files: [{ rel: "src/mech/Main.kt", src: `import web.src.panel` }],
  });
  expect(out.edges).toEqual([]);
});
