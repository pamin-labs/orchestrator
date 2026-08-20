import { expect, test } from "bun:test";
import { LANGUAGE_SUGGESTIONS } from "../../web/src/features/knobs/editors.tsx";

/**
 * The panel's source language is English; Chinese lives in `web/src/locales`.
 *
 * A literal left behind is caught by nothing else: it renders, it reads fine to
 * whoever wrote it, and it is simply absent from every catalog — so the English
 * panel shows one Chinese sentence in the middle of a pane while the README's
 * translation table still says 100%.
 */
/**
 * Two kinds of Chinese are not copy. `LANGUAGE_SUGGESTIONS` is what `output.language` is
 * set to — an instruction to a model — exempted by membership rather than by
 * file, so a new literal in that same file still fails. The rest name themselves
 * with `i18n-exempt` and say why on the line above, which is where a reader will
 * be standing when they ask.
 */
const CJK = /[一-鿿　-〿＀-￯]/;
const EXEMPT = /i18n-exempt/;
/** Already a message: the macro carries it into the catalog. */
const WRAPPED = /(?:\bt`|\bmsg`|<Trans\b|<Plural\b)/;

/**
 * An exemption covers the declaration it introduces rather than a fixed number
 * of lines — the alias table it was first written for is sixteen rows long — so
 * it runs to the first line that closes a block at column zero.
 */
function exemptLines(lines: string[]): Set<number> {
  const out = new Set<number>();
  for (const [i, line] of lines.entries()) {
    if (!EXEMPT.test(line)) continue;
    let end = i + 1;
    while (end < lines.length && !/^[)\]}]/.test(lines[end] ?? "")) end++;
    for (let n = i; n <= end; n++) out.add(n);
  }
  return out;
}

/** Comments are prose about the code and stay in whatever they were written in;
 *  the transpiler drops them, which is the cheapest way to see only code. */
function offendingLines(source: string, loader: "ts" | "tsx", allowed: Set<string>): number[] {
  const code = new Bun.Transpiler({ loader }).transformSync(source);
  const lines = source.split("\n");
  const exempt = exemptLines(lines);
  const found: number[] = [];
  for (const [i, line] of lines.entries()) {
    if (!CJK.test(line) || WRAPPED.test(line) || exempt.has(i)) continue;
    if (!code.includes(line.trim().slice(0, 20))) continue;
    if (allowed.has(line.trim().replace(/^"|",?$/g, ""))) continue;
    found.push(i + 1);
  }
  return found;
}

test("no Chinese literal is left in web/src", async () => {
  const allowed = new Set<string>(LANGUAGE_SUGGESTIONS);
  const offenders: string[] = [];
  for (const file of new Bun.Glob("web/src/**/*.{ts,tsx}").scanSync(".")) {
    const source = await Bun.file(file).text();
    const loader = file.endsWith(".tsx") ? "tsx" : "ts";
    for (const line of offendingLines(source, loader, allowed)) offenders.push(`${file}:${line}`);
  }
  expect(offenders).toEqual([]);
});
