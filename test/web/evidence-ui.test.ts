import { afterEach, beforeEach, expect, test } from "bun:test";
import { createElement } from "react";
import { cleanup, render as mount, restoreFetch, stubFetch } from "../support/render.tsx";
import type { Evidence } from "../../web/src/lib/api.ts";
import { EvidencePanel } from "../../web/src/views/evidence.tsx";

const evidence = (patch: Partial<Evidence> = {}): Evidence => ({
  grp_id: 1,
  seq: 1,
  title: "Ship archives",
  accept_spec: "archives are verifiable",
  base_sha: "abc",
  retries: 0,
  stat: "1 file changed, 2 insertions(+), 1 deletion(-)",
  diff: "diff --git a/a b/a",
  truncated: false,
  scope: "slice",
  verdicts: [],
  gates: [],
  ...patch,
});

/** One panel at a time; they all share the page. The read stays in flight, so a
 *  panel handed no evidence stays in the state it comes up in. */
const render = (initialEvidence?: Evidence) => {
  cleanup();
  return mount(createElement(EvidencePanel, { sliceId: 1, ...(initialEvidence ? { initialEvidence } : {}) }));
};

const shown = (r: ReturnType<typeof render>, text: string) =>
  expect(r.getAllByText(text, { exact: false }).length).toBeGreaterThan(0);

beforeEach(() => stubFetch());
/**
 * testing-library's own `afterEach(cleanup)` is registered when its module is
 * evaluated, and `bun test` scopes the lifecycle globals per file — so that hook
 * belongs to whichever file imported it first, and every later file kept the
 * previous one's nodes in `document.body`. Each file registers its own.
 */
afterEach(() => {
  cleanup();
  restoreFetch();
});

test("evidence exposes loading, empty, verdict and gate states", () => {
  shown(render(), "读改动");
  shown(render(evidence({ diff: "", stat: "", verdicts: [], gates: [] })), "还没有判词");

  const failed = render(evidence({ verdicts: [{ author: "qa", body: "FAIL: smoke broke", at: 1 }] }));
  shown(failed, "verdicts 1");
  shown(failed, "没过");
  shown(failed, "smoke broke");

  const gated = render(evidence({ gates: [{ name: "typecheck", path: "gate.log", size: 12 }] }));
  shown(gated, "typecheck");
  shown(gated, "1 个文件");
  shown(gated, "+2 −1");
});
