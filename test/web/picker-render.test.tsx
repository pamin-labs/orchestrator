import { afterEach, expect, test } from "bun:test";
import { cleanup, render, restoreFetch, stubFetch, waitFor } from "../support/render.tsx";
import { FirstProject, Picker } from "../../web/src/views/picker.tsx";

/**
 * The two ways a project gets added: the card the panel shows when there are no
 * projects yet, and the same list inside a dialog once there are.
 *
 * The dialog half was previously unassertable — `renderToStaticMarkup` emits
 * nothing for a Radix portal, so the surface the boss actually uses rendered as
 * an empty string and every substring check on it would have been vacuous.
 */

const repo = (over: Record<string, unknown> = {}) => ({
  fullName: "pamin-labs/alpha",
  private: false,
  defaultBranch: "main",
  pushedAt: Date.now(),
  cloneUrl: "https://github.com/pamin-labs/alpha.git",
  taken: null,
  ...over,
});

const stubRepos = (body?: unknown) => stubFetch(body === undefined ? {} : { "/github/repos": body });

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

test("the first-project card names itself and offers no repository until one has landed", () => {
  stubRepos();
  const { getByRole, getByText, queryAllByRole, queryAllByText } = render(
    <FirstProject onAdded={() => {}} onSettings={() => {}} />,
  );

  // The card's own name, as a heading rather than as text that happens to match.
  getByRole("heading", { name: "添加第一个项目" });
  getByText("点一行就添加");
  // The filter is offered before the list is, so a fast typist is not blocked.
  getByRole("combobox", { name: /筛一下|选择仓库/ });
  // Still reading: no row to press, and none of the three sentences that would
  // explain an empty list. The placeholder rows carry neither, which is the
  // finding below rather than something to assert on.
  expect(queryAllByRole("option")).toHaveLength(0);
  expect(queryAllByText(/一个仓库也看不见/)).toHaveLength(0);
  expect(queryAllByText(/一个仓库都看不到/)).toHaveLength(0);
});

test("each repository lands as its own pressable row, marked with what pressing it would do", async () => {
  stubRepos({
    installations: [{ id: 1, account: "pamin-labs", kind: "Organization" }],
    selected: 1,
    installUrl: "https://github.com/apps/orch/installations/new",
    repos: [
      repo(),
      repo({ fullName: "pamin-labs/beta", private: true }),
      repo({ fullName: "pamin-labs/gamma", taken: { id: 7, name: "gamma" } }),
    ],
  });
  const { findByRole, getByRole, getByText } = render(<FirstProject onAdded={() => {}} onSettings={() => {}} />);

  // The owner is dropped from the row: thirty rows all starting `pamin-labs/`
  // spend their first eleven columns saying the one thing they share.
  const alpha = await findByRole("option", { name: /alpha/ });
  expect(alpha.textContent).toContain("今天");
  expect(alpha.textContent).toContain("添加 · main");
  // A private repository says so on its row, and a public one does not.
  expect(getByRole("option", { name: /beta/ }).textContent).toContain("私有");
  expect(alpha.textContent).not.toContain("私有");
  // Already a project: the row goes somewhere instead of adding again.
  expect(getByRole("option", { name: /gamma/ }).textContent).toContain("已添加");
  getByText("3 个仓库，最近动过的在前");
  // The account whose repositories these are is named once, at the top.
  getByText("pamin-labs");
});

test("the picker dialog is present through its portal only while it is open", async () => {
  stubRepos();
  const { getByRole, queryAllByRole, queryByRole, rerender } = render(
    <Picker open={false} onOpenChange={() => {}} onAdded={() => {}} onSettings={() => {}} />,
  );
  expect(queryAllByRole("dialog")).toHaveLength(0);

  rerender(<Picker open onOpenChange={() => {}} onAdded={() => {}} onSettings={() => {}} />);
  const dialog = await waitFor(() => {
    const found = queryByRole("dialog");
    if (!found) throw new Error("the dialog never reached the document");
    return found;
  });
  // Radix names the dialog from its title; a dialog with no accessible name is
  // one a screen reader announces as nothing.
  expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
  getByRole("heading", { name: "选择仓库" });
  getByRole("button", { name: "取消" });
});
