import { expect, test } from "bun:test";
import { createRequire } from "node:module";

/**
 * The extractor finds the panel from the config, not from wherever it was run.
 *
 * `@lingui/conf` defaults `rootDir` to the directory holding the config, and
 * `catalogs[].path` / `include` only inherit it when written as `<rootDir>/…`.
 * Left relative they resolve against `process.cwd()`, so `lingui extract` from
 * anywhere but the repository root finds zero messages — and exits 0.
 */
/**
 * The script carries `--clean`, where "found zero" means "all 811 are
 * obsolete". Measured from `scripts/` before the fix: every locale reported 0/0
 * and the command succeeded.
 */
const load = createRequire(import.meta.url) as <T>(id: string) => T;

const CONFIG = `${process.cwd()}/scripts/lingui.config.js`;

test("the resolved catalog paths are absolute, so a wrong cwd cannot empty them", () => {
  // Through `getConfig`, because what matters is what the extractor is handed
  // after substitution — `<rootDir>` in the source is only how it gets there.
  const { getConfig } = load<typeof import("@lingui/conf")>("@lingui/conf");
  const config = getConfig({ configPath: CONFIG });

  const catalog = config.catalogs[0];
  expect(catalog).toBeDefined();
  for (const path of [catalog!.path, ...catalog!.include]) {
    expect(path).toStartWith("/");
    // The catalogues left `web/src` when the server started reading them: `web/**`
    // is a Fallow zone the server may not import from.
    expect(path).toMatch(/\/(locales|web\/src|src)\b/);
    // Not `scripts/web/src`, which is where a `rootDir` left at its default puts them.
    expect(path).not.toContain("/scripts/");
  }
});
