import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { cleanup, render } from "../support/render.tsx";
import { emptyState } from "../../web/src/shared/api.ts";
import { TipRoot } from "../../web/src/ui/tooltip.tsx";
import { UsageBar } from "../../web/src/features/usage/view.tsx";
import { Home } from "../../web/src/features/home/view.tsx";

/**
 * testing-library's own `afterEach(cleanup)` is registered when its module is
 * evaluated, and `bun test` scopes the lifecycle globals per file — so that hook
 * belongs to whichever file imported it first, and every later file kept the
 * previous one's nodes in `document.body`. Each file registers its own.
 */
afterEach(cleanup);

test("Home renders a fresh project as an actionable row", () => {
  const state = emptyState();
  state.projects.push({
    id: 1,
    name: "orchestrator",
    repo_path: "pamin-labs/orchestrator",
    remote: "https://github.com/pamin-labs/orchestrator",
    base_branch: "main",
  });
  const { getByRole, getByText } = render(
    createElement(Home, {
      st: state,
      onEnter: () => {},
      onOpen: () => {},
      onNew: () => {},
      onAdd: () => {},
      refresh: () => {},
    }),
  );
  getByText("orchestrator");
  getByText("pamin-labs/orchestrator");
  // Actionable means a control, not a line of text that reads like one.
  getByRole("button", { name: "＋ 新需求" });
});

test("Usage renders known, hot and stale subscription windows", () => {
  const { getAllByText, getByText } = render(
    createElement(
      TipRoot,
      null,
      createElement(UsageBar, {
        usage: [
          { runtime: "claude", at: Date.now(), fiveHourPercent: 81, weeklyPercent: 20 },
          { runtime: "codex", at: 0, error: "unreachable" },
        ],
      }),
    ),
  );
  getByText("claude");
  getByText("codex");
  // 81% is over the line, so its label is the one wearing the warning.
  expect(getByText("5h").className).toContain("text-warn");
  // The account that could not be read says so on both of its windows.
  expect(getAllByText("?")).toHaveLength(2);
});
