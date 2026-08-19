import { afterEach, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { cleanup, render as mount, restoreFetch, waitFor } from "../support/render.tsx";
import { WithQueries } from "./queries.tsx";
import { TipRoot } from "../../web/src/ui/tooltip.tsx";
import { Skills } from "../../web/src/features/skills/view.tsx";
import { Notes } from "../../web/src/features/notes/view.tsx";
import { Workspace } from "../../web/src/features/workspace/view.tsx";

/**
 * What a pane shows after the scope it was reading for has been left.
 *
 * Every one of these panes was `useState` filled from a bare `.then()` in an
 * effect, with no ignore flag and no `AbortController`. They are one defect and
 * they read the same way to whoever hit one: the boss moves to the next project,
 * the abandoned request comes back, and its answer is written into a pane whose
 * heading now names something else. The data is real, just filed under the wrong
 * thing, which is worse than an error.
 */
/**
 * The order below is what produces it, and is why a hand-rolled ignore flag would
 * not be enough on its own: the scope on screen answers *first*, so what the reader
 * sees is settled, and the stale reply arrives after.
 */

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
    release: async (path: string) => {
      await act(async () => {
        waiting.get(path)?.();
        await Promise.resolve();
      });
    },
    pending: () => [...waiting.keys()],
  };
}

/** Let every already-resolved promise and the render it causes finish. */
const settle = () =>
  act(async () => {
    await Promise.resolve();
  });

const wrap = (node: ReactNode) => (
  <WithQueries>
    <TipRoot>{node}</TipRoot>
  </WithQueries>
);

afterEach(() => {
  cleanup();
  restoreFetch();
});

test("the skills pane never shows another project's skills", async () => {
  const net = deferredFetch({
    "skills?project=1": {
      skills: [{ name: "第一个项目的技能", description: "d", path: "/a", scope: "user", on: false }],
    },
    "skills?project=2": {
      skills: [{ name: "第二个项目的技能", description: "d", path: "/b", scope: "user", on: false }],
    },
  });
  const { getAllByText, queryAllByText, rerender } = mount(wrap(<Skills projectId={1} />));
  await waitFor(() => expect(net.pending()).toContain("skills?project=1"));

  rerender(wrap(<Skills projectId={2} />));
  await waitFor(() => expect(net.pending()).toContain("skills?project=2"));

  await net.release("skills?project=2");
  await waitFor(() => expect(getAllByText("第二个项目的技能")).toHaveLength(1));

  await net.release("skills?project=1");
  await settle();
  expect(queryAllByText("第一个项目的技能")).toHaveLength(0);
  expect(getAllByText("第二个项目的技能")).toHaveLength(1);
});

const note = (body: string, id: number) => ({
  id,
  grpId: 7,
  kind: "journal" as const,
  body,
  at: 1_700_000_000_000,
  exportPath: null,
  frontmatter: null,
  group: null,
});

test("the blackboard never shows another requirement's notes", async () => {
  const net = deferredFetch({
    "notes?group=1": { notes: [note("第一组的记录", 1)] },
    "notes?group=2": { notes: [note("第二组的记录", 2)] },
  });
  const { getAllByText, queryAllByText, rerender } = mount(wrap(<Notes grpId={1} />));
  await waitFor(() => expect(net.pending()).toContain("notes?group=1"));

  rerender(wrap(<Notes grpId={2} />));
  await waitFor(() => expect(net.pending()).toContain("notes?group=2"));

  await net.release("notes?group=2");
  await waitFor(() => expect(getAllByText("第二组的记录")).toHaveLength(1));

  await net.release("notes?group=1");
  await settle();
  expect(queryAllByText("第一组的记录")).toHaveLength(0);
  expect(getAllByText("第二组的记录")).toHaveLength(1);
});

const sandbox = (image: string) => ({
  group: { id: 7, name: "ship it", status: "RUNNING", branch: "feature/x" },
  sandbox: { id: "box", at: null, image, cpu: "2", memory: "4g", ttlSeconds: 3600, mounts: [] },
  lines: [],
});

test("the workspace never shows another group's container", async () => {
  const net = deferredFetch({
    "sandbox?grp=1": sandbox("第一组的镜像"),
    "sandbox?grp=2": sandbox("第二组的镜像"),
  });
  const { getAllByText, queryAllByText, rerender } = mount(wrap(<Workspace frames={[]} grpId={1} />));
  await waitFor(() => expect(net.pending()).toContain("sandbox?grp=1"));

  rerender(wrap(<Workspace frames={[]} grpId={2} />));
  await waitFor(() => expect(net.pending()).toContain("sandbox?grp=2"));

  await net.release("sandbox?grp=2");
  await waitFor(() => expect(getAllByText("第二组的镜像")).toHaveLength(1));

  await net.release("sandbox?grp=1");
  await settle();
  expect(queryAllByText("第一组的镜像")).toHaveLength(0);
  expect(getAllByText("第二组的镜像")).toHaveLength(1);
});
