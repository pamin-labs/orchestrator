/**
 * `import x from "./y.wasm" with { type: "file" }` is Bun's documented way to
 * put a file inside a single-file executable: the import evaluates to a path,
 * and `bun build --compile` carries the bytes so `Bun.file(path)` reads them
 * from `/$bunfs` when there is no disk copy. `bun-types/extensions.d.ts`
 * declares `*.txt`, `*.toml`, `*.yaml` and `*.html` this way but not `*.wasm`,
 * so without this TypeScript cannot resolve the grammar imports in
 * `symbols.ts`.
 */
declare module "*.wasm" {
  const path: string;
  export default path;
}
