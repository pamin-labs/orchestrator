import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FirstProject } from "../../web/src/views/picker.tsx";

test("the first-project repository picker exposes its heading, action and loading rows", () => {
  const first = renderToStaticMarkup(<FirstProject onAdded={() => {}} onSettings={() => {}} />);
  expect(first).toContain("添加第一个项目");
  expect(first).toContain("点一行就添加");
  expect(first).toContain("breathe");
});
