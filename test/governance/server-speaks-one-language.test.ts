import { expect, test } from "bun:test";
import { cjkHits, scan } from "../support/ast.ts";
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

/**
 * No exemption any more.
 *
 * A generated `messages.generated.ts` used to sit under `src/` holding nine
 * languages of catalog, so this ratchet would have read the fix as the defect.
 * The catalogues are `.po` files the server imports now, and `src/` is back to
 * being one language of source with nothing to carve out.
 */

/**
 * Parsed, not grepped, so a comment in Chinese is not a finding — and the walk
 * itself is `cjkHits`, shared with `panel-speaks-english.test.ts`. The two had a
 * copy each and drifted: `RegExpLiteral` is not a `StringLiteral`, a
 * `TemplateElement` or a `JSXText`, so the panel's copy could not see
 * `/(花钱|付费|采购|订阅|预算|密钥)/` until this one pointed it out.
 */
/**
 * Comments count, and they were 172 of the 265 this file found when that was
 * added. `AGENTS.md`'s first coding rule is English for comments — and by the
 * time the panel's source language was English, a comment naming `To do` or
 * `Cost` pointed at a label no longer in the source, so a reader searching for
 * one found nothing. Counted per comment rather than per line: a block that
 * wraps is one decision.
 */
const baseline = BASELINE as Record<string, number>;

/** `path` is repository-relative, as `scan` hands it over; the baseline is keyed
 *  from `src/` down, which is what the file reads as. */
const moved = (path: string, source: string): string[] => {
  const file = path.slice("src/".length);
  const now = cjkHits(path, source).length;
  const was = baseline[file] ?? 0;
  return now === was ? [] : [`${now > was ? "grew" : "shrank"} ${file}: ${was} → ${now}`];
};

/**
 * One walk, not two. A second test asked "may a file with no baseline entry
 * introduce one" — which `moved` already answers: `baseline[file] ?? 0` makes an
 * absent file `0 → N`, which is a `grew` row. It cost a second glob and a second
 * babel parse of every `.ts` under `src/` to assert nothing the first did not.
 */
test("no file under src grows its count of Chinese literals", () => {
  const changed = scan("src/**/*.ts", moved);
  const grew = changed.filter((line) => line.startsWith("grew "));
  const shrank = changed.filter((line) => line.startsWith("shrank "));
  // Growing is the failure this exists for: a new hardcoded sentence is one more
  // string a Korean reader will meet in Chinese.
  expect(grew).toEqual([]);
  // Shrinking is the work, and the baseline has to follow it down — or the file
  // it was fixed in silently reopens the same room it was closed out of.
  expect(shrank).toEqual([]);
});
