import { expect, test } from "bun:test";
import { traverse } from "@babel/core";
import { parse } from "../support/ast.ts";

/**
 * Nothing renders a sentence inside a template that is itself going to be
 * rendered.
 *
 * Not "do not call `renderSaid`" — that function is right, and the notify
 * webhook, the console and `/readyz` all need it. The defect is *where*: a value
 * inside a `msg` template is rendered by whoever renders the outer key, so a
 * fragment rendered here is frozen in one language while the sentence around it
 * is rendered in another. `contracts/said.ts` calls that "values, never text".
 */
/**
 * The line that is safe looks almost the same, and this must not fire on it.
 * Joining two *already rendered* strings is fine — nothing renders the result
 * again — which is why `api/panel/group.ts` builds its 200 toast that way and
 * `mech/ops/notify.ts` its webhook body. Putting a rendered sentence into a
 * descriptor's values is the unsafe one, because the outer descriptor is still
 * waiting to be rendered. So the judgement is the tag: a plain template literal
 * is a join, a `msg` template is a key.
 */
/**
 * Its own guard because the obvious grep cannot see it. Searching for a
 * prose-shaped value name finds `${{ why: st.why }}` and misses
 * `${{ why: renderSaid("en", st.why) }}`. This branch shipped it twice —
 * `mech/ops/watchdog.ts:548` first, then `composition/server.ts:506` while the
 * first one was being fixed.
 */
/** Parsed, not grepped: the call can wrap onto its own line, and an import can
 *  rename it — `renderSaid as render` defeats the grep and not this. Only `src`;
 *  the panel renders through `i18n._` and has no server renderer to reach for. */
const RENDERER = "renderSaid";
const MACROS = new Set(["msg", "t"]);

function offenders(file: string, source: string): string[] {
  const ast = parse(file, source);
  if (!ast) return [];

  // What this file calls it, which is not always what it is called.
  const local = new Set<string>();
  traverse(ast, {
    ImportSpecifier(p) {
      if (p.node.imported.type === "Identifier" && p.node.imported.name === RENDERER) local.add(p.node.local.name);
    },
  });
  if (local.size === 0) return [];

  const found: string[] = [];
  traverse(ast, {
    TaggedTemplateExpression(p) {
      if (p.node.tag.type !== "Identifier" || !MACROS.has(p.node.tag.name)) return;
      const tag = p.node.tag.name;
      p.traverse({
        CallExpression(c) {
          if (c.node.callee.type === "Identifier" && local.has(c.node.callee.name)) {
            found.push(`${file}:${c.node.loc?.start.line ?? 0} ${c.node.callee.name}() inside a ${tag}\` template`);
          }
        },
      });
    },
  });
  return found;
}

test("no sentence is rendered into a value of a template that is rendered again", async () => {
  const all: string[] = [];
  for (const file of new Bun.Glob("src/**/*.ts").scanSync(".")) {
    all.push(...offenders(file, await Bun.file(file).text()));
  }
  expect(all).toEqual([]);
});
