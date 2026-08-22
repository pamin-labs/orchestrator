import { expect, test } from "bun:test";
import { parseSync, traverse } from "@babel/core";
import { readdirSync, readFileSync } from "node:fs";
import BASELINE from "./server-chinese-baseline.json";

/**
 * `src/` still carries hardcoded Chinese literals, and this test does not fix
 * that. It stops them growing. The count lives in `server-chinese-baseline.json`
 * rather than here, so it cannot go stale: it was 407 across 36 files when this
 * was written and the file is what says where it is now.
 *
 * The panel is translated into nine languages and the server is not, so a Korean
 * reader gets a Korean pane with `服务器开了鉴权，我们没带密钥` inside it.
 */
/**
 * `RegExpLiteral` as well as strings, and that is the part worth copying — a
 * regular expression is not a `StringLiteral`, a `TemplateElement` or a `JSXText`,
 * so a scan without it cannot see `/(花钱|付费|采购|订阅|预算|密钥)/` in `chain.ts`,
 * the pattern deciding which questions must reach a person. Regexes are exactly
 * the literals where a translation breaks behaviour rather than reading oddly.
 * `panel-speaks-english.test.ts` visits it too now.
 */
const CJK = /[一-鿿ぁ-ヿ가-힯　-〿＀-￯]/;
const ROOT = `${process.cwd()}/src`;

/**
 * No exemption any more.
 *
 * A generated `messages.generated.ts` used to sit under `src/` holding nine
 * languages of catalog, so this ratchet would have read the fix as the defect.
 * The catalogues are `.po` files the server imports now, and `src/` is back to
 * being one language of source with nothing to carve out.
 */
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith(".ts") ? [`${dir}/${e.name}`] : [],
  );

/** Parsed, not grepped, so a comment in Chinese is not a finding. */
function countIn(path: string): number {
  const ast = parseSync(readFileSync(path, "utf8"), {
    filename: path,
    configFile: false,
    babelrc: false,
    parserOpts: { plugins: ["typescript"] },
  });
  if (!ast) return 0;
  let n = 0;
  traverse(ast, {
    StringLiteral: (p) => void (CJK.test(p.node.value) && n++),
    TemplateElement: (p) => void (CJK.test(p.node.value.raw) && n++),
    RegExpLiteral: (p) => void (CJK.test(p.node.pattern) && n++),
  });
  // Comments count too, and they were 172 of the 265 this file found when that
  // was added. `AGENTS.md`'s first coding rule is English for comments — and by
  // the time the panel's source language was English, a comment naming `To do` or
  // `Cost` pointed at a label no longer in the source, so a reader searching for
  // one found nothing. Counted per comment rather than per line: a block that
  // wraps is one decision.
  for (const c of ast.comments ?? []) if (CJK.test(c.value)) n++;
  return n;
}

const baseline = BASELINE as Record<string, number>;

test("no file under src grows its count of Chinese literals", () => {
  const grew: string[] = [];
  const shrank: string[] = [];
  for (const path of walk(ROOT)) {
    const file = path.slice(ROOT.length + 1);
    const now = countIn(path);
    const was = baseline[file] ?? 0;
    if (now > was) grew.push(`${file}: ${was} → ${now}`);
    if (now < was) shrank.push(`${file}: ${was} → ${now}`);
  }
  // Growing is the failure this exists for: a new hardcoded sentence is one more
  // string a Korean reader will meet in Chinese.
  expect(grew).toEqual([]);
  // Shrinking is the work, and the baseline has to follow it down — or the file
  // it was fixed in silently reopens the same room it was closed out of.
  expect(shrank).toEqual([]);
});

test("a file with no baseline entry may not introduce one", () => {
  const fresh = walk(ROOT)
    .map((p) => p.slice(ROOT.length + 1))
    .filter((f) => !(f in baseline) && countIn(`${ROOT}/${f}`) > 0);
  expect(fresh).toEqual([]);
});
