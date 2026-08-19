import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render as mount, restoreFetch, waitFor } from "../support/render.tsx";
import type { Evidence } from "../../web/src/shared/api.ts";
import { EvidencePanel } from "../../web/src/features/evidence/view.tsx";

/**
 * Two slices read in a row, answered out of order.
 *
 * The panel used to hold the evidence in `useState` and fill it from a bare
 * `.then()` in an effect, with no ignore flag and no `AbortController`. Clicking one
 * slice then a faster one left the first request in flight; when it came back it
 * wrote its `accept_spec`, its diff and its verdicts into a panel already showing
 * the second — a reading attributed to the wrong work.
 */
/**
 * The order below is the one that produced it: the second request resolves first, so
 * what the panel shows is settled, and *then* the first reply lands.
 */
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

/** A network whose replies are released by the test, one URL substring at a time. */
function deferredFetch(bodies: Record<string, unknown>) {
  const waiting = new Map<string, () => void>();
  const answer = (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const hit = Object.entries(bodies).find(([path]) => url.includes(path));
    if (!hit) return new Promise<Response>(() => {});
    return new Promise<Response>((resolve) => {
      waiting.set(hit[0], () =>
        resolve(new Response(JSON.stringify(hit[1]), { headers: { "content-type": "application/json" } })),
      );
    });
  };
  globalThis.fetch = Object.assign(answer, { preconnect: fetch.preconnect });
  return {
    /** Release one pending reply and let React flush what it causes. */
    release: async (path: string) => {
      await act(async () => {
        waiting.get(path)?.();
        await Promise.resolve();
      });
    },
    pending: () => [...waiting.keys()],
  };
}

afterEach(() => {
  cleanup();
  restoreFetch();
});

test("a slow reply for the slice left behind never lands under the slice on screen", async () => {
  const net = deferredFetch({
    "/slices/1/evidence": evidence({ accept_spec: "第一片的验收标准", seq: 1 }),
    "/slices/2/evidence": evidence({ accept_spec: "第二片的验收标准", seq: 2 }),
  });
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { getAllByText, queryAllByText, rerender } = mount(
    <QueryClientProvider client={queries}>
      <EvidencePanel sliceId={1} />
    </QueryClientProvider>,
  );

  // The boss moves on before the first read comes back.
  await waitFor(() => expect(net.pending()).toContain("/slices/1/evidence"));
  rerender(
    <QueryClientProvider client={queries}>
      <EvidencePanel sliceId={2} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(net.pending()).toContain("/slices/2/evidence"));

  // The slice actually on screen answers, and is shown.
  await net.release("/slices/2/evidence");
  await waitFor(() => expect(getAllByText("第二片的验收标准").length).toBe(1));

  // Now the abandoned read finally returns. It belongs to a slice nobody is
  // looking at, so nothing it says may reach the page.
  await net.release("/slices/1/evidence");
  await act(async () => {
    await Promise.resolve();
  });
  expect(queryAllByText("第一片的验收标准")).toHaveLength(0);
  expect(getAllByText("第二片的验收标准").length).toBe(1);
});
