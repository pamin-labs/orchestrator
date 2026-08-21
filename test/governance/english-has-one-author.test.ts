import { expect, test } from "bun:test";
import { parseSync, traverse } from "@babel/core";
import { readFileSync } from "node:fs";

/**
 * The English of a server-named message is written once, in `msg({ id, message })`.
 *
 * Under an explicit id, `en` is a translation like any other: `lingui extract`
 * writes `msgstr` for an id it has never seen and leaves an existing one alone.
 * So rewording the `message` beside the id changes what the panel renders and
 * **not** what `en.po` holds — and the server renders from `MESSAGES.en`, which
 * is generated from `en.po`. The two languages of one sentence, again.
 */
/**
 * Red means the two have parted, in whichever direction. Fix it by hand: edit
 * `en.po`'s `msgstr` to match, or delete that entry and re-run
 * `bun run i18n:extract` to have it rewritten, then `bun run i18n:messages`.
 */
const declared = (file: string): Array<[string, string]> => {
  const ast = parseSync(readFileSync(file, "utf8"), {
    filename: file,
    configFile: false,
    babelrc: false,
    parserOpts: { plugins: file.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"] },
  });
  const found: Array<[string, string]> = [];
  if (!ast) return found;
  traverse(ast, {
    CallExpression(path) {
      const { callee, arguments: args } = path.node;
      if (callee.type !== "Identifier" || callee.name !== "msg") return;
      const [arg] = args;
      if (arg?.type !== "ObjectExpression") return;
      const of = (key: string): string | undefined => {
        for (const property of arg.properties) {
          if (property.type !== "ObjectProperty" || property.key.type !== "Identifier") continue;
          if (property.key.name === key && property.value.type === "StringLiteral") return property.value.value;
        }
        return undefined;
      };
      const id = of("id");
      const message = of("message");
      if (id !== undefined && message !== undefined) found.push([id, message]);
    },
  });
  return found;
};

/**
 * `msgid`/`msgstr` pairs. A `msgstr` continues over bare `"…"` lines when the
 * message holds a newline, and reading only the first line reports drift on a
 * message nobody touched — which is what the first run of this test did.
 */
function catalog(path: string): Map<string, string> {
  const unescape = (raw: string) => raw.slice(1, -1).replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c));
  const lines = readFileSync(path, "utf8").split("\n");
  const out = new Map<string, string>();
  const from = (i: number): string => {
    let text = "";
    for (let n = i; n < lines.length && lines[n]?.startsWith('"'); n++) text += unescape(lines[n]!);
    return text;
  };
  for (const [i, line] of lines.entries()) {
    if (!line.startsWith('msgid "') || !lines[i + 1]?.startsWith('msgstr "')) continue;
    out.set(unescape(line.slice(6)), unescape(lines[i + 1]!.slice(7)) + from(i + 2));
  }
  return out;
}

test("every explicit id says the same English in its source and in en.po", () => {
  const en = catalog("web/src/locales/en.po");
  const parted = [...new Bun.Glob("web/src/**/*.{ts,tsx}").scanSync(".")]
    .flatMap(declared)
    .filter(([id, message]) => en.get(id) !== message)
    .map(
      ([id, message]) =>
        `${id}\n  source: ${message.slice(0, 72)}\n  en.po:  ${(en.get(id) ?? "«absent»").slice(0, 72)}`,
    );
  expect(parted).toEqual([]);
});
