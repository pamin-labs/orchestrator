import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { parseSync, traverse } from "@babel/core";

/**
 * A refusal the boss can act on says so in the boss's language.
 *
 * `bad()` bodies reach the panel through `mutate`'s toast, so they are read on
 * the panel and follow the interface language — the first row of ADR 035 §3.
 * The English goes out too, on the same descriptor, because a 422 body is also
 * read from a terminal and by whatever logs it.
 */
/**
 * Not every refusal gets one: `this server has no GitHub client` reports a
 * broken install rather than a value anybody can correct, and the third row
 * leaves those English. Which ones those are is the call site's to say and it
 * says it by name — `badEnglish("…")` — so there is no list here to drift from
 * the code. `bad()` takes a descriptor and nothing else, so a string handed to
 * it is a refusal somebody left untranslated by accident.
 */
const ROOT = `${process.cwd()}/src/api/panel`;

interface Refusals {
  /** `bad(msg`…`)` and `bad(descriptor)`: renders in the reader's language. */
  said: number;
  /** `badEnglish("…")`: deliberately not translated. */
  english: number;
  /** `bad("…")` and `bad(`…`)`: neither, which is the defect. */
  bare: string[];
}

function refusals(): Refusals {
  const out: Refusals = { said: 0, english: 0, bare: [] };
  for (const file of readdirSync(ROOT).filter((f) => f.endsWith(".ts"))) {
    const path = `${ROOT}/${file}`;
    const ast = parseSync(readFileSync(path, "utf8"), {
      filename: path,
      configFile: false,
      babelrc: false,
      parserOpts: { plugins: ["typescript"] },
    });
    if (!ast) continue;
    traverse(ast, {
      CallExpression(p) {
        const callee = p.node.callee;
        if (callee.type !== "Identifier") return;
        if (callee.name === "badEnglish") {
          out.english++;
          return;
        }
        if (callee.name !== "bad") return;
        const [reason] = p.node.arguments;
        // A literal is text written at the call site; anything else is a
        // descriptor, and `tsc` is what says it is the right shape.
        if (reason?.type === "StringLiteral" || reason?.type === "TemplateLiteral") {
          const text = reason.type === "StringLiteral" ? reason.value : "a template literal";
          out.bare.push(`${file}:${p.node.loc?.start.line}: ${text.slice(0, 60)}`);
          return;
        }
        out.said++;
      },
    });
  }
  return out;
}

test("every refusal a boss can act on names a message the panel can render", () => {
  const found = refusals();
  expect(found.bare).toEqual([]);
  // Not vacuous, and derived rather than counted out by hand: both doors have to
  // be in use, or this is a scan asserting about an empty list — which is how a
  // guard passes for years while what it guards rots.
  expect({ said: found.said > 0, english: found.english > 0 }).toEqual({ said: true, english: true });
});
