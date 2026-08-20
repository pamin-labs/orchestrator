import { afterEach, expect, test } from "bun:test";
import { HttpResponse, http } from "msw";
import { cleanup, fireEvent, render as mount, waitFor } from "../support/render.tsx";
import { mockHttp, server } from "../support/http.ts";
import { WithQueries } from "./queries.tsx";
import { NewRequirement } from "../../web/src/features/requirement/newreq.tsx";

afterEach(cleanup);
mockHttp();

/**
 * The one thing the boss types that starts work, and what it sends.
 *
 * Nothing imported this file, so the dialog's whole contract — which route, which
 * project, and whether the caller is told it is finished — was unasserted. It is four
 * lines of wiring around `ComposerDialog`, and four lines of wiring is exactly what
 * goes wrong quietly: a `project_id` that is not sent lands the idea on the wrong
 * project, and the boss sees it appear somewhere else.
 */
const open = (projectId: number, onDone: () => void) =>
  mount(
    <WithQueries>
      <NewRequirement open onOpenChange={() => {}} projectId={projectId} onDone={onDone} />
    </WithQueries>,
  );

test("submitting posts the idea to the project it was opened for", async () => {
  const sent: unknown[] = [];
  server.use(
    http.post("*/api/v1/ideas", async ({ request }) => {
      sent.push(await request.json());
      return HttpResponse.json({ id: 7 });
    }),
  );
  let done = 0;
  const view = open(3, () => done++);

  const box = view.getAllByRole("textbox")[0]!;
  fireEvent.change(box, { target: { value: "登录页加记住我" } });
  fireEvent.click(view.getAllByRole("button", { name: "提交" })[0]!);

  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]).toMatchObject({ project_id: 3, text: "登录页加记住我" });
  await waitFor(() => expect(done).toBe(1));
});

/**
 * A refused post does not tell the caller it is finished.
 *
 * `onDone` is what closes the dialog and re-reads the list. Calling it on a failure
 * throws away what the boss typed and shows a list the idea is not in — the shape of
 * failure that reads as the idea having silently vanished.
 */
test("a refused idea leaves the dialog to the boss", async () => {
  server.use(http.post("*/api/v1/ideas", () => HttpResponse.json({ error: "nope" }, { status: 400 })));
  let done = 0;
  const view = open(1, () => done++);

  fireEvent.change(view.getAllByRole("textbox")[0]!, { target: { value: "something" } });
  fireEvent.click(view.getAllByRole("button", { name: "提交" })[0]!);

  await waitFor(() => expect(view.getAllByRole("textbox")[0]).toBeDefined());
  expect(done).toBe(0);
});
