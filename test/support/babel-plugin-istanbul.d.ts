/**
 * `babel-plugin-istanbul` ships no types and has no `@types` package.
 *
 * Declared as a `PluginItem` rather than `any` so the plugin list in
 * `coverage.ts` is still checked against babel's own signature — the thing worth
 * catching here is passing it where babel expects something else, not the shape
 * of its internals.
 */
declare module "babel-plugin-istanbul" {
  import type { PluginObj } from "@babel/core";

  const plugin: PluginObj;
  export default plugin;
}
