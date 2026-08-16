import { expect, test } from "bun:test";

const SOURCE_ROOTS = ["src", "web/src", "test"];
const NON_CODE = /(["'`])(?:\\[\s\S]|(?!\1)[^\\])*\1|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

test("protocol and test boundaries do not erase validation with z.unknown", async () => {
  const zodEscapeHatches: string[] = [];
  for (const root of SOURCE_ROOTS) {
    for (const pattern of ["**/*.ts", "**/*.tsx"]) {
      for await (const path of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
        const code = (await Bun.file(`${root}/${path}`).text()).replace(NON_CODE, "");
        if (/\bz\s*\.\s*unknown\s*\(/.test(code)) zodEscapeHatches.push(`${root}/${path}`);
      }
    }
  }
  expect(zodEscapeHatches).toEqual([]);
});
