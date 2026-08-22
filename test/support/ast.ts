import { parseSync, traverse } from "@babel/core";
import { readFileSync } from "node:fs";

/**
 * A file parsed for a governance guard, and nothing else.
 *
 * Four of them parse `src` or `web/src` and walk what comes back, and each had
 * written out the same four options — including `configFile: false`, which is
 * what keeps a stray `babel.config.js` from changing what a guard sees, and the
 * `jsx` plugin, which must be off for `.ts` or a generic arrow reads as an
 * unclosed tag.
 */
export const parse = (file: string, source: string) =>
  parseSync(source, {
    filename: file,
    configFile: false,
    babelrc: false,
    parserOpts: { plugins: file.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"] },
  });

/**
 * Han, kana, hangul and the fullwidth forms — one class, because the guards
 * that use it disagreed about kana and hangul for no reason either could state.
 * `chain.ts` carries a Japanese escalation pattern and `editors.tsx` the
 * endonyms, so both scripts have to be visible; what makes those legal is an
 * exemption, not a blind spot.
 */
/** Exported for `docs-and-config-speak-english`, which scans YAML and Markdown —
 *  neither of which babel parses — and must ask the same question of them. */
export const CJK = /[一-鿿ぁ-ヿ가-힯　-〿＀-￯]/;

/**
 * Every file a pattern matches, run through one `offenders`.
 *
 * Seven guards spelled this loop, four of them with `await Bun.file(...).text()`
 * for no reason — the scan is synchronous and so is every `offenders`. One place
 * also means one place for `scanners-scan.test.ts` to read the pattern out of,
 * which is the test that exists because a guard scanning nothing passes for ever.
 */
export const scan = (pattern: string, offenders: (file: string, source: string) => string[]): string[] =>
  [...new Bun.Glob(pattern).scanSync(".")].flatMap((file) => offenders(file, readFileSync(file, "utf8")));

/** One CJK hit: where it is, what it says, whether it is a comment, and whether
 *  a declaration it sits inside is marked `i18n-exempt`. */
export interface CjkHit {
  line: number;
  text: string;
  comment: boolean;
  exempt: boolean;
}

const EXEMPT = /i18n-exempt/;

/**
 * Every Chinese-script literal and comment in one file.
 *
 * Two guards walked the same four node types over the same `CJK` class and
 * disagreed only in what they did with a hit — one lists them, one counts them.
 * They had already drifted once: `RegExpLiteral` is not a `StringLiteral`, a
 * `TemplateElement` or a `JSXText`, so the panel's guard could not see
 * `/(花钱|付费|采购|订阅|预算|密钥)/` until the server's pointed it out. Exemptions
 * stay with the callers, which is the one thing the two really do differently.
 */
/**
 * `exempt` is the declaration the marker is written on, from babel's own
 * `leadingComments`, rather than a line range guessed from the source.
 *
 * The rule it replaced ran "from the marker to the first blank line or the first
 * line starting with `)`, `]` or `}`" — invented for one sixteen-row alias table,
 * applied to a whole tree, and its own comment recorded it over-reaching in
 * `ui/attach.ts` and taking a function's literals with it. A comment attaches to
 * exactly one node and that node has a range, so there is nothing to guess.
 */
export function cjkHits(file: string, source: string): CjkHit[] {
  const ast = parse(file, source);
  if (!ast) return [];
  const raw: Omit<CjkHit, "exempt">[] = [];
  const marked: [number, number][] = [];
  const hit = (node: { loc?: { start: { line: number } } | null }, text: string, comment = false) => {
    if (CJK.test(text)) raw.push({ line: node.loc?.start.line ?? 0, text, comment });
  };
  traverse(ast, {
    enter(p) {
      const loc = p.node.loc;
      if (loc && p.node.leadingComments?.some((c) => EXEMPT.test(c.value))) marked.push([loc.start.line, loc.end.line]);
    },
    StringLiteral: (p) => hit(p.node, p.node.value),
    JSXText: (p) => hit(p.node, p.node.value),
    TemplateElement: (p) => hit(p.node, p.node.value.cooked ?? p.node.value.raw),
    RegExpLiteral: (p) => hit(p.node, p.node.pattern),
  });
  for (const c of ast.comments ?? []) hit(c, c.value, true);
  return raw.map((h) => ({
    ...h,
    // A comment says whether it is exempt itself; a literal is exempt because a
    // declaration around it says so.
    exempt: h.comment ? EXEMPT.test(h.text) : marked.some(([from, to]) => h.line >= from && h.line <= to),
  }));
}
