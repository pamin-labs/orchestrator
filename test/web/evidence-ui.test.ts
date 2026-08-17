import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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

const render = (initialEvidence?: Evidence) =>
  renderToStaticMarkup(createElement(EvidencePanel, { sliceId: 1, ...(initialEvidence ? { initialEvidence } : {}) }));

test("evidence exposes loading, empty, verdict and gate states", () => {
  expect(render()).toContain("读改动");
  expect(render(evidence({ diff: "", stat: "", verdicts: [], gates: [] }))).toContain("还没有判词");

  const failed = render(evidence({ verdicts: [{ author: "qa", body: "FAIL: smoke broke", at: 1 }] }));
  expect(failed).toContain("verdicts 1");
  expect(failed).toContain("没过");
  expect(failed).toContain("smoke broke");

  const gated = render(evidence({ gates: [{ name: "typecheck", path: "gate.log", size: 12 }] }));
  expect(gated).toContain("typecheck");
  expect(gated).toContain("1 个文件");
  expect(gated).toContain("+2 −1");
});
