import { expect, test } from "bun:test";

/**
 * `<Trans>` reads its catalog from context, so a pane mounted outside
 * `I18nProvider` throws — "Trans component was rendered without I18nProvider",
 * from inside a component that looks nothing like the test that mounted it.
 *
 * `test/support/render.tsx` wraps every render in the provider. One file reached
 * past it to `@testing-library/react` and broke the day the composer's first
 * macro landed, which is the day this check would have named the cause.
 */
test("web tests mount panes through support/render, which supplies the catalog", async () => {
  const offenders: string[] = [];
  for (const file of new Bun.Glob("test/**/*.{ts,tsx}").scanSync(".")) {
    if (file === "test/support/render.tsx") continue;
    const source = await Bun.file(file).text();
    // `act`, `waitFor` and friends are stateless helpers and travel fine; it is
    // `render` that has to carry the provider with it.
    if (/import\s*{[^}]*\brender\b[^}]*}\s*from\s*"@testing-library\/react"/.test(source)) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});
