import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Notes } from "../web/src/views/notes.tsx";

test("notes have a renderable loading state", () => {
  expect(renderToStaticMarkup(createElement(Notes, { projectId: 1 }))).toContain("读记录");
});
