import { afterEach, test } from "bun:test";
import { createElement } from "react";
import { cleanup, render, restoreFetch, stubFetch } from "../support/render.tsx";
import { Notes } from "../../web/src/features/notes/view.tsx";

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

test("notes have a renderable loading state", () => {
  // The read is left in flight, which is what the pane comes up in front of.
  stubFetch();
  render(createElement(Notes, { projectId: 1 })).getByText(/读记录/);
});
