import { expect, test } from "bun:test";
import { traverse } from "@babel/core";
import { parse, scan } from "../support/ast.ts";
import { readFileSync } from "node:fs";

/**
 * A translated string only updates on a locale change if something in its tree
 * is subscribed to the catalog.
 *
 * `I18nProvider` re-renders on `i18n.activate`, but its `children` is the same
 * element reference the parent rendered last time, so React bails out of the
 * subtree. What actually re-renders is a context consumer: `<Trans>`, or a
 * component calling `useLingui()`. The global `t` from `@lingui/core/macro`
 * compiles to `i18n._()` against the module singleton and consumes nothing.
 */
/**
 * `App` holds the root subscription, so one `activate` re-renders the panel —
 * except through a `React.memo`, which is the one thing that stops a parent's
 * re-render from reaching a child. A memoised component that translates must
 * therefore subscribe on its own.
 */

const SUBSCRIBES = /useLingui\(|<Trans\b|<Plural\b|<Select\b|<SelectOrdinal\b/;
const TRANSLATES = /\bt`|\bt\(\{|i18n\._\(/;

/**
 * The source of each `memo(...)` call.
 *
 * Parsed rather than scanned for parentheses. The hand-matched version had to
 * exclude `useMemo` by looking at the character before the `m`, and both
 * patterns above were tested against a slice that still held the file's comments
 * and string literals — a comment mentioning `useLingui()` above a memoised
 * component satisfied `SUBSCRIBES`. `p.get("arguments.0")` is the argument and
 * nothing else.
 */
function memoBodies(file: string, source: string): string[] {
  const ast = parse(file, source);
  if (!ast) return [];
  const out: string[] = [];
  traverse(ast, {
    CallExpression(p) {
      const callee = p.node.callee;
      const named =
        (callee.type === "Identifier" && callee.name === "memo") ||
        (callee.type === "MemberExpression" &&
          callee.property.type === "Identifier" &&
          callee.property.name === "memo");
      if (!named) return;
      const arg = p.node.arguments[0];
      const { start, end } = arg ?? {};
      if (typeof start === "number" && typeof end === "number") out.push(source.slice(start, end));
    },
  });
  return out;
}

test("App subscribes, so one activate re-renders the panel", () => {
  expect(SUBSCRIBES.test(readFileSync("web/src/app/app.tsx", "utf8"))).toBe(true);
});

const offenders = (file: string, source: string): string[] =>
  memoBodies(file, source)
    .filter((body) => TRANSLATES.test(body) && !SUBSCRIBES.test(body))
    .map((_body, n) => `${file} memo #${n + 1}`);

test("a memoised component that translates subscribes on its own", () => {
  expect(scan("web/src/**/*.tsx", offenders)).toEqual([]);
});

/** Shown firing, and shown quiet on the shape it must not fire on. */
test("it reads the argument and not the file around it", () => {
  const memoised = (inner: string) => `import { memo } from "react";\nexport const P = memo(${inner});`;
  expect(offenders("p.tsx", memoised("() => <p>{t`Skills`}</p>"))).toHaveLength(1);
  expect(offenders("p.tsx", memoised("() => { const { t } = useLingui(); return <p>{t`Skills`}</p>; }"))).toEqual([]);
  // `useMemo` is not `memo`, and a comment is not a subscription — the version
  // that matched parentheses got the first wrong by looking at one character and
  // the second by slicing the source instead of reading the argument.
  expect(offenders("p.tsx", "const v = useMemo(() => t`Skills`, []);")).toEqual([]);
  const commented = `// useLingui() lives in the parent\n${memoised("() => <p>{t`Skills`}</p>")}`;
  expect(offenders("p.tsx", commented)).toHaveLength(1);
});
