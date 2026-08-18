import { afterEach, test } from "bun:test";
import { createElement } from "react";
import { cleanup, render } from "../support/render.tsx";
import { inFlight, mockHttp } from "../support/http.ts";
import { Notes } from "../../web/src/features/notes/view.tsx";
import { WithQueries } from "./queries.tsx";

/**
 * testing-library's own `afterEach(cleanup)` is registered when its module is
 * evaluated, and `bun test` scopes the lifecycle globals per file — so that hook
 * belongs to whichever file imported it first, and every later file kept the
 * previous one's nodes in `document.body`. Each file registers its own.
 */
/** The pane reads on mount; this test is looking at the state before it lands. */
mockHttp(inFlight());

afterEach(cleanup);

test("notes have a renderable loading state", () => {
  // The read is left in flight, which is what the pane comes up in front of.
  render(createElement(WithQueries, null, createElement(Notes, { projectId: 1 }))).getByText(/读记录/);
});
