import { expect, test } from "bun:test";
import { scan } from "../support/ast.ts";

/**
 * `<Trans>` reads its catalog from context, so a pane mounted outside
 * `I18nProvider` throws — "Trans component was rendered without I18nProvider",
 * from inside a component that looks nothing like the test that mounted it.
 *
 * `test/support/render.tsx` wraps every render in the provider. One file reached
 * past it to `@testing-library/react` and broke the day the composer's first
 * macro landed, which is the day this check would have named the cause.
 */
// `act`, `waitFor` and friends are stateless helpers and travel fine; it is
// `render` that has to carry the provider with it.
const REACHES_PAST = /import\s*{[^}]*\brender\b[^}]*}\s*from\s*"@testing-library\/react"/;

const offenders = (file: string, source: string): string[] =>
  file !== "test/support/render.tsx" && REACHES_PAST.test(source) ? [file] : [];

test("web tests mount panes through support/render, which supplies the catalog", () => {
  expect(scan("test/**/*.{ts,tsx}", offenders)).toEqual([]);
});
