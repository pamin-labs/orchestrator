import { expect, test } from "bun:test";
import { parseSync, traverse } from "@babel/core";
import { LANGUAGE_SUGGESTIONS } from "../../web/src/features/knobs/editors.tsx";

/**
 * The panel's source language is English; Chinese lives in `locales/`.
 *
 * A literal left behind is caught by nothing else: it renders, it reads fine to
 * whoever wrote it, and it is simply absent from every catalog — so the English
 * panel shows one Chinese sentence in the middle of a pane while the README's
 * progress bars still say 100%.
 */
/**
 * Parsed, not grepped. The first version of this test skipped any line missing
 * from the transpiler's output, meaning to skip comments — but JSX does not
 * survive transpilation as source text either, so it could not see a single
 * Chinese string inside a `<Trans>`. It passed while `{repoPath} 的 {groups}
 * 个需求` sat in a settings pane, and passed again on an injected
 * `<Trans>项目列表</Trans>`. Comments are dropped by the parser instead.
 */
/**
 * `RegExpLiteral` too, which `server-speaks-one-language.test.ts` pointed out
 * this test could not see. A pattern is where a translation breaks *behaviour*
 * rather than reading oddly, and there are two live ones — both matching text
 * the server hardcodes, so both are protocol and both say so where they sit.
 */
const CJK = /[一-鿿　-〿＀-￯]/;
const EXEMPT = /i18n-exempt/;

/** Data, not copy: `LANGUAGE_SUGGESTIONS` is what `output.language` is set to —
 *  an instruction to a model — exempted by membership rather than by file, so a
 *  new literal in that same file still fails. */
const allowed = new Set<string>(LANGUAGE_SUGGESTIONS);

/** Lines an `i18n-exempt` comment covers: from the comment to the first blank
 *  line or the first line that closes a block at column zero. The bracket rule
 *  is for the sixteen-row alias table it was written for; without the blank-line
 *  rule a one-line exemption in `ui/attach.ts` reached the next `}` and took a
 *  whole function's literals with it. */
function exemptLines(source: string): Set<number> {
  const lines = source.split("\n");
  const out = new Set<number>();
  for (const [i, line] of lines.entries()) {
    if (!EXEMPT.test(line)) continue;
    let end = i + 1;
    while (end < lines.length && (lines[end] ?? "").trim() !== "" && !/^[)\]}]/.test(lines[end] ?? "")) end++;
    for (let n = i; n <= end; n++) out.add(n + 1);
  }
  return out;
}

function offenders(file: string, source: string): string[] {
  const ast = parseSync(source, {
    filename: file,
    configFile: false,
    babelrc: false,
    parserOpts: { plugins: file.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"] },
  });
  if (!ast) return [];
  const exempt = exemptLines(source);
  const found: string[] = [];
  const report = (line: number, text: string) => {
    if (exempt.has(line) || allowed.has(text.trim())) return;
    found.push(`${file}:${line} ${JSON.stringify(text.trim().slice(0, 40))}`);
  };
  traverse(ast, {
    StringLiteral(p) {
      if (CJK.test(p.node.value)) report(p.node.loc?.start.line ?? 0, p.node.value);
    },
    JSXText(p) {
      if (CJK.test(p.node.value)) report(p.node.loc?.start.line ?? 0, p.node.value);
    },
    TemplateElement(p) {
      const raw = p.node.value.cooked ?? "";
      if (CJK.test(raw)) report(p.node.loc?.start.line ?? 0, raw);
    },
    RegExpLiteral(p) {
      if (CJK.test(p.node.pattern)) report(p.node.loc?.start.line ?? 0, p.node.pattern);
    },
  });
  return found;
}

test("no Chinese literal is left in web/src", async () => {
  const all: string[] = [];
  for (const file of new Bun.Glob("web/src/**/*.{ts,tsx}").scanSync(".")) {
    all.push(...offenders(file, await Bun.file(file).text()));
  }
  expect(all).toEqual([]);
});
