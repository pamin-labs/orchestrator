/**
 * `.po` catalogs are modules, because `scripts/lingui-catalogs.ts` compiles them
 * into one before anything imports them — the same shape `@lingui/vite-plugin`
 * produces for Vite.
 *
 * `Messages` inline rather than a top-level import: an `import` statement here
 * would make this file a module, and `declare module` inside a module is not
 * ambient — the declarations stop applying to the rest of the project.
 */
declare module "*.po" {
  export const messages: import("@lingui/core").Messages;
}
