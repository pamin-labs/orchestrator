import { expect, test } from "bun:test";
import { traverse } from "@babel/core";
import { parse } from "../support/ast.ts";

/**
 * An event the panel draws names its sentence; it does not write one.
 *
 * `bus.emit` renders `say` into `body` and stores the descriptor beside it, so
 * the panel can draw the row in whichever of ten languages its reader chose.
 * An emitter that writes `body` directly skips that: the sentence is frozen in
 * the language the source file happens to be written in, and no catalogue can
 * reach it. Sixty-four emitters did exactly that after the first pass of this
 * work, which is why counting them is a test rather than a note.
 */
/**
 * What stays legal is a body that is *not* a sentence this repository wrote:
 * the boss's own words, an agent's tool summary, a commit message, a list of
 * paths. Those are data passing through, and translating them would be wrong.
 * So the judgement is the shape of the expression, not the property name —
 * `body: b.feedback` is data, `body: \`task ${id} done\`` is a sentence.
 */
/** Three letters in a row inside a literal part. `` `S${seq} ${verdict}` `` is a
 *  join of two values and carries none; `"paused"` carries one word and is a
 *  sentence all the same. */
const PROSE = /[A-Za-z]{3,}/;

function offenders(file: string, source: string): string[] {
  if (!source.includes(".emit(")) return [];
  const ast = parse(file, source);
  if (!ast) return [];

  const found: string[] = [];
  traverse(ast, {
    CallExpression(p) {
      const callee = p.node.callee;
      if (callee.type !== "MemberExpression") return;
      if (callee.property.type !== "Identifier" || callee.property.name !== "emit") return;
      const arg = p.node.arguments[0];
      if (arg?.type !== "ObjectExpression") return;

      const named = (name: string) =>
        arg.properties.find(
          (prop) => prop.type === "ObjectProperty" && prop.key.type === "Identifier" && prop.key.name === name,
        );
      // `say` in any form — a descriptor, a ternary over two, a call that
      // returns one. Its presence is the whole check; what it resolves to is
      // the type checker's business.
      if (named("say")) return;

      const body = named("body");
      if (body?.type !== "ObjectProperty") return;
      const value = body.value;
      const parts =
        value.type === "StringLiteral"
          ? [value.value]
          : value.type === "TemplateLiteral"
            ? value.quasis.map((q) => q.value.cooked ?? "")
            : [];
      if (parts.some((part) => PROSE.test(part))) {
        found.push(`${file}:${value.loc?.start.line ?? 0} writes a sentence instead of naming one`);
      }
    },
  });
  return found;
}

test("no emitter writes an English sentence the panel cannot translate", async () => {
  const all: string[] = [];
  for (const file of new Bun.Glob("src/**/*.ts").scanSync(".")) {
    all.push(...offenders(file, await Bun.file(file).text()));
  }
  expect(all).toEqual([]);
});

/**
 * Shown failing before it is kept, and shown not firing on the shape it must
 * not fire on — a guard that has only ever been green is evidence of nothing,
 * and one that is green because it matches nothing is worse.
 */
test("it fires on a written sentence and not on a body that is data", () => {
  const emit = (body: string) => `bus.emit({ grpId, author: "boss", kind: "state_change", ${body} });`;

  expect(offenders("probe.ts", emit("body: `task ${id} done`"))).toHaveLength(1);
  expect(offenders("probe.ts", emit('body: "paused"'))).toHaveLength(1);

  // The four legitimate shapes, all of which are somebody else's words.
  expect(offenders("probe.ts", emit("body: b.feedback"))).toEqual([]);
  expect(offenders("probe.ts", emit("body: note.slice(0, 1200)"))).toEqual([]);
  expect(offenders("probe.ts", emit('body: files.join(", ")'))).toEqual([]);
  expect(offenders("probe.ts", emit("say: SAID"))).toEqual([]);
  // A descriptor chosen between two, which is how half the emitters spell it.
  expect(offenders("probe.ts", emit("say: ok ? A : B, body: `still not merged`"))).toEqual([]);
});
