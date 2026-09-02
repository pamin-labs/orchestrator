import { traverse } from "@babel/core";
import { expect, test } from "bun:test";
import { parse, scan } from "../support/ast.ts";

/**
 * A test that boots the real server names its own sandbox address.
 *
 * `start()` merges its overrides over `loadConfig()`, whose sandbox server is
 * `127.0.0.1:8080` — nothing in CI, and a real server on the machine of anyone
 * who runs this product. The smoke test booted onto it and the server did what
 * it is supposed to do: warmed a container for the project it found.
 */
/**
 * One agent container and one egress container per full-suite run, ~310 MB each,
 * with a 24-hour TTL and a row recorded only in a schema the test then drops.
 * Nine were up before anyone looked, and the machine was out of memory. CI has
 * nothing on 8080, so every one of those runs was green.
 */
test("a test that boots the real server does not inherit the developer's sandbox address", () => {
  const offenders = scan("test/**/*.test.ts", (file, source) => {
    const ast = parse(file, source);
    if (!ast) return [];
    const found: string[] = [];
    traverse(ast, {
      CallExpression(p) {
        const { callee, arguments: args } = p.node;
        if (callee.type !== "Identifier" || callee.name !== "start") return;
        // Only an object written at the call site can be read here, which is how
        // every `start()` in this tree is written.
        const first = args[0];
        if (first?.type !== "ObjectExpression") return;
        const named = first.properties.some(
          (prop) => prop.type === "ObjectProperty" && prop.key.type === "Identifier" && prop.key.name === "sandbox",
        );
        if (!named) found.push(`${file}:${p.node.loc?.start.line ?? 0} boots on the configured sandbox server`);
      },
    });
    return found;
  });

  expect(offenders).toEqual([]);
});
