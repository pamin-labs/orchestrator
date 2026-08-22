import { linguiCatalogs } from "./lingui-catalogs.ts";
import { linguiMacros } from "./lingui-macros.ts";

/**
 * The two Lingui plugins, for anything run straight from the checkout.
 *
 * `bun run src/composition/server.ts` has no bundler between it and the source,
 * so a `msg` template reaches the runtime unexpanded — which is a `throw` at
 * module scope, not a compile error. The release binary gets the same two
 * plugins from `scripts/build-server.ts`, and `bun test` from
 * `test/support/loader.ts`.
 */
/**
 * Named in `bunfig.toml`'s **top-level** `preload`, which is read for `bun run`
 * and not for `bun test` — measured, by counting evaluations under each. That
 * separation is what keeps this from registering an `onLoad` ahead of the test
 * loader's: Bun does not chain them, so the first handler for a path wins and a
 * second registration would silently take coverage instrumentation out.
 */
// `void`: `Bun.plugin` returns a promise for an async `setup`, and neither of
// these has one.
void Bun.plugin(linguiMacros);
void Bun.plugin(linguiCatalogs);
