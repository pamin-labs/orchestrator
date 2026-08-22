import { expect, test } from "bun:test";
import { cjkHits, scan } from "../support/ast.ts";
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
 * `requirements`` sat in a settings pane, and passed again on an injected
 * `<Trans>项目列表</Trans>`. Comments are dropped by the parser instead.
 */
/**
 * `RegExpLiteral` too, which `server-speaks-one-language.test.ts` pointed out
 * this test could not see. A pattern is where a translation breaks *behaviour*
 * rather than reading oddly, and there are two live ones — both matching text
 * the server hardcodes, so both are protocol and both say so where they sit.
 */
/** Data, not copy: `LANGUAGE_SUGGESTIONS` is what `output.language` is set to —
 *  an instruction to a model — exempted by membership rather than by file, so a
 *  new literal in that same file still fails. */
const allowed = new Set<string>(LANGUAGE_SUGGESTIONS);

/** `cjkHits` resolves `i18n-exempt` against the declaration the marker is
 *  written on. What is left here is the one exemption that is not a marker:
 *  membership of `LANGUAGE_SUGGESTIONS`, so a new literal in that same file
 *  still fails. */
const offenders = (file: string, source: string): string[] =>
  cjkHits(file, source)
    .filter((h) => !h.exempt && !allowed.has(h.text.trim()))
    .map((h) => `${file}:${h.line} ${JSON.stringify(h.text.trim().slice(0, 40))}`);

test("no Chinese literal is left in web/src", () => {
  expect(scan("web/src/**/*.{ts,tsx}", offenders)).toEqual([]);
});
