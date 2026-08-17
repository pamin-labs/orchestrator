import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { emptyState } from "../web/src/lib/api.ts";
import { TipRoot } from "../web/src/ui/tooltip.tsx";
import { UsageBar } from "../web/src/ui/usage.tsx";
import { Home } from "../web/src/views/home.tsx";

test("Home renders a fresh project as an actionable row", () => {
  const state = emptyState();
  state.projects.push({
    id: 1,
    name: "orchestrator",
    repo_path: "pamin-labs/orchestrator",
    remote: "https://github.com/pamin-labs/orchestrator",
    base_branch: "main",
  });
  const html = renderToStaticMarkup(
    createElement(Home, {
      st: state,
      onEnter: () => {},
      onOpen: () => {},
      onNew: () => {},
      onAdd: () => {},
      refresh: () => {},
    }),
  );
  expect(html).toContain("orchestrator");
  expect(html).toContain("＋ 新需求");
  expect(html).toContain("pamin-labs/orchestrator");
});

test("Usage renders known, hot and stale subscription windows", () => {
  const html = renderToStaticMarkup(
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
  expect(html).toContain("claude");
  expect(html).toContain("codex");
  expect(html).toContain("5h");
  expect(html).toContain("?");
});
