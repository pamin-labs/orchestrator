import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "../support/render.tsx";
import { i18n, startLocale } from "../../web/src/i18n.ts";
import { Timeline } from "../../web/src/features/timeline/view.tsx";
import { emptyState } from "../../web/src/shared/api.ts";
import { LOCALES } from "../../src/contracts/config.ts";
import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * Every shipped catalog, fetched the way the browser fetches it and rendered.
 *
 * `i18n:validate` proves each message parses as ICU and the README's table
 * counts non-empty values, but neither puts a catalog in front of React: a
 * locale missing from `CATALOGS` is a language the picker offers and the panel
 * cannot load. So this goes through `startLocale` rather than `i18n.load` —
 * handing the JSON over directly would test the file and skip the wiring that
 * decides whether the file is ever read.
 */

/** The heading of the pane below, and the id the macro hashed it to. */
const HEADING = "cfg2rE";

/** Only the field this file asserts on; `z.object` drops the rest. */
const Catalog = z.record(z.string(), z.object({ translation: z.string() }));

const translationOf = (locale: string, id: string): string => {
  const file = Catalog.parse(JSON.parse(readFileSync(`web/src/locales/${locale}.json`, "utf8")));
  return file[id]?.translation ?? "";
};

afterEach(() => {
  cleanup();
  localStorage.clear();
  i18n.activate("zh");
});

test.each(LOCALES.filter((l) => l !== "en"))("the %s catalog reaches the screen", async (locale) => {
  const want = translationOf(locale, HEADING);
  // A catalog that lost this entry would otherwise pass by falling back to English.
  expect(want).not.toBe("");

  localStorage.setItem("orch.locale", locale);
  await startLocale();
  expect(i18n.locale).toBe(locale);

  const { getByRole } = render(<Timeline st={emptyState()} frames={[]} grpId={null} projectId={null} />);
  expect(getByRole("heading").textContent).toContain(want);
});
