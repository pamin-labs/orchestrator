import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render as mount } from "../support/render.tsx";
import { inFlight, mockHttp } from "../support/http.ts";
import type { Evidence } from "../../web/src/shared/api.ts";
import { EvidencePanel } from "../../web/src/features/evidence/view.tsx";

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

/**
 * One panel at a time; they all share the page.
 *
 * The evidence is seeded into the query cache rather than passed as a prop. It used
 * to arrive through an `initialEvidence` prop no caller in the panel ever set — a
 * branch in production code whose only reason to exist was this file, and which
 * meant these renders never took the path the panel actually takes.
 *
 * A panel handed nothing has a read in flight, which is the state it comes up in.
 */
const render = (seed?: Evidence) => {
  cleanup();
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (seed) queries.setQueryData(["evidence", 1], seed);
  return mount(createElement(QueryClientProvider, { client: queries }, createElement(EvidencePanel, { sliceId: 1 })));
};

const shown = (r: ReturnType<typeof render>, text: string) =>
  expect(r.getAllByText(text, { exact: false }).length).toBeGreaterThan(0);

/**
 * testing-library's own `afterEach(cleanup)` is registered when its module is
 * evaluated, and `bun test` scopes the lifecycle globals per file — so that hook
 * belongs to whichever file imported it first, and every later file kept the
 * previous one's nodes in `document.body`. Each file registers its own.
 */
afterEach(cleanup);

/** A panel handed nothing has its evidence read in flight, which is the state it
 *  comes up in. */
mockHttp(inFlight());

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
